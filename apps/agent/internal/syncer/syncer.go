// Package syncer owns the users_ver -> Xray user set pipeline.
//
// The Worker advertises users_ver in every report response; a change wakes the
// syncer, which fetches GET /api/v1/agent/users with an If-None-Match built from
// the applied version. A new set is applied through HandlerService (hot update)
// and persisted as users.json plus a complete Xray config, so a restarted Xray
// reloads the same users from disk.
//
// Version semantics: KeyUsersVersion records the version whose set is fully
// converged on the node and is advanced only after every write succeeded, so a
// failed apply can never claim users the node does not serve. users.json records
// the set this agent last reconciled against; it is the local side of the diff and
// the recovery point after a restart.
package syncer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/zako-panel/zako-agent/internal/atomicfile"
	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/xrayapply"
	"github.com/zako-panel/zako-agent/internal/xrayconfig"
	"github.com/zako-panel/zako-agent/internal/xraycore"
)

const (
	// usersFileMode keeps the persisted credential set private: UUIDs are proxy
	// credentials, so only the agent may read the file.
	usersFileMode = 0o600
	// fallbackInterval bounds how long a trigger can be missed. The reporter fires
	// one per heartbeat, so this only covers a stalled reporter or a failed send.
	fallbackInterval = 10 * time.Minute
)

// ErrNoConfig marks a node whose static Xray config is absent. Hot updates and a
// persisted user set are both meaningless without it, so the syncer reports the
// condition instead of rendering a config from nothing.
var ErrNoConfig = errors.New("syncer: xray config file is missing")

// UsersVersion is meta.users_ver as exposed by the control plane. The Worker
// accepts its decimal form as the If-None-Match entity tag, so ETag is the only
// supported encoding; callers must not invent their own validator.
type UsersVersion int64

func (v UsersVersion) String() string {
	return strconv.FormatInt(int64(v), 10)
}

// ETag returns the quoted entity tag for If-None-Match. A matching tag yields
// HTTP 304 and no body.
func (v UsersVersion) ETag() string {
	return strconv.Quote(v.String())
}

// Fetcher pulls the versioned node user set. *reporter.Reporter implements it.
type Fetcher interface {
	FetchUsers(ctx context.Context, etag string) (*reporter.UsersResponse, bool, error)
}

// ConfigStore owns the node's Xray config document. *xrayconfig.ConfigFile
// implements it; tests substitute an in-memory document.
type ConfigStore interface {
	// Exists reports whether a static config is present.
	Exists() (bool, error)
	// Static returns the current document, which doubles as the render template.
	Static() ([]byte, error)
	// Render merges users and the local REALITY key into static.
	Render(static []byte, users []xraycore.User) ([]byte, error)
	// Write replaces the document atomically.
	Write(config []byte) error
}

// ConfigApplier validates a rendered document, swaps it in, restarts Xray and
// verifies that the API inbound answers, restoring the previous document when any
// step fails.
type ConfigApplier interface {
	Apply(ctx context.Context, config []byte) error
}

// The agent wires the production implementations; these assertions keep a changed
// method set from compiling silently into a node that never syncs.
var (
	_ Fetcher              = (*reporter.Reporter)(nil)
	_ ConfigStore          = xrayconfig.ConfigFile{}
	_ ConfigApplier        = (*xrayapply.ConfigApplier)(nil)
	_ xraycore.UserManager = (*xraycore.HandlerClient)(nil)
)

// Options assembles a Syncer. Every capability that touches the host is injected
// so the whole pipeline runs against fakes in tests.
type Options struct {
	Fetcher   Fetcher
	Users     xraycore.UserManager
	Store     *state.Store
	UsersPath string
	Config    ConfigStore
	Applier   ConfigApplier
	XrayMu    *sync.Mutex
	Logger    *slog.Logger
}

// Syncer applies versioned user sets.
type Syncer struct {
	fetcher   Fetcher
	users     xraycore.UserManager
	store     *state.Store
	usersPath string
	config    ConfigStore
	applier   ConfigApplier
	logger    *slog.Logger
	trigger   chan struct{}
	// mutex serializes the whole fetch-diff-apply cycle, shared with configsync
	// when provided so user updates and config restarts never race on Xray.
	mutex *sync.Mutex
}

// New validates dependencies. usersPath is where the applied user set is written
// with mode 0600 and atomically renamed into place.
func New(opts Options) (*Syncer, error) {
	if opts.Fetcher == nil {
		return nil, errors.New("syncer: user fetcher is required")
	}
	if opts.Users == nil {
		return nil, errors.New("syncer: xray user manager is required")
	}
	if opts.Store == nil {
		return nil, errors.New("syncer: state store is required")
	}
	if opts.UsersPath == "" {
		return nil, errors.New("syncer: users path is required")
	}
	if opts.Config == nil {
		return nil, errors.New("syncer: config store is required")
	}
	if opts.Applier == nil {
		return nil, errors.New("syncer: config applier is required")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	xrayMu := opts.XrayMu
	if xrayMu == nil {
		xrayMu = &sync.Mutex{}
	}
	return &Syncer{
		fetcher:   opts.Fetcher,
		users:     opts.Users,
		store:     opts.Store,
		usersPath: opts.UsersPath,
		config:    opts.Config,
		applier:   opts.Applier,
		logger:    logger,
		mutex:     xrayMu,
		// Capacity one collapses a burst of triggers into one pending sync while a
		// sync is running, without dropping the trigger entirely.
		trigger: make(chan struct{}, 1),
	}, nil
}

// Trigger requests a sync without blocking. It is safe to call from the reporting
// goroutine.
func (s *Syncer) Trigger() {
	if s == nil {
		return
	}
	select {
	case s.trigger <- struct{}{}:
	default:
	}
}

// Run syncs once, then waits for a trigger or the fallback ticker until ctx is
// canceled. A failed sync is logged and retried on the next trigger; the version
// stays where it was, so the gap remains visible in the heartbeat.
func (s *Syncer) Run(ctx context.Context) error {
	ticker := time.NewTicker(fallbackInterval)
	defer ticker.Stop()

	for {
		if err := s.SyncOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			s.logger.Warn("user sync failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-s.trigger:
		case <-ticker.C:
		}
	}
}

// SyncOnce converges the node onto the Worker's user set.
//
// Apply order: hot update, users.json, config file, version. The version is last
// so a failure in any earlier step leaves the previously applied version recorded
// and the next attempt re-derives the diff instead of skipping work.
func (s *Syncer) SyncOnce(ctx context.Context) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	// The config check runs before the fetch: a node without the static document
	// cannot apply anything, and a 304 would otherwise hide the gap because the
	// applied version still matches the Worker.
	exists, err := s.config.Exists()
	if err != nil {
		return fmt.Errorf("syncer: check xray config: %w", err)
	}
	if !exists {
		return ErrNoConfig
	}

	applied, found, err := s.store.MetaInt64(state.KeyUsersVersion)
	if err != nil {
		return fmt.Errorf("syncer: read applied users version: %w", err)
	}
	etag := ""
	if found && applied > 0 {
		etag = UsersVersion(applied).ETag()
	}

	response, notModified, err := s.fetcher.FetchUsers(ctx, etag)
	if err != nil {
		return fmt.Errorf("syncer: fetch users: %w", err)
	}
	if notModified {
		// The applied set is current. Re-applying it would rewrite identical bytes
		// and could duplicate users in the running Xray.
		return nil
	}
	if response.Version < applied {
		// A response older than the applied version is not newer truth; the Worker
		// never decrements users_ver.
		s.logger.Warn("ignoring stale user set",
			"response_version", response.Version, "applied_version", applied)
		return nil
	}

	static, err := s.config.Static()
	if err != nil {
		return err
	}
	rendered, err := s.render(static, response.Users)
	if err != nil {
		return err
	}

	stored, err := s.loadUsersFile()
	if err != nil {
		return err
	}
	diff := diffUsers(stored.Users, response.Users)

	switch {
	case !diff.empty():
		if err := s.hotUpdate(ctx, diff); err != nil {
			s.logger.Warn("hot update failed; converging by config restart", "error", err)
			return s.applyWithRestart(ctx, response.Users, response.Version, rendered)
		}
		return s.persistAndAdvance(response.Users, response.Version, static, rendered)
	case !bytes.Equal(static, rendered):
		// The stored set already matches the Worker while the disk config does not,
		// so an earlier attempt stopped between the two writes. The running Xray may
		// hold users that only existed in memory, and a restart is the only way to
		// make the process match the file.
		return s.applyWithRestart(ctx, response.Users, response.Version, rendered)
	default:
		// Nothing to change; only the recorded version can be behind, for example
		// when the state write failed after a successful apply.
		return s.advanceVersion(response.Version)
	}
}

// hotUpdate mutates the running inbound. Removals run first: a UUID change is a
// removal plus an addition, and Xray rejects an addition while the old account
// still occupies the email.
func (s *Syncer) hotUpdate(ctx context.Context, diff userDiff) error {
	for _, email := range diff.removed {
		if err := s.users.RemoveUser(ctx, email); err != nil {
			return fmt.Errorf("remove user %q: %w", email, err)
		}
	}
	for _, user := range diff.added {
		if err := s.users.AddUser(ctx, xraycore.User{
			Email: user.XrayEmail,
			UUID:  user.VlessUUID,
			Flow:  xraycore.FlowVision,
		}); err != nil {
			return fmt.Errorf("add user %q: %w", user.XrayEmail, err)
		}
	}
	return nil
}

// persistAndAdvance is the hot-update success path: the running Xray already holds
// the new set, so the disk artifacts are written without a restart.
func (s *Syncer) persistAndAdvance(users []reporter.User, version int64, static, rendered []byte) error {
	if err := s.writeUsersFile(users, version); err != nil {
		return err
	}
	if !bytes.Equal(static, rendered) {
		if err := s.config.Write(rendered); err != nil {
			return err
		}
	}
	return s.advanceVersion(version)
}

// applyWithRestart is the fallback: the in-memory user state is unknown or a hot
// update failed, so the config file is validated and swapped in and Xray restarted.
//
// users.json is written only after the restart succeeded. A failed attempt then
// leaves the previous set on disk, so the retry re-derives a non-empty diff and
// cannot conclude "nothing to do" while the running Xray is in an unknown state.
func (s *Syncer) applyWithRestart(ctx context.Context, users []reporter.User, version int64, rendered []byte) error {
	if err := s.applier.Apply(ctx, rendered); err != nil {
		return fmt.Errorf("syncer: apply users via config restart: %w", err)
	}
	if err := s.writeUsersFile(users, version); err != nil {
		return err
	}
	return s.advanceVersion(version)
}

func (s *Syncer) render(static []byte, users []reporter.User) ([]byte, error) {
	rendered, err := s.config.Render(static, toXrayUsers(users))
	if err != nil {
		return nil, fmt.Errorf("syncer: render xray config: %w", err)
	}
	return rendered, nil
}

// advanceVersion records the applied version last, so the node always reports the
// version it actually serves.
func (s *Syncer) advanceVersion(version int64) error {
	if err := s.store.SetMetaInt64(state.KeyUsersVersion, version); err != nil {
		return fmt.Errorf("syncer: record applied users version: %w", err)
	}
	s.logger.Info("user set applied", "users_version", version)
	return nil
}

// loadUsersFile returns the persisted applied set. A corrupt or absent file yields
// an empty set, so the next diff adds every user; a duplicate rejection then falls
// back to the restart path, which repairs both files.
func (s *Syncer) loadUsersFile() (reporter.UsersResponse, error) {
	data, err := os.ReadFile(s.usersPath)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return reporter.UsersResponse{}, nil
	default:
		return reporter.UsersResponse{}, fmt.Errorf("syncer: read %s: %w", s.usersPath, err)
	}

	var stored reporter.UsersResponse
	if err := json.Unmarshal(data, &stored); err != nil {
		s.logger.Warn("ignoring unreadable user set; it is rewritten by the next apply",
			"path", s.usersPath, "error", err)
		return reporter.UsersResponse{}, nil
	}
	return stored, nil
}

// writeUsersFile persists the applied set atomically. The parent directory is
// created if missing; the agent owns it after installation.
func (s *Syncer) writeUsersFile(users []reporter.User, version int64) error {
	encoded, err := json.MarshalIndent(reporter.UsersResponse{Version: version, Users: users}, "", "  ")
	if err != nil {
		return fmt.Errorf("syncer: encode user set: %w", err)
	}
	encoded = append(encoded, '\n')
	if err := atomicfile.Write(s.usersPath, encoded, usersFileMode); err != nil {
		return fmt.Errorf("syncer: write user set %s: %w", s.usersPath, err)
	}
	return nil
}

// userDiff is one converged step from the stored set to the target set. A changed
// UUID appears in both lists.
type userDiff struct {
	added   []reporter.User
	removed []string
}

func (d userDiff) empty() bool {
	return len(d.added) == 0 && len(d.removed) == 0
}

func diffUsers(applied, target []reporter.User) userDiff {
	appliedUUIDByEmail := make(map[string]string, len(applied))
	for _, user := range applied {
		appliedUUIDByEmail[user.XrayEmail] = user.VlessUUID
	}
	targetByEmail := make(map[string]reporter.User, len(target))
	targetUUIDByEmail := make(map[string]string, len(target))
	for _, user := range target {
		targetByEmail[user.XrayEmail] = user
		targetUUIDByEmail[user.XrayEmail] = user.VlessUUID
	}

	// Emails are visited in sorted order so the apply order, and therefore any
	// partial failure, is reproducible.
	var diff userDiff
	for _, email := range sortedEmails(appliedUUIDByEmail) {
		if targetUUIDByEmail[email] != appliedUUIDByEmail[email] {
			diff.removed = append(diff.removed, email)
		}
	}
	for _, email := range sortedEmails(targetUUIDByEmail) {
		if appliedUUIDByEmail[email] != targetUUIDByEmail[email] {
			diff.added = append(diff.added, targetByEmail[email])
		}
	}
	return diff
}

func sortedEmails(users map[string]string) []string {
	emails := make([]string, 0, len(users))
	for email := range users {
		emails = append(emails, email)
	}
	sort.Strings(emails)
	return emails
}

func toXrayUsers(users []reporter.User) []xraycore.User {
	converted := make([]xraycore.User, 0, len(users))
	for _, user := range users {
		converted = append(converted, xraycore.User{
			Email: user.XrayEmail,
			UUID:  user.VlessUUID,
			Flow:  xraycore.FlowVision,
		})
	}
	return converted
}
