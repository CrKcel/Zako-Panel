// Command zako-agent runs the node-side agent.
//
// The process samples StatsService, accumulates traffic deltas in BoltDB, reports
// heartbeats and traffic, and keeps the Xray user set in sync with the control
// plane through HandlerService with a restart fallback.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/zako-panel/zako-agent/internal/accounting"
	"github.com/zako-panel/zako-agent/internal/collector"
	"github.com/zako-panel/zako-agent/internal/config"
	"github.com/zako-panel/zako-agent/internal/configsync"
	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/syncer"
	"github.com/zako-panel/zako-agent/internal/sysinfo"
	"github.com/zako-panel/zako-agent/internal/xrayapply"
	"github.com/zako-panel/zako-agent/internal/xrayconfig"
	"github.com/zako-panel/zako-agent/internal/xraycore"
)

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "0.1.0"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("agent exited", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	configPath := flag.String("config", "/etc/zako-agent/config.yaml", "path to the agent configuration file")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("zako-agent %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return nil
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	logger = logger.With("node_id", cfg.NodeID, "agent_version", version)

	token, err := readToken(cfg.AgentTokenFile)
	if err != nil {
		return err
	}

	store, err := state.Open(cfg.StatePath)
	if err != nil {
		return err
	}
	defer func() {
		if err := store.Close(); err != nil {
			logger.Error("state close failed", "error", err)
		}
	}()

	usersVersion, _, err := store.MetaInt64(state.KeyUsersVersion)
	if err != nil {
		return err
	}
	desiredUsersVersion, _, err := store.MetaInt64(state.KeyDesiredUsersVersion)
	if err != nil {
		return err
	}
	appliedVersion, _, err := store.MetaInt64(state.KeyAppliedConfigVersion)
	if err != nil {
		return err
	}
	outboxPending, err := store.OutboxLen()
	if err != nil {
		return err
	}

	stats, err := xraycore.NewStatsClient(cfg.XrayAPIAddress)
	if err != nil {
		return err
	}
	defer func() {
		if err := stats.Close(); err != nil {
			logger.Error("xray stats client close failed", "error", err)
		}
	}()

	handler, err := xraycore.NewHandlerClient(cfg.XrayAPIAddress, cfg.XrayInboundTag)
	if err != nil {
		return err
	}
	defer func() {
		if err := handler.Close(); err != nil {
			logger.Error("xray handler client close failed", "error", err)
		}
	}()

	accountant, err := accounting.New(store, accounting.WithLogger(logger.With("component", "accounting")))
	if err != nil {
		return err
	}

	collectorLoop, err := collector.New(
		cfg.Collector.SampleInterval.Duration(),
		stats,
		accountant.Handle,
		logger.With("component", "collector"),
	)
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 30 * time.Second}
	reporterClient, err := reporter.New(cfg.ControlPlaneURL, token, client)
	if err != nil {
		return err
	}

	// The restart fallback needs a validated document, a restart and a health
	// check. The agent runs unprivileged; the shipped polkit rule lets its service
	// user restart xray.service only.
	applier, err := xrayapply.NewConfigApplier(xrayapply.ConfigApplierOptions{
		ConfigPath: cfg.XrayConfigPath,
		BinaryPath: cfg.XrayBinaryPath,
		Restarter:  xrayapply.SystemctlRestarter{Runner: xrayapply.ExecRunner{}},
		Runner:     xrayapply.ExecRunner{},
		Health:     xrayapply.StatsHealth{Stats: stats},
		Logger:     logger.With("component", "config-applier"),
	})
	if err != nil {
		return err
	}
	xrayConfigFile := xrayconfig.ConfigFile{
		Path:                  cfg.XrayConfigPath,
		RealityPrivateKeyPath: cfg.RealityPrivateKeyPath,
	}
	xrayMu := &sync.Mutex{}

	userSyncer, err := syncer.New(syncer.Options{
		Fetcher:   reporterClient,
		Users:     handler,
		Store:     store,
		UsersPath: cfg.UsersPath,
		Config:    xrayConfigFile,
		Applier:   applier,
		XrayMu:    xrayMu,
		Logger:    logger.With("component", "syncer"),
	})
	if err != nil {
		return err
	}

	configSyncer, err := configsync.New(configsync.Options{
		Client:    reporterClient,
		Store:     store,
		UsersPath: cfg.UsersPath,
		Config:    xrayConfigFile,
		Applier:   applier,
		XrayMu:    xrayMu,
		Logger:    logger.With("component", "config-syncer"),
	})
	if err != nil {
		return err
	}

	reporterLoop, err := reporter.NewLoop(reporter.LoopOptions{
		Client:            reporterClient,
		Store:             store,
		Reports:           accountant,
		Health:            collectorLoop,
		ReadSys:           sysinfo.Read,
		AgentVersion:      version,
		HeartbeatInterval: cfg.HeartbeatInterval.Duration(),
		TrafficInterval:   cfg.Collector.ReportInterval.Duration(),
		Logger:            logger.With("component", "reporter"),
		// A response carries the Worker's users_ver and desired_config_version.
		// It only wakes the syncers: the applied versions advance after the node
		// actually converged, which keeps a failed apply visible in the next heartbeat.
		OnResponse: func(*reporter.Response) {
			userSyncer.Trigger()
			configSyncer.Trigger()
		},
	})
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Info("agent started",
		"control_plane_url", cfg.ControlPlaneURL,
		"xray_api_address", cfg.XrayAPIAddress,
		"heartbeat_interval", cfg.HeartbeatInterval.String(),
		"sample_interval", cfg.Collector.SampleInterval.String(),
		"report_interval", cfg.Collector.ReportInterval.String(),
		"users_version", usersVersion,
		"desired_users_version", desiredUsersVersion,
		"applied_config_version", appliedVersion,
		"outbox_reports", outboxPending,
		"xray_inbound_tag", cfg.XrayInboundTag,
	)

	var loops sync.WaitGroup
	runLoop := func(name string, loop func(context.Context) error) {
		loops.Add(1)
		go func() {
			defer loops.Done()
			if err := loop(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Error("loop stopped", "loop", name, "error", err)
			}
		}()
	}
	runLoop("collector", collectorLoop.Run)
	runLoop("reporter", reporterLoop.Run)
	runLoop("syncer", userSyncer.Run)
	runLoop("config-syncer", configSyncer.Run)

	<-ctx.Done()
	logger.Info("shutdown requested")
	// Bolt writes are synchronous, so waiting for both loops drains the in-flight
	// sample transaction and the in-flight report before the store is closed.
	loops.Wait()
	logger.Info("agent stopped")
	return nil
}

// readToken trims the trailing newline commonly left by echo and rejects an empty
// file. The token value is never logged.
func readToken(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read agent token file: %w", err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", fmt.Errorf("agent token file %s is empty", path)
	}
	return token, nil
}
