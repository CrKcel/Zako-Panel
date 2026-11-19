package collector

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/zako-panel/zako-agent/internal/xraycore"
)

type fakeStats struct {
	mu       sync.Mutex
	users    []xraycore.UserCounters
	inbounds map[string]xraycore.ByteCounters
	uptime   int64
	err      error
}

func (f *fakeStats) UserTraffic(context.Context) ([]xraycore.UserCounters, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return f.users, nil
}

func (f *fakeStats) InboundTraffic(context.Context) (map[string]xraycore.ByteCounters, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return f.inbounds, nil
}

func (f *fakeStats) SysStats(context.Context) (xraycore.SystemStats, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return xraycore.SystemStats{}, f.err
	}
	return xraycore.SystemStats{UptimeSeconds: f.uptime}, nil
}

func (f *fakeStats) setError(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func newTestCollector(t *testing.T, stats xraycore.StatsReader, handle Handler) *Collector {
	t.Helper()
	collector, err := New(time.Minute, stats, handle, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return collector
}

func TestCollectorHealthTracksStatsService(t *testing.T) {
	stats := &fakeStats{
		users:    []xraycore.UserCounters{{Email: "alice@example.com", UplinkBytes: 1, DownlinkBytes: 2}},
		inbounds: map[string]xraycore.ByteCounters{"proxy": {UplinkBytes: 3, DownlinkBytes: 4}},
		uptime:   10,
	}
	var (
		mu       sync.Mutex
		recorded []Sample
	)
	collector := newTestCollector(t, stats, func(_ context.Context, sample Sample) error {
		mu.Lock()
		defer mu.Unlock()
		recorded = append(recorded, sample)
		return nil
	})

	if collector.Healthy() {
		t.Error("collector reports healthy before the first sample")
	}

	collector.runOnce(context.Background())
	if !collector.Healthy() {
		t.Error("collector still unhealthy after a successful sample")
	}
	mu.Lock()
	if len(recorded) != 1 {
		t.Fatalf("handler calls = %d, want 1", len(recorded))
	}
	sample := recorded[0]
	mu.Unlock()
	if sample.XrayUptimeSeconds != 10 || len(sample.Users) != 1 || sample.Inbounds["proxy"].UplinkBytes != 3 {
		t.Errorf("sample = %+v, want the StatsReader values", sample)
	}
	if sample.At.IsZero() {
		t.Error("sample timestamp is zero")
	}

	stats.setError(errors.New("stats down"))
	collector.runOnce(context.Background())
	if collector.Healthy() {
		t.Error("collector reports healthy after a StatsService failure")
	}
}

func TestHandlerFailureDoesNotMarkStatsUnhealthy(t *testing.T) {
	stats := &fakeStats{uptime: 1}
	collector := newTestCollector(t, stats, func(context.Context, Sample) error {
		return errors.New("bolt unavailable")
	})

	collector.runOnce(context.Background())
	if !collector.Healthy() {
		t.Error("a handler failure is not a StatsService failure")
	}
}

func TestNewCollectorValidatesDependencies(t *testing.T) {
	handle := func(context.Context, Sample) error { return nil }
	stats := &fakeStats{}
	if _, err := New(0, stats, handle, nil); err == nil {
		t.Error("New accepted a zero interval")
	}
	if _, err := New(time.Minute, nil, handle, nil); err == nil {
		t.Error("New accepted a nil stats reader")
	}
	if _, err := New(time.Minute, stats, nil, nil); err == nil {
		t.Error("New accepted a nil handler")
	}
}

func TestSampleOnceUpdatesHealthImmediately(t *testing.T) {
	stats := &fakeStats{uptime: 5}
	var samples int
	collector := newTestCollector(t, stats, func(context.Context, Sample) error {
		samples++
		return nil
	})

	if !collector.SampleOnce(context.Background()) {
		t.Fatal("SampleOnce() = false, want true when StatsReader succeeds")
	}
	if !collector.Healthy() {
		t.Error("Healthy() = false after SampleOnce succeeded")
	}
	if samples != 1 {
		t.Errorf("samples = %d, want 1", samples)
	}

	stats.setError(errors.New("xray starting"))
	if collector.SampleOnce(context.Background()) {
		t.Fatal("SampleOnce() = true, want false when StatsReader fails")
	}
	if collector.Healthy() {
		t.Error("Healthy() = true after SampleOnce failed")
	}
}
