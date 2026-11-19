// Package uninstall implements node-side agent uninstallation for both
// CLI-initiated (`zako-agent uninstall`) and panel-directive-triggered flows.
package uninstall

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/zako-panel/zako-agent/internal/config"
	"github.com/zako-panel/zako-agent/internal/reporter"
)

const (
	DefaultConfigPath        = "/etc/zako-agent/config.yaml"
	DefaultStateDir          = "/var/lib/zako-agent"
	DefaultBinaryPath        = "/usr/local/bin/zako-agent"
	DefaultUnitPath          = "/etc/systemd/system/zako-agent.service"
	DefaultUninstallUnitPath = "/etc/systemd/system/zako-agent-uninstall.service"
	DefaultUpdateUnitPath    = "/etc/systemd/system/zako-agent-update.service"
	DefaultPolkitRulePath    = "/etc/polkit-1/rules.d/50-zako-agent-xray.rules"
	DefaultXrayUnitPath      = "/etc/systemd/system/xray.service"
	DefaultXrayBinaryPath    = "/usr/local/bin/xray"
	DefaultXrayShareDir      = "/usr/local/share/xray"
	DefaultXrayConfigDir     = "/etc/xray"
	RemoveXrayMarkerName     = "uninstall-remove-xray"
	ServiceUser              = "zako-agent"
	ServiceGroup             = "zako-agent"
	UninstallUnitName        = "zako-agent-uninstall.service"
)

// Runner executes system commands (systemctl, userdel, groupdel).
type Runner interface {
	Run(ctx context.Context, name string, args ...string) error
}

// FS abstracts filesystem mutations for unit testing without root.
type FS interface {
	Remove(path string) error
	RemoveAll(path string) error
	Exists(path string) bool
	WriteFile(path string, data []byte, perm os.FileMode) error
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(output))
		if msg != "" {
			return fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, msg)
		}
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}

type osFS struct{}

func (osFS) Remove(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (osFS) RemoveAll(path string) error {
	return os.RemoveAll(path)
}

func (osFS) Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (osFS) WriteFile(path string, data []byte, perm os.FileMode) error {
	return os.WriteFile(path, data, perm)
}

// Options configures an uninstall execution.
type Options struct {
	ConfigPath string
	RemoveXray bool
	LocalOnly  bool
	Stdout     io.Writer
	Stderr     io.Writer
	Runner     Runner
	FS         FS
	Geteuid    func() int
	NotifyFunc func(ctx context.Context, configPath string) error
}

// RunCLI parses `zako-agent uninstall` flags and executes the uninstall.
func RunCLI(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	fs.SetOutput(stderr)

	configPath := fs.String("config", DefaultConfigPath, "path to the agent configuration file")
	removeXray := fs.Bool("remove-xray", false, "also stop and remove Xray-core and /etc/xray")
	localOnly := fs.Bool("local-only", false, "skip notifying the control plane before local cleanup")
	_ = fs.Bool("yes", true, "confirm uninstallation without prompting")
	_ = fs.Bool("y", true, "confirm uninstallation without prompting")

	if err := fs.Parse(args); err != nil {
		return err
	}

	return Run(ctx, Options{
		ConfigPath: *configPath,
		RemoveXray: *removeXray,
		LocalOnly:  *localOnly,
		Stdout:     stdout,
		Stderr:     stderr,
	})
}

// Run executes local (and optional control-plane) uninstallation.
func Run(ctx context.Context, opts Options) error {
	if opts.ConfigPath == "" {
		opts.ConfigPath = DefaultConfigPath
	}
	if opts.Stdout == nil {
		opts.Stdout = io.Discard
	}
	if opts.Stderr == nil {
		opts.Stderr = io.Discard
	}
	if opts.Runner == nil {
		opts.Runner = execRunner{}
	}
	if opts.FS == nil {
		opts.FS = osFS{}
	}
	if opts.Geteuid == nil {
		opts.Geteuid = os.Geteuid
	}
	if opts.NotifyFunc == nil {
		opts.NotifyFunc = notifyControlPlane
	}

	if opts.Geteuid() != 0 {
		return errors.New("uninstall must be run as root")
	}

	stateDir := DefaultStateDir
	if cfg, err := config.Load(opts.ConfigPath); err == nil && cfg.StatePath != "" {
		stateDir = filepath.Dir(cfg.StatePath)
	}

	if !opts.LocalOnly {
		notifyCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := opts.NotifyFunc(notifyCtx, opts.ConfigPath)
		cancel()
		if err != nil {
			fmt.Fprintf(opts.Stderr, "[zako-agent] warning: failed to notify control plane (%v); continuing local cleanup\n", err)
		} else {
			fmt.Fprintln(opts.Stdout, "[zako-agent] notified control plane of node uninstall")
		}
	}

	_ = opts.Runner.Run(ctx, "systemctl", "stop", "zako-agent.service")
	_ = opts.Runner.Run(ctx, "systemctl", "disable", "zako-agent.service")

	if opts.RemoveXray {
		_ = opts.Runner.Run(ctx, "systemctl", "stop", "xray.service")
		_ = opts.Runner.Run(ctx, "systemctl", "disable", "xray.service")
		for _, p := range []string{DefaultXrayUnitPath, DefaultXrayBinaryPath} {
			if err := opts.FS.Remove(p); err != nil {
				return fmt.Errorf("remove %s: %w", p, err)
			}
		}
		for _, dir := range []string{DefaultXrayShareDir, DefaultXrayConfigDir} {
			if err := opts.FS.RemoveAll(dir); err != nil {
				return fmt.Errorf("remove %s: %w", dir, err)
			}
		}
	}

	for _, p := range []string{DefaultUnitPath, DefaultUninstallUnitPath, DefaultUpdateUnitPath, DefaultPolkitRulePath, DefaultBinaryPath, DefaultBinaryPath + ".bak"} {
		if err := opts.FS.Remove(p); err != nil {
			return fmt.Errorf("remove %s: %w", p, err)
		}
	}

	configDir := filepath.Dir(opts.ConfigPath)
	for _, dir := range []string{configDir, stateDir} {
		if dir != "" && dir != "/" && dir != "." {
			if err := opts.FS.RemoveAll(dir); err != nil {
				return fmt.Errorf("remove %s: %w", dir, err)
			}
		}
	}

	_ = opts.Runner.Run(ctx, "systemctl", "daemon-reload")

	// Only remove the service user/group when xray.service is not left referencing SupplementaryGroups=zako-agent.
	if opts.RemoveXray || !opts.FS.Exists(DefaultXrayUnitPath) {
		_ = opts.Runner.Run(ctx, "userdel", ServiceUser)
		_ = opts.Runner.Run(ctx, "groupdel", ServiceGroup)
	}

	fmt.Fprintln(opts.Stdout, "[zako-agent] uninstall complete")
	return nil
}

func notifyControlPlane(ctx context.Context, configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	tokenBytes, err := os.ReadFile(cfg.AgentTokenFile)
	if err != nil {
		return err
	}
	token := strings.TrimSpace(string(tokenBytes))
	if token == "" {
		return errors.New("agent token file is empty")
	}
	rep, err := reporter.New(cfg.ControlPlaneURL, token, &http.Client{Timeout: 10 * time.Second})
	if err != nil {
		return err
	}
	return rep.NotifyUninstall(ctx, reporter.UninstallReasonNodeCLI)
}

// ParseUninstallDirective checks whether the report response directives include
// an uninstall command and extracts its remove_xray option.
func ParseUninstallDirective(directives []reporter.Directive) (triggered bool, removeXray bool) {
	for _, d := range directives {
		if d.Type != "uninstall" {
			continue
		}
		if raw, ok := d.Payload["remove_xray"]; ok {
			var v bool
			if err := json.Unmarshal(raw, &v); err == nil {
				removeXray = v
			}
		}
		return true, removeXray
	}
	return false, false
}

// TriggerFromDirective writes the optional remove-xray marker into the writable
// state directory and starts the root-owned uninstall oneshot unit via polkit.
func TriggerFromDirective(ctx context.Context, removeXray bool, stateDir string, runner Runner, fs FS) error {
	if stateDir == "" {
		stateDir = DefaultStateDir
	}
	if runner == nil {
		runner = execRunner{}
	}
	if fs == nil {
		fs = osFS{}
	}
	markerPath := filepath.Join(stateDir, RemoveXrayMarkerName)
	if removeXray {
		if err := fs.WriteFile(markerPath, []byte("1\n"), 0o600); err != nil {
			return fmt.Errorf("write uninstall marker: %w", err)
		}
	} else {
		_ = fs.Remove(markerPath)
	}
	if err := runner.Run(ctx, "systemctl", "start", "--no-block", UninstallUnitName); err != nil {
		return fmt.Errorf("start %s: %w", UninstallUnitName, err)
	}
	return nil
}
