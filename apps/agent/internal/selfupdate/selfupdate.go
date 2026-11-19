// Package selfupdate implements privileged-separated self-updating for zako-agent.
//
// The unprivileged agent downloads the release archive from the same origin as
// the control plane, verifies SHA256SUMS, extracts the binary to the state
// directory, runs a `--version` preflight, writes pending.json, and starts
// zako-agent-update.service via Polkit. The root-owned oneshot unit runs
// `zako-agent apply-update` to swap the binary atomically, restart the service,
// and automatically roll back to the .bak binary if health checks fail.
package selfupdate

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/zako-panel/zako-agent/internal/atomicfile"
	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/state"
)

const (
	DefaultStateDir       = "/var/lib/zako-agent"
	DefaultBinaryPath     = "/usr/local/bin/zako-agent"
	DefaultAgentUnitName  = "zako-agent.service"
	DefaultUpdateUnitName = "zako-agent-update.service"

	updateSubdir   = "update"
	stagedBinName  = "zako-agent.new"
	pendingFile    = "pending.json"
	resultFile     = "result.json"
	maxArchiveSize = 64 << 20 // 64 MiB
	maxSumsSize    = 1 << 20  // 1 MiB
)

// Runner executes system commands (systemctl, staged binary --version).
type Runner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(output))
		if msg != "" {
			return output, fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, msg)
		}
		return output, fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return output, nil
}

// Client reports self-update outcomes to the control plane.
type Client interface {
	ReportUpdateResult(ctx context.Context, result *reporter.UpdateResult) error
}

// PendingUpdate records a staged update awaiting privileged swap.
type PendingUpdate struct {
	TargetVersion string `json:"target_version"`
	FromVersion   string `json:"from_version"`
	StagedAt      int64  `json:"staged_at"`
}

// Options configures a selfupdate Manager.
type Options struct {
	BaseURL        string
	CurrentVersion string
	StateDir       string
	HTTPClient     *http.Client
	Client         Client
	Store          *state.Store
	Runner         Runner
	Logger         *slog.Logger
	GOOS           string
	GOARCH         string
	UpdateUnitName string
	SkipVersionRun bool
}

// Manager coordinates staging and reporting of agent self-updates.
type Manager struct {
	baseURL        *url.URL
	currentVersion string
	stateDir       string
	httpClient     *http.Client
	client         Client
	store          *state.Store
	runner         Runner
	logger         *slog.Logger
	goos           string
	goarch         string
	updateUnitName string
	skipVersionRun bool

	mu      sync.Mutex
	running bool
}

// NewManager constructs a self-update Manager.
func NewManager(opts Options) (*Manager, error) {
	parsed, err := url.Parse(strings.TrimSpace(opts.BaseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("selfupdate: invalid base URL %q", opts.BaseURL)
	}
	stateDir := opts.StateDir
	if stateDir == "" {
		stateDir = DefaultStateDir
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 2 * time.Minute}
	}
	runner := opts.Runner
	if runner == nil {
		runner = execRunner{}
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	goos := opts.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := opts.GOARCH
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	unitName := opts.UpdateUnitName
	if unitName == "" {
		unitName = DefaultUpdateUnitName
	}

	return &Manager{
		baseURL:        parsed,
		currentVersion: normalizeVersion(opts.CurrentVersion),
		stateDir:       stateDir,
		httpClient:     httpClient,
		client:         opts.Client,
		store:          opts.Store,
		runner:         runner,
		logger:         logger,
		goos:           goos,
		goarch:         goarch,
		updateUnitName: unitName,
		skipVersionRun: opts.SkipVersionRun,
	}, nil
}

// ParseSelfUpdateDirective checks heartbeat directives for a self_update request.
func ParseSelfUpdateDirective(directives []reporter.Directive) (string, bool) {
	for _, d := range directives {
		if d.Type != "self_update" || len(d.Payload) == 0 {
			continue
		}
		raw, ok := d.Payload["target_version"]
		if !ok {
			continue
		}
		var targetVersion string
		if err := json.Unmarshal(raw, &targetVersion); err != nil {
			continue
		}
		ver := normalizeVersion(targetVersion)
		if ver == "" {
			continue
		}
		return ver, true
	}
	return "", false
}

// Trigger starts an asynchronous self-update to targetVersion if one is not
// already in progress.
func (m *Manager) Trigger(ctx context.Context, targetVersion string) {
	ver := normalizeVersion(targetVersion)
	if ver == "" || ver == m.currentVersion {
		return
	}

	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return
	}
	m.running = true
	m.mu.Unlock()

	go func() {
		defer func() {
			m.mu.Lock()
			m.running = false
			m.mu.Unlock()
		}()
		if err := m.UpdateOnce(ctx, ver); err != nil {
			m.logger.Error("agent self-update failed", "target_version", ver, "error", err)
		}
	}()
}

// ReportPendingOutcome checks for a result.json written by apply-update, persists
// failed_agent_version on rollback/failure, reports the outcome to the control
// plane, and removes the marker file.
func (m *Manager) ReportPendingOutcome(ctx context.Context) error {
	resultPath := filepath.Join(m.updateDir(), resultFile)
	raw, err := os.ReadFile(resultPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read update result: %w", err)
	}

	var outcome reporter.UpdateResult
	if err := json.Unmarshal(raw, &outcome); err != nil {
		_ = os.Remove(resultPath)
		return fmt.Errorf("decode update result: %w", err)
	}

	if outcome.Status == reporter.ConfigStatusFailed && m.store != nil {
		if err := m.store.SetMetaString(state.KeyFailedAgentVersion, normalizeVersion(outcome.TargetVersion)); err != nil {
			m.logger.Warn("persist failed agent version failed", "error", err)
		}
	} else if outcome.Status == reporter.ConfigStatusApplied && m.store != nil {
		_ = m.store.SetMetaString(state.KeyFailedAgentVersion, "")
	}

	if m.client != nil {
		if err := m.client.ReportUpdateResult(ctx, &outcome); err != nil {
			return fmt.Errorf("report pending update result: %w", err)
		}
	}

	if err := os.Remove(resultPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		m.logger.Warn("remove update result marker failed", "error", err)
	}
	return nil
}

// UpdateOnce downloads, verifies, stages, and triggers the privileged update unit
// for targetVersion.
func (m *Manager) UpdateOnce(ctx context.Context, targetVersion string) error {
	ver := normalizeVersion(targetVersion)
	if ver == "" {
		return errors.New("selfupdate: target version is empty")
	}
	if ver == m.currentVersion {
		return nil
	}

	if m.store != nil {
		failedVer, found, err := m.store.MetaString(state.KeyFailedAgentVersion)
		if err != nil {
			return fmt.Errorf("read failed agent version: %w", err)
		}
		if found && failedVer == ver {
			return nil
		}
	}

	archiveName := fmt.Sprintf("zako-agent-%s-%s.tar.gz", m.goos, m.goarch)
	sumsBytes, err := m.fetchBytes(ctx, "/dl/agent/SHA256SUMS", maxSumsSize)
	if err != nil {
		return m.fail(ctx, ver, "UPDATE_DOWNLOAD_FAILED", err)
	}
	expectedHash, err := parseSHA256Sums(sumsBytes, archiveName)
	if err != nil {
		return m.fail(ctx, ver, "UPDATE_CHECKSUM_MISSING", err)
	}

	archiveBytes, err := m.fetchBytes(ctx, "/dl/agent/"+archiveName, maxArchiveSize)
	if err != nil {
		return m.fail(ctx, ver, "UPDATE_DOWNLOAD_FAILED", err)
	}

	sum := sha256.Sum256(archiveBytes)
	actualHash := hex.EncodeToString(sum[:])
	if !strings.EqualFold(actualHash, expectedHash) {
		return m.fail(ctx, ver, "UPDATE_HASH_MISMATCH", fmt.Errorf("sha256 mismatch for %s: got %s, want %s", archiveName, actualHash, expectedHash))
	}

	binBytes, err := extractAgentBinary(archiveBytes)
	if err != nil {
		return m.fail(ctx, ver, "UPDATE_EXTRACT_FAILED", err)
	}

	updateDir := m.updateDir()
	if err := os.MkdirAll(updateDir, 0o750); err != nil {
		return m.fail(ctx, ver, "UPDATE_STAGE_FAILED", err)
	}

	stagedPath := filepath.Join(updateDir, stagedBinName)
	if err := atomicfile.Write(stagedPath, binBytes, 0o755); err != nil {
		return m.fail(ctx, ver, "UPDATE_STAGE_FAILED", err)
	}

	if !m.skipVersionRun {
		out, err := m.runner.Run(ctx, stagedPath, "--version")
		if err != nil {
			return m.fail(ctx, ver, "UPDATE_PREFLIGHT_FAILED", err)
		}
		if !strings.Contains(string(out), ver) {
			return m.fail(ctx, ver, "UPDATE_VERSION_MISMATCH", fmt.Errorf("staged binary reported %q, want version %q", strings.TrimSpace(string(out)), ver))
		}
	}

	pending := PendingUpdate{
		TargetVersion: ver,
		FromVersion:   m.currentVersion,
		StagedAt:      time.Now().Unix(),
	}
	pendingRaw, err := json.Marshal(pending)
	if err != nil {
		return m.fail(ctx, ver, "UPDATE_STAGE_FAILED", err)
	}
	if err := atomicfile.Write(filepath.Join(updateDir, pendingFile), pendingRaw, 0o600); err != nil {
		return m.fail(ctx, ver, "UPDATE_STAGE_FAILED", err)
	}

	m.logger.Info("staged agent update; triggering privileged unit", "target_version", ver, "unit", m.updateUnitName)
	if _, err := m.runner.Run(ctx, "systemctl", "start", m.updateUnitName); err != nil {
		return m.fail(ctx, ver, "UPDATE_TRIGGER_FAILED", err)
	}
	return nil
}

func (m *Manager) fail(ctx context.Context, targetVersion, code string, cause error) error {
	if m.store != nil {
		if err := m.store.SetMetaString(state.KeyFailedAgentVersion, targetVersion); err != nil {
			m.logger.Warn("persist failed agent version failed", "error", err)
		}
	}
	if m.client != nil {
		result := &reporter.UpdateResult{
			TargetVersion: targetVersion,
			Status:        reporter.ConfigStatusFailed,
			ReportedAt:    time.Now().Unix(),
			Error: &reporter.ConfigError{
				Code:    code,
				Message: truncateError(cause.Error(), 512),
			},
		}
		if err := m.client.ReportUpdateResult(ctx, result); err != nil {
			m.logger.Warn("report update failure failed", "error", err)
		}
	}
	return cause
}

func (m *Manager) updateDir() string {
	return filepath.Join(m.stateDir, updateSubdir)
}

func (m *Manager) fetchBytes(ctx context.Context, path string, maxBytes int64) ([]byte, error) {
	u := m.baseURL.JoinPath(path).String()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GET %s returned status %d", path, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("GET %s exceeded max size %d bytes", path, maxBytes)
	}
	return data, nil
}

// ApplyOptions configures privileged binary replacement and rollback.
type ApplyOptions struct {
	StateDir          string
	BinaryPath        string
	AgentUnitName     string
	ObserveTimeout    time.Duration
	ObserveInterval   time.Duration
	SettleDelay       time.Duration
	Runner            Runner
	Geteuid           func() int
	RequireRoot       bool
	SkipVersionVerify bool
}

// RunApplyCLI parses `zako-agent apply-update` flags and applies a staged update.
func RunApplyCLI(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("apply-update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	stateDir := fs.String("state-dir", DefaultStateDir, "path to the agent state directory")
	binaryPath := fs.String("binary", DefaultBinaryPath, "path to the installed zako-agent binary")
	agentUnit := fs.String("unit", DefaultAgentUnitName, "systemd unit name to restart")
	if err := fs.Parse(args); err != nil {
		return err
	}

	return ApplyUpdate(ctx, ApplyOptions{
		StateDir:      *stateDir,
		BinaryPath:    *binaryPath,
		AgentUnitName: *agentUnit,
		RequireRoot:   true,
	})
}

// ApplyUpdate performs the privileged binary swap, restarts zako-agent.service,
// verifies health, and automatically rolls back to the .bak binary on failure.
func ApplyUpdate(ctx context.Context, opts ApplyOptions) error {
	if opts.RequireRoot {
		geteuid := opts.Geteuid
		if geteuid == nil {
			geteuid = os.Geteuid
		}
		if geteuid() != 0 {
			return errors.New("apply-update must be run as root")
		}
	}
	stateDir := opts.StateDir
	if stateDir == "" {
		stateDir = DefaultStateDir
	}
	binaryPath := opts.BinaryPath
	if binaryPath == "" {
		binaryPath = DefaultBinaryPath
	}
	agentUnit := opts.AgentUnitName
	if agentUnit == "" {
		agentUnit = DefaultAgentUnitName
	}
	observeTimeout := opts.ObserveTimeout
	if observeTimeout <= 0 {
		observeTimeout = 8 * time.Second
	}
	observeInterval := opts.ObserveInterval
	if observeInterval <= 0 {
		observeInterval = 500 * time.Millisecond
	}
	settleDelay := opts.SettleDelay
	if settleDelay == 0 {
		settleDelay = 2 * time.Second
	}
	runner := opts.Runner
	if runner == nil {
		runner = execRunner{}
	}

	updateDir := filepath.Join(stateDir, updateSubdir)
	pendingPath := filepath.Join(updateDir, pendingFile)
	stagedPath := filepath.Join(updateDir, stagedBinName)
	resultPath := filepath.Join(updateDir, resultFile)
	backupPath := binaryPath + ".bak"

	pendingRaw, err := os.ReadFile(pendingPath)
	if err != nil {
		return fmt.Errorf("read pending update: %w", err)
	}
	var pending PendingUpdate
	if err := json.Unmarshal(pendingRaw, &pending); err != nil {
		return fmt.Errorf("decode pending update: %w", err)
	}

	stagedBytes, err := os.ReadFile(stagedPath)
	if err != nil {
		return fmt.Errorf("read staged binary: %w", err)
	}
	if !opts.SkipVersionVerify {
		out, err := runner.Run(ctx, stagedPath, "--version")
		if err != nil {
			return fmt.Errorf("staged binary preflight failed: %w", err)
		}
		if !strings.Contains(string(out), pending.TargetVersion) {
			return fmt.Errorf("staged binary version mismatch: got %q, want %q", strings.TrimSpace(string(out)), pending.TargetVersion)
		}
	}

	currentBytes, err := os.ReadFile(binaryPath)
	if err != nil {
		return fmt.Errorf("read current binary %s: %w", binaryPath, err)
	}
	if err := atomicfile.Write(backupPath, currentBytes, 0o755); err != nil {
		return fmt.Errorf("backup current binary: %w", err)
	}
	if err := atomicfile.Write(binaryPath, stagedBytes, 0o755); err != nil {
		return fmt.Errorf("install staged binary: %w", err)
	}

	writeResult := func(status reporter.ConfigStatus, code, msg string) {
		res := reporter.UpdateResult{
			TargetVersion: pending.TargetVersion,
			Status:        status,
			ReportedAt:    time.Now().Unix(),
		}
		if code != "" {
			res.Error = &reporter.ConfigError{Code: code, Message: truncateError(msg, 512)}
		}
		if encoded, mErr := json.Marshal(res); mErr == nil {
			_ = atomicfile.Write(resultPath, encoded, 0o644)
		}
		_ = os.Remove(pendingPath)
		_ = os.Remove(stagedPath)
	}

	rollback := func(cause error) error {
		if restoreErr := atomicfile.Write(binaryPath, currentBytes, 0o755); restoreErr != nil {
			writeResult(reporter.ConfigStatusFailed, "UPDATE_ROLLBACK_FAILED", fmt.Sprintf("%v; restore failed: %v", cause, restoreErr))
			return fmt.Errorf("update failed (%w) and rollback failed: %v", cause, restoreErr)
		}
		if _, restartErr := runner.Run(ctx, "systemctl", "restart", agentUnit); restartErr != nil {
			writeResult(reporter.ConfigStatusFailed, "UPDATE_ROLLBACK_RESTART_FAILED", fmt.Sprintf("%v; rollback restart failed: %v", cause, restartErr))
			return fmt.Errorf("update failed (%w) and rollback restart failed: %v", cause, restartErr)
		}
		writeResult(reporter.ConfigStatusFailed, "UPDATE_ROLLED_BACK", cause.Error())
		return fmt.Errorf("update failed and rolled back to %s: %w", pending.FromVersion, cause)
	}

	if _, err := runner.Run(ctx, "systemctl", "restart", agentUnit); err != nil {
		return rollback(fmt.Errorf("restart %s: %w", agentUnit, err))
	}

	if settleDelay > 0 {
		select {
		case <-ctx.Done():
			return rollback(ctx.Err())
		case <-time.After(settleDelay):
		}
	}

	deadline := time.Now().Add(observeTimeout)
	for {
		if _, err := runner.Run(ctx, "systemctl", "is-active", "--quiet", agentUnit); err != nil {
			return rollback(fmt.Errorf("%s not active after restart: %w", agentUnit, err))
		}
		if time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return rollback(ctx.Err())
		case <-time.After(observeInterval):
		}
	}

	writeResult(reporter.ConfigStatusApplied, "", "")
	return nil
}

func parseSHA256Sums(data []byte, filename string) (string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		hash := fields[0]
		name := strings.TrimPrefix(fields[1], "*")
		if name == filename && len(hash) == 64 {
			return strings.ToLower(hash), nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("checksum entry for %s not found", filename)
}

func extractAgentBinary(archive []byte) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open gzip: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read tar: %w", err)
		}
		cleanName := filepath.Clean(hdr.Name)
		if strings.HasPrefix(cleanName, "..") || filepath.IsAbs(cleanName) {
			return nil, fmt.Errorf("unsafe tar path %q", hdr.Name)
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			return nil, fmt.Errorf("unexpected link entry %q in archive", hdr.Name)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		if filepath.Base(cleanName) != "zako-agent" {
			continue
		}
		if hdr.Size <= 0 || hdr.Size > maxArchiveSize {
			return nil, fmt.Errorf("invalid binary size %d", hdr.Size)
		}
		data, err := io.ReadAll(io.LimitReader(tr, maxArchiveSize+1))
		if err != nil {
			return nil, fmt.Errorf("extract binary: %w", err)
		}
		if int64(len(data)) > maxArchiveSize {
			return nil, errors.New("extracted binary exceeds max size")
		}
		return data, nil
	}
	return nil, errors.New("zako-agent binary not found in archive")
}

func normalizeVersion(raw string) string {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimPrefix(trimmed, "v")
	trimmed = strings.TrimPrefix(trimmed, "V")
	return trimmed
}

func truncateError(msg string, max int) string {
	if len(msg) <= max {
		return msg
	}
	return msg[:max]
}
