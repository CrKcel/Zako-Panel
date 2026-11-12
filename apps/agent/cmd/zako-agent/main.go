// Command zako-agent runs the node-side agent.
//
// The skeleton wires configuration, state, the control-plane client and the run
// loops. Xray transport, delta accounting and user sync are not implemented yet;
// those loops therefore report typed not-implemented errors or stay idle instead
// of pretending to have synchronized a node.
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

	"github.com/zako-panel/zako-agent/internal/collector"
	"github.com/zako-panel/zako-agent/internal/config"
	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/syncer"
	"github.com/zako-panel/zako-agent/internal/xray"
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
	configVersion, _, err := store.MetaInt64(state.KeyAppliedConfigVersion)
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 30 * time.Second}
	reporterClient, err := reporter.New(cfg.ControlPlaneURL, token, client)
	if err != nil {
		return err
	}

	// The loopback gRPC client is not implemented, so every Xray capability
	// returns xray.ErrNotImplemented. The agent must keep running without Xray.
	stats := xray.Unimplemented{}

	// Delta accounting (baselines, counter-gap flags, hourly splitting and outbox
	// writes) is not implemented. Samples are read and then rejected explicitly.
	sampleHandler := func(context.Context, collector.Sample) error {
		return collector.ErrNotImplemented
	}
	collectorLoop, err := collector.New(
		cfg.Collector.SampleInterval.Duration(),
		stats,
		sampleHandler,
		logger.With("component", "collector"),
	)
	if err != nil {
		return err
	}

	syncLoop, err := syncer.New(
		reporterClient,
		store,
		cfg.UsersPath,
		logger.With("component", "syncer"),
	)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Info("agent started",
		"control_plane_url", cfg.ControlPlaneURL,
		"heartbeat_interval", cfg.HeartbeatInterval.String(),
		"sample_interval", cfg.Collector.SampleInterval.String(),
		"report_interval", cfg.Collector.ReportInterval.String(),
		"users_version", usersVersion,
		"applied_config_version", configVersion,
	)
	// Heartbeat and outbox scheduling need the same delta accounting as the
	// collector plus ACK handling. Sending a report now would fabricate health and
	// version fields, so the reporter stays idle until that pipeline exists.
	logger.Info("reporter idle: heartbeat and outbox scheduling not implemented")

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
	runLoop("syncer", syncLoop.Run)

	<-ctx.Done()
	logger.Info("shutdown requested")
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
