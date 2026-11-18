// Package xrayapply converges a running Xray onto a validated config document.
//
// Apply is the fallback when the hot-update path fails: it validates the rendered
// document with `xray run -test`, replaces the file through the xrayconfig store,
// restarts the unit, checks the API inbound, and restores the previous document
// when validation, restart or health fails. Every host capability is injected so
// the whole rollback path is unit testable.
package xrayapply

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	"github.com/zako-panel/zako-agent/internal/xrayconfig"
	"github.com/zako-panel/zako-agent/internal/xraycore"
)

const (
	// defaultCommandTimeout bounds one fixed command. `xray run -test` parses the
	// whole document, so it gets a longer budget than a single RPC.
	defaultCommandTimeout = 60 * time.Second
	// defaultHealthAttempts and defaultHealthInterval give a restarted Xray about
	// ten seconds to open the API inbound before the apply is treated as failed.
	defaultHealthAttempts = 20
	defaultHealthInterval = 500 * time.Millisecond

	xrayUnit        = "xray.service"
	systemctlBinary = "systemctl"
)

// CommandRunner executes one fixed command. Implementations must not go through a
// shell and must not accept command text from a Worker payload.
type CommandRunner interface {
	Run(ctx context.Context, name string, args ...string) error
}

// Restarter restarts the Xray service. The agent runs as an unprivileged user; the
// shipped polkit rule lets that user manage this one unit.
type Restarter interface {
	Restart(ctx context.Context) error
}

// HealthChecker verifies that Xray answers on the loopback API inbound after a
// restart. A process that starts but cannot serve traffic must not count as
// applied.
type HealthChecker interface {
	Check(ctx context.Context) error
}

// ExecRunner runs commands with their absolute arguments and captures a bounded
// amount of output for the error, never the config itself.
type ExecRunner struct{}

// Run implements CommandRunner.
func (ExecRunner) Run(ctx context.Context, name string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...)
	output, err := command.CombinedOutput()
	if err == nil {
		return nil
	}
	const maxOutput = 2048
	trimmed := strings.TrimSpace(string(output))
	if len(trimmed) > maxOutput {
		trimmed = trimmed[len(trimmed)-maxOutput:]
	}
	if trimmed == "" {
		return fmt.Errorf("run %s: %w", name, err)
	}
	return fmt.Errorf("run %s: %w: %s", name, err, trimmed)
}

// SystemctlRestarter restarts the one unit the installation owns.
type SystemctlRestarter struct {
	Runner CommandRunner
}

// Restart implements Restarter.
func (r SystemctlRestarter) Restart(ctx context.Context) error {
	if r.Runner == nil {
		return errors.New("xray: systemctl restarter has no command runner")
	}
	return r.Runner.Run(ctx, systemctlBinary, "restart", xrayUnit)
}

// StatsHealth treats a successful SysStats call as proof that the restarted Xray
// opened its API inbound.
type StatsHealth struct {
	Stats xraycore.StatsReader
}

// Check implements HealthChecker.
func (h StatsHealth) Check(ctx context.Context) error {
	if h.Stats == nil {
		return errors.New("xray: stats health check has no stats reader")
	}
	if _, err := h.Stats.SysStats(ctx); err != nil {
		return fmt.Errorf("xray: system stats health check: %w", err)
	}
	return nil
}

// ConfigApplierOptions assembles a ConfigApplier. All capabilities that touch the
// host are injected so the rollback path is unit testable.
type ConfigApplierOptions struct {
	ConfigPath string
	BinaryPath string
	Runner     CommandRunner
	Restarter  Restarter
	Health     HealthChecker
	Logger     *slog.Logger
	Sleep      func(ctx context.Context, delay time.Duration) error
	// HealthAttempts and HealthInterval override the defaults; tests use them to
	// avoid wall-clock waits.
	HealthAttempts int
	HealthInterval time.Duration
	CommandTimeout time.Duration
}

// ConfigApplier converges Xray onto a rendered config file. It is the fallback
// when a handler update fails: validate, replace, restart, health check, and
// restore the previous file when any step fails.
type ConfigApplier struct {
	store          xrayconfig.ConfigStore
	binaryPath     string
	runner         CommandRunner
	restarter      Restarter
	health         HealthChecker
	logger         *slog.Logger
	sleep          func(ctx context.Context, delay time.Duration) error
	healthAttempts int
	healthInterval time.Duration
	commandTimeout time.Duration
}

// NewConfigApplier validates dependencies and applies defaults.
func NewConfigApplier(opts ConfigApplierOptions) (*ConfigApplier, error) {
	if strings.TrimSpace(opts.ConfigPath) == "" {
		return nil, errors.New("xray: config path is required")
	}
	if strings.TrimSpace(opts.BinaryPath) == "" {
		return nil, errors.New("xray: xray binary path is required")
	}
	if opts.Health == nil {
		return nil, errors.New("xray: health checker is required")
	}
	store, err := xrayconfig.NewConfigStore(opts.ConfigPath)
	if err != nil {
		return nil, err
	}

	runner := opts.Runner
	if runner == nil {
		runner = ExecRunner{}
	}
	restarter := opts.Restarter
	if restarter == nil {
		restarter = SystemctlRestarter{Runner: runner}
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	sleep := opts.Sleep
	if sleep == nil {
		sleep = sleepContext
	}
	attempts := opts.HealthAttempts
	if attempts <= 0 {
		attempts = defaultHealthAttempts
	}
	interval := opts.HealthInterval
	if interval <= 0 {
		interval = defaultHealthInterval
	}
	timeout := opts.CommandTimeout
	if timeout <= 0 {
		timeout = defaultCommandTimeout
	}

	return &ConfigApplier{
		store:          store,
		binaryPath:     opts.BinaryPath,
		runner:         runner,
		restarter:      restarter,
		health:         opts.Health,
		logger:         logger,
		sleep:          sleep,
		healthAttempts: attempts,
		healthInterval: interval,
		commandTimeout: timeout,
	}, nil
}

// Apply validates config, replaces the file, restarts Xray and waits for the API
// inbound to answer. A failure after the file was replaced restores the previous
// document and restarts once more; the original error is returned either way
// because the new user set is not running.
func (a *ConfigApplier) Apply(ctx context.Context, config []byte) error {
	if len(config) == 0 {
		return errors.New("xray: apply config: document is empty")
	}
	previous, hadPrevious, err := a.currentConfig()
	if err != nil {
		return err
	}

	// Validation must not change the live file: a config the binary rejects is a
	// bug in the renderer or in the node's static config, not a reason to stop a
	// serving Xray.
	if err := a.validate(ctx, config); err != nil {
		return fmt.Errorf("xray: config was not applied: %w", err)
	}
	if err := a.store.Write(config); err != nil {
		return err
	}

	restartErr := a.restartAndCheck(ctx)
	if restartErr == nil {
		return nil
	}
	applyErr := fmt.Errorf("xray: config apply failed: %w", restartErr)

	if !hadPrevious {
		if removeErr := a.store.Remove(); removeErr != nil {
			return errors.Join(applyErr, fmt.Errorf("xray: remove failed config: %w", removeErr))
		}
		return applyErr
	}

	if restoreErr := a.store.Write(previous); restoreErr != nil {
		return errors.Join(applyErr, fmt.Errorf("xray: restore previous config: %w", restoreErr))
	}
	a.logger.Warn("xray config apply failed; previous config restored", "error", restartErr)
	if restoreErr := a.restart(ctx); restoreErr != nil {
		return errors.Join(applyErr, fmt.Errorf("xray: restart with previous config: %w", restoreErr))
	}
	return fmt.Errorf("%w (previous config restored)", applyErr)
}

func (a *ConfigApplier) validate(ctx context.Context, config []byte) error {
	probe, cleanup, err := a.store.WriteProbe(config)
	if err != nil {
		return err
	}
	defer cleanup()
	return a.run(ctx, a.binaryPath, "run", "-test", "-config", probe)
}

func (a *ConfigApplier) restartAndCheck(ctx context.Context) error {
	if err := a.restart(ctx); err != nil {
		return err
	}
	var lastErr error
	for attempt := 1; attempt <= a.healthAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		callCtx, cancel := context.WithTimeout(ctx, a.commandTimeout)
		lastErr = a.health.Check(callCtx)
		cancel()
		if lastErr == nil {
			return nil
		}
		if attempt == a.healthAttempts {
			break
		}
		if err := a.sleep(ctx, a.healthInterval); err != nil {
			return err
		}
	}
	return fmt.Errorf("xray: health check after restart: %w", lastErr)
}

func (a *ConfigApplier) restart(ctx context.Context) error {
	callCtx, cancel := context.WithTimeout(ctx, a.commandTimeout)
	defer cancel()
	if err := a.restarter.Restart(callCtx); err != nil {
		return fmt.Errorf("xray: restart %s: %w", xrayUnit, err)
	}
	return nil
}

func (a *ConfigApplier) run(ctx context.Context, name string, args ...string) error {
	callCtx, cancel := context.WithTimeout(ctx, a.commandTimeout)
	defer cancel()
	return a.runner.Run(callCtx, name, args...)
}

func (a *ConfigApplier) currentConfig() ([]byte, bool, error) {
	data, err := a.store.Read()
	switch {
	case err == nil:
		return data, true, nil
	case errors.Is(err, fs.ErrNotExist):
		return nil, false, nil
	default:
		return nil, false, err
	}
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
