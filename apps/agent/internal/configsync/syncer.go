// Package configsync owns the desired_config_version -> Xray config pipeline.
//
// The Worker advertises desired_config_version in every report response; a
// difference from the applied (and not-previously-failed) version wakes the
// syncer, which fetches GET /api/v1/agent/config, verifies its SHA-256 digest,
// merges local users.json and REALITY privateKey, validates with `xray run -test`,
// swaps config.json atomically and restarts Xray, then reports the outcome via
// POST /api/v1/agent/config/result.
package configsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/xrayconfig"
	"github.com/zako-panel/zako-agent/internal/xraycore"
)

const (
	fallbackInterval   = 10 * time.Minute
	maxErrorMessageLen = 512
)

// Client fetches desired configuration and reports apply outcomes.
// *reporter.Reporter implements it.
type Client interface {
	FetchConfig(ctx context.Context) (*reporter.AgentConfig, bool, error)
	ReportConfigResult(ctx context.Context, result *reporter.ConfigResult) error
}

// ConfigRenderer merges users and the local REALITY private key into a static
// configuration definition. xrayconfig.ConfigFile implements it.
type ConfigRenderer interface {
	Render(static []byte, users []xraycore.User) ([]byte, error)
}

// ConfigApplier validates a rendered document, swaps it in, restarts Xray and
// verifies that the API inbound answers, restoring the previous document on failure.
type ConfigApplier interface {
	Apply(ctx context.Context, config []byte) error
}

// Options assembles a Syncer.
type Options struct {
	Client    Client
	Store     *state.Store
	UsersPath string
	Config    ConfigRenderer
	Applier   ConfigApplier
	XrayMu    *sync.Mutex
	Logger    *slog.Logger
	Clock     func() time.Time
}

// Syncer applies versioned remote Xray configuration definitions.
type Syncer struct {
	client    Client
	store     *state.Store
	usersPath string
	config    ConfigRenderer
	applier   ConfigApplier
	xrayMu    *sync.Mutex
	logger    *slog.Logger
	clock     func() time.Time
	trigger   chan struct{}
}

// New validates dependencies and creates a Syncer.
func New(opts Options) (*Syncer, error) {
	if opts.Client == nil {
		return nil, errors.New("configsync: client is required")
	}
	if opts.Store == nil {
		return nil, errors.New("configsync: state store is required")
	}
	if strings.TrimSpace(opts.UsersPath) == "" {
		return nil, errors.New("configsync: users path is required")
	}
	if opts.Config == nil {
		return nil, errors.New("configsync: config renderer is required")
	}
	if opts.Applier == nil {
		return nil, errors.New("configsync: config applier is required")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	clock := opts.Clock
	if clock == nil {
		clock = time.Now
	}

	return &Syncer{
		client:    opts.Client,
		store:     opts.Store,
		usersPath: opts.UsersPath,
		config:    opts.Config,
		applier:   opts.Applier,
		xrayMu:    opts.XrayMu,
		logger:    logger,
		clock:     clock,
		trigger:   make(chan struct{}, 1),
	}, nil
}

// Trigger wakes the sync loop without blocking.
func (s *Syncer) Trigger() {
	select {
	case s.trigger <- struct{}{}:
	default:
	}
}

// Run executes SyncOnce when triggered or on the fallback interval until ctx ends.
func (s *Syncer) Run(ctx context.Context) error {
	ticker := time.NewTicker(fallbackInterval)
	defer ticker.Stop()

	// Run once on startup in case a pending desired version was persisted before restart.
	if err := s.SyncOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
		s.logger.Warn("initial config sync failed", "error", err)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-s.trigger:
		case <-ticker.C:
		}

		if err := s.SyncOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			s.logger.Warn("config sync failed", "error", err)
		}
	}
}

// SyncOnce checks whether desired_config_version differs from applied/failed and
// applies the new configuration if needed.
func (s *Syncer) SyncOnce(ctx context.Context) error {
	desired, _, err := s.store.MetaInt64(state.KeyDesiredConfigVersion)
	if err != nil {
		return err
	}
	applied, _, err := s.store.MetaInt64(state.KeyAppliedConfigVersion)
	if err != nil {
		return err
	}
	failed, _, err := s.store.MetaInt64(state.KeyFailedConfigVersion)
	if err != nil {
		return err
	}

	if desired <= 0 || desired == applied || desired == failed {
		return nil
	}

	if s.xrayMu != nil {
		s.xrayMu.Lock()
		defer s.xrayMu.Unlock()
	}

	cfg, hasConfig, err := s.client.FetchConfig(ctx)
	if err != nil {
		return err
	}
	if !hasConfig || cfg == nil {
		return nil
	}

	// Re-check against the fetched version in case a newer version was published.
	if cfg.Version == applied || cfg.Version == failed {
		return nil
	}

	actualHash, err := canonicalSHA256(cfg.Definition)
	if err != nil {
		return s.failVersion(ctx, cfg.Version, "CONFIG_INVALID_JSON", err)
	}
	if !strings.EqualFold(actualHash, strings.TrimSpace(cfg.DefinitionSHA256)) {
		return s.failVersion(ctx, cfg.Version, "CONFIG_HASH_MISMATCH", fmt.Errorf("sha256 mismatch: got %s, want %s", actualHash, cfg.DefinitionSHA256))
	}

	users, err := readLocalUsers(s.usersPath)
	if err != nil {
		return s.failVersion(ctx, cfg.Version, "CONFIG_READ_USERS_FAILED", err)
	}

	rendered, err := s.config.Render(cfg.Definition, users)
	if err != nil {
		return s.failVersion(ctx, cfg.Version, "CONFIG_RENDER_FAILED", err)
	}

	if err := s.applier.Apply(ctx, rendered); err != nil {
		return s.failVersion(ctx, cfg.Version, "CONFIG_APPLY_FAILED", err)
	}

	if err := s.store.SetMetaInt64(state.KeyAppliedConfigVersion, cfg.Version); err != nil {
		return fmt.Errorf("persist applied config version: %w", err)
	}
	if err := s.store.SetMetaInt64(state.KeyFailedConfigVersion, 0); err != nil {
		return fmt.Errorf("clear failed config version: %w", err)
	}

	s.logger.Info("remote config applied", "version", cfg.Version)

	result := &reporter.ConfigResult{
		Version:   cfg.Version,
		Status:    reporter.ConfigStatusApplied,
		AppliedAt: s.clock().Unix(),
		Error:     nil,
	}
	if err := s.client.ReportConfigResult(ctx, result); err != nil {
		// Applied version is already persisted and will also travel in heartbeats.
		s.logger.Warn("report applied config result failed", "version", cfg.Version, "error", err)
	}
	return nil
}

func (s *Syncer) failVersion(ctx context.Context, version int64, code string, cause error) error {
	if err := s.store.SetMetaInt64(state.KeyFailedConfigVersion, version); err != nil {
		s.logger.Warn("persist failed config version failed", "version", version, "error", err)
	}

	msg := strings.TrimSpace(cause.Error())
	if len(msg) > maxErrorMessageLen {
		msg = msg[:maxErrorMessageLen]
	}

	result := &reporter.ConfigResult{
		Version:   version,
		Status:    reporter.ConfigStatusFailed,
		AppliedAt: s.clock().Unix(),
		Error: &reporter.ConfigError{
			Code:    code,
			Message: msg,
		},
	}
	if err := s.client.ReportConfigResult(ctx, result); err != nil {
		s.logger.Warn("report failed config result failed", "version", version, "error", err)
	}
	return fmt.Errorf("%s: %w", code, cause)
}

func readLocalUsers(path string) ([]xraycore.User, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read users %s: %w", path, err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil, nil
	}
	var stored reporter.UsersResponse
	if err := json.Unmarshal(data, &stored); err != nil {
		return nil, fmt.Errorf("decode users %s: %w", path, err)
	}
	users := make([]xraycore.User, 0, len(stored.Users))
	for _, u := range stored.Users {
		users = append(users, xraycore.User{
			Email: u.XrayEmail,
			UUID:  u.VlessUUID,
			Flow:  xraycore.FlowVision,
		})
	}
	return users, nil
}

var (
	_ ConfigRenderer = xrayconfig.ConfigFile{}
)
