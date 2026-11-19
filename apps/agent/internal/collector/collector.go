// Package collector samples cumulative Xray counters at the configured cadence.
//
// Converting raw counters into report deltas is intentionally outside this
// package. Baseline comparison, counter-gap detection, hourly bucket splitting
// and outbox persistence happen behind the Handler boundary so the sampler stays
// independent of BoltDB and the report contract.
package collector

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zako-panel/zako-agent/internal/xraycore"
)

// Sample is one read of all counters at a single instant. Counters are cumulative
// for the lifetime of the Xray process.
type Sample struct {
	At                time.Time
	Users             []xraycore.UserCounters
	Inbounds          map[string]xraycore.ByteCounters
	XrayUptimeSeconds int64
}

// Handler consumes a raw sample. It owns persistence and reporting decisions;
// returning an error affects only that sample, not the sampling loop.
type Handler func(ctx context.Context, sample Sample) error

// Collector polls a StatsReader. Sampling and handling are serialized, so a slow
// handler delays the next sample rather than overlapping writes.
type Collector struct {
	interval time.Duration
	stats    xraycore.StatsReader
	handle   Handler
	logger   *slog.Logger
	mu       sync.Mutex
	healthy  atomic.Bool
}

// New validates the sampling cadence and dependencies.
func New(interval time.Duration, stats xraycore.StatsReader, handle Handler, logger *slog.Logger) (*Collector, error) {
	if interval <= 0 {
		return nil, fmt.Errorf("collector: sample interval must be positive, got %s", interval)
	}
	if stats == nil {
		return nil, errors.New("collector: stats reader is required")
	}
	if handle == nil {
		return nil, errors.New("collector: sample handler is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Collector{interval: interval, stats: stats, handle: handle, logger: logger}, nil
}

// Run samples once per interval until ctx is canceled, then returns nil. The
// first sample happens after one full interval, matching the configured cadence.
// A source failure is logged and the next tick proceeds; it never terminates the
// process, because a transient StatsService outage must not take the agent down.
func (c *Collector) Run(ctx context.Context) error {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			c.runOnce(ctx)
		}
	}
}

// Healthy reports whether the last StatsService sample succeeded. Before the
// first sample the node is reported as unhealthy rather than assumed healthy.
func (c *Collector) Healthy() bool {
	return c.healthy.Load()
}

// SampleOnce runs one sample immediately and returns whether the StatsService
// read succeeded.
func (c *Collector) SampleOnce(ctx context.Context) bool {
	c.runOnce(ctx)
	return c.Healthy()
}

// runOnce samples and handles once. Health reflects the StatsService read only: a
// handler failure is a local accounting problem, not a dead Xray.
func (c *Collector) runOnce(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()

	sample, err := c.sample(ctx)
	if err != nil {
		// The reporter turns this into stats_healthy=false on the next heartbeat.
		// A transient StatsService outage must not terminate the agent.
		c.healthy.Store(false)
		c.logger.Warn("collector sample failed", "error", err)
		return
	}
	c.healthy.Store(true)
	if err := c.handle(ctx, sample); err != nil {
		c.logger.Warn("collector sample handler failed", "error", err)
	}
}

func (c *Collector) sample(ctx context.Context) (Sample, error) {
	users, err := c.stats.UserTraffic(ctx)
	if err != nil {
		return Sample{}, fmt.Errorf("collector: read user traffic: %w", err)
	}
	inbounds, err := c.stats.InboundTraffic(ctx)
	if err != nil {
		return Sample{}, fmt.Errorf("collector: read inbound traffic: %w", err)
	}
	system, err := c.stats.SysStats(ctx)
	if err != nil {
		return Sample{}, fmt.Errorf("collector: read system stats: %w", err)
	}

	// The three reads are not a single transaction: Xray exposes them as separate
	// RPCs. Delta accounting therefore treats the sample timestamp as the period
	// boundary and flags gaps when a counter moves backwards.
	return Sample{
		At:                time.Now(),
		Users:             users,
		Inbounds:          inbounds,
		XrayUptimeSeconds: system.UptimeSeconds,
	}, nil
}
