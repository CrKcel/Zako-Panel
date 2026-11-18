package reporter

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/sysinfo"
	bolt "go.etcd.io/bbolt"
)

type fakeClock struct {
	now time.Time
}

func (c *fakeClock) Now() time.Time          { return c.now }
func (c *fakeClock) Advance(d time.Duration) { c.now = c.now.Add(d) }

type fakeHealth struct {
	healthy bool
}

func (h *fakeHealth) Healthy() bool { return h.healthy }

type fakeReports struct {
	closeCalls int
	dropCalls  int
	closed     int
	dropped    int
	closeErr   error
	onClose    func()
	onDrop     func()
}

func (f *fakeReports) CloseReports() (int, error) {
	f.closeCalls++
	if f.onClose != nil {
		f.onClose()
	}
	return f.closed, f.closeErr
}

func (f *fakeReports) DropExpired(time.Time) (int, error) {
	f.dropCalls++
	if f.onDrop != nil {
		f.onDrop()
	}
	return f.dropped, f.closeErr
}

type controlPlane struct {
	mu      sync.Mutex
	reports []Report
	respond func(index int, report *Report, w http.ResponseWriter)
}

func (c *controlPlane) record(report Report) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reports = append(c.reports, report)
}

func (c *controlPlane) requests() []Report {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Report(nil), c.reports...)
}

func newControlPlane(t *testing.T) (*controlPlane, *Reporter) {
	t.Helper()
	cp := &controlPlane{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if got, want := request.URL.Path, reportPath; got != want {
			t.Errorf("request path = %q, want %q", got, want)
		}
		if got, want := request.Header.Get("Authorization"), "Bearer node-1.secret"; got != want {
			t.Errorf("authorization = %q, want %q", got, want)
		}
		var report Report
		if err := json.NewDecoder(request.Body).Decode(&report); err != nil {
			t.Errorf("decode report: %v", err)
		}
		cp.record(report)

		cp.mu.Lock()
		index := len(cp.reports) - 1
		respond := cp.respond
		cp.mu.Unlock()
		if respond == nil {
			writeSuccess(w, report.Traffic, 300, 900, 13, 3)
			return
		}
		respond(index, &report, w)
	}))
	t.Cleanup(server.Close)

	client := server.Client()
	client.Timeout = 10 * time.Second
	reporter, err := New(server.URL, "node-1.secret", client)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return cp, reporter
}

func writeSuccess(w http.ResponseWriter, traffic *Traffic, heartbeatSeconds, trafficSeconds int, usersVer, desired int64) {
	ack := any(nil)
	if traffic != nil {
		ack = traffic.ReportID
	}
	writeEnvelope(w, http.StatusOK, map[string]any{
		"ack_report_id":              ack,
		"server_time":                time.Now().Unix(),
		"heartbeat_interval_seconds": heartbeatSeconds,
		"traffic_interval_seconds":   trafficSeconds,
		"users_ver":                  usersVer,
		"desired_config_version":     desired,
		"unknown_users":              0,
		"directives":                 []any{},
	})
}

func writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": code, "request_id": "req-1"},
	})
}

func writeEnvelope(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"data": data,
		"meta": map[string]string{"request_id": "req-1"},
	})
}

func openTestStore(t *testing.T) *state.Store {
	t.Helper()
	store, err := state.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func seedOutbox(t *testing.T, store *state.Store, reportID string) state.TrafficReport {
	t.Helper()
	report := state.TrafficReport{
		ReportID:      reportID,
		PeriodStart:   1_780_000_000 / 3600 * 3600,
		PeriodEnd:     1_780_000_000/3600*3600 + 3600,
		HasCounterGap: false,
		UplinkBytes:   3,
		DownlinkBytes: 4,
		Users: []state.ReportUser{
			{Email: "alice@example.com", UplinkBytes: 1, DownlinkBytes: 2},
		},
	}
	if err := store.Update(func(tx *bolt.Tx) error {
		return state.PutOutboxReport(tx, report)
	}); err != nil {
		t.Fatalf("seed outbox: %v", err)
	}
	return report
}

type loopFixture struct {
	loop    *Loop
	store   *state.Store
	clock   *fakeClock
	health  *fakeHealth
	reports *fakeReports
}

func newLoopFixture(t *testing.T, client *Reporter) *loopFixture {
	t.Helper()
	store := openTestStore(t)
	clock := &fakeClock{now: time.Date(2026, 11, 13, 10, 7, 0, 0, time.UTC)}
	health := &fakeHealth{healthy: true}
	reports := &fakeReports{}

	loop, err := NewLoop(LoopOptions{
		Client:            client,
		Store:             store,
		Reports:           reports,
		Health:            health,
		ReadSys:           func() (sysinfo.Stats, error) { return sysinfo.Stats{}, sysinfo.ErrUnsupported },
		AgentVersion:      "0.1.0",
		HeartbeatInterval: 5 * time.Minute,
		TrafficInterval:   15 * time.Minute,
		Logger:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		Clock:             clock.Now,
		Sleep:             func(context.Context, time.Duration) error { return nil },
		Jitter:            func(delay time.Duration) time.Duration { return delay },
	})
	if err != nil {
		t.Fatalf("NewLoop: %v", err)
	}
	return &loopFixture{loop: loop, store: store, clock: clock, health: health, reports: reports}
}

func TestHeartbeatAcknowledgesTrafficAndAppliesResponse(t *testing.T) {
	cp, client := newControlPlane(t)
	fixture := newLoopFixture(t, client)
	report := seedOutbox(t, fixture.store, "01J2Z6Q8Y3V9M4K7T1B5C0D2E6")
	cp.respond = func(_ int, request *Report, w http.ResponseWriter) {
		writeSuccess(w, request.Traffic, 600, 1800, 13, 3)
	}
	if err := fixture.store.SetMetaInt64(state.KeyUsersVersion, 12); err != nil {
		t.Fatalf("SetMetaInt64: %v", err)
	}
	if err := fixture.store.SetMetaInt64(state.KeyAppliedConfigVersion, 2); err != nil {
		t.Fatalf("SetMetaInt64: %v", err)
	}

	delay := fixture.loop.step(context.Background())
	if got, want := delay, 10*time.Minute; got != want {
		t.Errorf("next delay = %s, want the Worker heartbeat %s", got, want)
	}

	requests := cp.requests()
	if len(requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(requests))
	}
	sent := requests[0]
	if sent.Traffic == nil {
		t.Fatal("traffic is missing from the heartbeat")
	}
	if sent.Traffic.ReportID != report.ReportID {
		t.Errorf("report_id = %q, want %q", sent.Traffic.ReportID, report.ReportID)
	}
	if sent.Traffic.Node.UplinkBytes != 3 || sent.Traffic.Node.DownlinkBytes != 4 {
		t.Errorf("node traffic = %+v, want 3/4", sent.Traffic.Node)
	}
	if sent.AppliedConfigVersion != 2 || sent.UsersVer != 12 {
		t.Errorf("versions = applied %d users %d, want 2 and 12", sent.AppliedConfigVersion, sent.UsersVer)
	}
	if sent.XrayVersion != "" {
		t.Errorf("xray_version = %q, want empty until the version probe exists", sent.XrayVersion)
	}
	if !sent.StatsHealthy || !sent.XrayHealthy {
		t.Errorf("health flags = stats %v xray %v, want true", sent.StatsHealthy, sent.XrayHealthy)
	}
	if sent.Sys != nil {
		t.Errorf("sys = %+v, want nil when sysinfo is unsupported", sent.Sys)
	}

	if outboxLen, _ := fixture.store.OutboxLen(); outboxLen != 0 {
		t.Errorf("outbox = %d reports after ACK, want 0", outboxLen)
	}
	// The response advertises users_ver 13, but a report cannot prove the user
	// set was applied: the applied version stays at 12 until the syncer writes it.
	usersVersion, _, _ := fixture.store.MetaInt64(state.KeyUsersVersion)
	if usersVersion != 12 {
		t.Errorf("stored applied users_ver = %d, want 12", usersVersion)
	}
	desiredUsersVersion, _, _ := fixture.store.MetaInt64(state.KeyDesiredUsersVersion)
	if desiredUsersVersion != 13 {
		t.Errorf("stored desired users_ver = %d, want 13", desiredUsersVersion)
	}
	desiredVersion, _, _ := fixture.store.MetaInt64(state.KeyDesiredConfigVersion)
	if desiredVersion != 3 {
		t.Errorf("stored desired_config_version = %d, want 3", desiredVersion)
	}
	if got, want := fixture.loop.heartbeatInterval, 600*time.Second; got != want {
		t.Errorf("heartbeat interval = %s, want %s", got, want)
	}
	if got, want := fixture.loop.trafficInterval, 1800*time.Second; got != want {
		t.Errorf("traffic interval = %s, want %s", got, want)
	}
}

func TestResponseCallbackRunsAfterVersionsAreStored(t *testing.T) {
	cp, client := newControlPlane(t)
	fixture := newLoopFixture(t, client)
	if err := fixture.store.SetMetaInt64(state.KeyUsersVersion, 12); err != nil {
		t.Fatalf("SetMetaInt64: %v", err)
	}
	cp.respond = func(_ int, request *Report, w http.ResponseWriter) {
		writeSuccess(w, request.Traffic, 300, 900, 13, 3)
	}

	type snapshot struct {
		applied int64
		desired int64
		calls   int
	}
	var seen snapshot
	fixture.loop.onResponse = func(*Response) {
		seen.calls++
		seen.applied, _, _ = fixture.store.MetaInt64(state.KeyUsersVersion)
		seen.desired, _, _ = fixture.store.MetaInt64(state.KeyDesiredUsersVersion)
	}

	fixture.loop.step(context.Background())

	if seen.calls != 1 {
		t.Fatalf("callback calls = %d, want 1", seen.calls)
	}
	if seen.applied != 12 || seen.desired != 13 {
		t.Errorf("state during callback = applied %d desired %d, want 12 and 13", seen.applied, seen.desired)
	}
}

func TestBeatWithoutOutboxSendsHeartbeatOnly(t *testing.T) {
	cp, client := newControlPlane(t)
	fixture := newLoopFixture(t, client)

	delay := fixture.loop.step(context.Background())
	if delay != 5*time.Minute {
		t.Errorf("next delay = %s, want the heartbeat interval", delay)
	}
	requests := cp.requests()
	if len(requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(requests))
	}
	if requests[0].Traffic != nil {
		t.Errorf("traffic = %+v, want nil when the outbox is empty", requests[0].Traffic)
	}
}

func TestUnhealthySourceIsReported(t *testing.T) {
	cp, client := newControlPlane(t)
	fixture := newLoopFixture(t, client)
	fixture.health.healthy = false

	fixture.loop.step(context.Background())

	sent := cp.requests()[0]
	if sent.StatsHealthy || sent.XrayHealthy {
		t.Errorf("health = stats %v xray %v, want false", sent.StatsHealthy, sent.XrayHealthy)
	}
}

func TestSysStatsAreIncludedWhenAvailable(t *testing.T) {
	cp, client := newControlPlane(t)
	fixture := newLoopFixture(t, client)
	fixture.loop.readSys = func() (sysinfo.Stats, error) {
		return sysinfo.Stats{CPU: 0.1, Mem: 0.2, Load: 0.3, Uptime: 42}, nil
	}

	fixture.loop.step(context.Background())

	sent := cp.requests()[0]
	if sent.Sys == nil {
		t.Fatal("sys is missing")
	}
	if *sent.Sys != (SysStats{CPU: 0.1, Mem: 0.2, Load: 0.3, Uptime: 42}) {
		t.Errorf("sys = %+v, want the sysinfo snapshot", *sent.Sys)
	}
}

func TestConflictDropsReport(t *testing.T) {
	for _, status := range []int{http.StatusConflict, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			cp, client := newControlPlane(t)
			cp.respond = func(_ int, _ *Report, w http.ResponseWriter) {
				writeError(w, status, "conflict")
			}
			fixture := newLoopFixture(t, client)
			seedOutbox(t, fixture.store, "01J2Z6Q8Y3V9M4K7T1B5C0D2E6")

			delay := fixture.loop.step(context.Background())
			if delay != 5*time.Minute {
				t.Errorf("next delay = %s, want the heartbeat interval after dropping", delay)
			}
			if outboxLen, _ := fixture.store.OutboxLen(); outboxLen != 0 {
				t.Errorf("outbox = %d reports, want the rejected report dropped", outboxLen)
			}
		})
	}
}

func TestRateLimitHonorsRetryAfter(t *testing.T) {
	cp, client := newControlPlane(t)
	cp.respond = func(_ int, _ *Report, w http.ResponseWriter) {
		w.Header().Set("Retry-After", "120")
		writeError(w, http.StatusTooManyRequests, "rate_limited")
	}
	fixture := newLoopFixture(t, client)
	seedOutbox(t, fixture.store, "01J2Z6Q8Y3V9M4K7T1B5C0D2E6")

	delay := fixture.loop.step(context.Background())
	if delay != 120*time.Second {
		t.Errorf("retry delay = %s, want the Retry-After value", delay)
	}
	if outboxLen, _ := fixture.store.OutboxLen(); outboxLen != 1 {
		t.Errorf("outbox = %d reports, want the report retained", outboxLen)
	}
}

func TestRateLimitBacksOffExponentiallyWithoutRetryAfter(t *testing.T) {
	cp, client := newControlPlane(t)
	cp.respond = func(_ int, _ *Report, w http.ResponseWriter) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
	}
	fixture := newLoopFixture(t, client)
	seedOutbox(t, fixture.store, "01J2Z6Q8Y3V9M4K7T1B5C0D2E6")

	first := fixture.loop.step(context.Background())
	if first < minRetryBackoff {
		t.Errorf("first retry delay = %s, want at least %s", first, minRetryBackoff)
	}
	fixture.clock.Advance(first)

	second := fixture.loop.step(context.Background())
	if second <= first {
		t.Errorf("second retry delay = %s, want more than %s", second, first)
	}
	if outboxLen, _ := fixture.store.OutboxLen(); outboxLen != 1 {
		t.Errorf("outbox = %d reports, want the report retained", outboxLen)
	}
}

func TestServerErrorKeepsReportAndBacksOff(t *testing.T) {
	cp, client := newControlPlane(t)
	cp.respond = func(_ int, _ *Report, w http.ResponseWriter) {
		writeError(w, http.StatusInternalServerError, "internal")
	}
	fixture := newLoopFixture(t, client)
	seedOutbox(t, fixture.store, "01J2Z6Q8Y3V9M4K7T1B5C0D2E6")

	delay := fixture.loop.step(context.Background())
	if delay < minRetryBackoff {
		t.Errorf("retry delay = %s, want at least %s", delay, minRetryBackoff)
	}
	if outboxLen, _ := fixture.store.OutboxLen(); outboxLen != 1 {
		t.Errorf("outbox = %d reports, want the report retained", outboxLen)
	}
}

func TestNetworkErrorKeepsReportAndBacksOff(t *testing.T) {
	flaky := &roundTripperFunc{
		roundTrip: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("network unreachable")
		},
	}
	client, err := New("https://panel.invalid", "node-1.secret", &http.Client{Transport: flaky, Timeout: time.Second})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	fixture := newLoopFixture(t, client)
	seedOutbox(t, fixture.store, "01J2Z6Q8Y3V9M4K7T1B5C0D2E6")

	delay := fixture.loop.step(context.Background())
	if delay < minRetryBackoff {
		t.Errorf("retry delay = %s, want at least %s", delay, minRetryBackoff)
	}
	if outboxLen, _ := fixture.store.OutboxLen(); outboxLen != 1 {
		t.Errorf("outbox = %d reports, want the report retained", outboxLen)
	}
}

func TestMissingAckKeepsReportForRetry(t *testing.T) {
	cp, client := newControlPlane(t)
	cp.respond = func(_ int, report *Report, w http.ResponseWriter) {
		if report.Traffic == nil {
			t.Fatal("first request is missing traffic")
		}
		writeEnvelope(w, http.StatusOK, map[string]any{
			"ack_report_id":              nil,
			"server_time":                time.Now().Unix(),
			"heartbeat_interval_seconds": 300,
			"traffic_interval_seconds":   900,
			"users_ver":                  13,
			"desired_config_version":     3,
			"unknown_users":              0,
			"directives":                 []any{},
		})
	}
	fixture := newLoopFixture(t, client)
	seedOutbox(t, fixture.store, "01J2Z6Q8Y3V9M4K7T1B5C0D2E6")

	delay := fixture.loop.step(context.Background())
	if delay < minRetryBackoff || delay >= 5*time.Minute {
		t.Errorf("retry delay = %s, want a backoff retry rather than a full heartbeat", delay)
	}
	if outboxLen, _ := fixture.store.OutboxLen(); outboxLen != 1 {
		t.Errorf("outbox = %d reports, want the report retained without an ACK", outboxLen)
	}
}

func TestMismatchedAckKeepsReport(t *testing.T) {
	cp, client := newControlPlane(t)
	cp.respond = func(_ int, _ *Report, w http.ResponseWriter) {
		writeEnvelope(w, http.StatusOK, map[string]any{
			"ack_report_id":              "01J2Z6Q8Y3V9M4K7T1B5C0D2E9",
			"server_time":                time.Now().Unix(),
			"heartbeat_interval_seconds": 300,
			"traffic_interval_seconds":   900,
			"users_ver":                  13,
			"desired_config_version":     3,
			"unknown_users":              0,
			"directives":                 []any{},
		})
	}
	fixture := newLoopFixture(t, client)
	seedOutbox(t, fixture.store, "01J2Z6Q8Y3V9M4K7T1B5C0D2E6")

	fixture.loop.step(context.Background())
	if outboxLen, _ := fixture.store.OutboxLen(); outboxLen != 1 {
		t.Errorf("outbox = %d reports, want the report retained for a foreign ACK", outboxLen)
	}
}

func TestHeartbeatsDoNotPostponeTrafficClose(t *testing.T) {
	_, client := newControlPlane(t)
	fixture := newLoopFixture(t, client)

	// The Worker confirms the configured 900s traffic interval on every
	// heartbeat; only a changed interval may move the close deadline.
	fixture.loop.step(context.Background())
	fixture.clock.Advance(5 * time.Minute)
	fixture.loop.step(context.Background())
	fixture.clock.Advance(10 * time.Minute)
	fixture.loop.step(context.Background())

	if fixture.reports.closeCalls != 1 {
		t.Errorf("CloseReports calls = %d, want 1 at the traffic interval", fixture.reports.closeCalls)
	}
}

func TestClosingSendsReportImmediately(t *testing.T) {
	cp, client := newControlPlane(t)
	fixture := newLoopFixture(t, client)
	fixture.reports.closed = 1
	fixture.reports.onClose = func() {
		if err := fixture.store.Update(func(tx *bolt.Tx) error {
			return state.PutOutboxReport(tx, state.TrafficReport{
				ReportID:    "01J2Z6Q8Y3V9M4K7T1B5C0D2E6",
				PeriodStart: 1_780_000_000,
				PeriodEnd:   1_780_003_600,
				Users:       []state.ReportUser{{Email: "alice@example.com", UplinkBytes: 1, DownlinkBytes: 1}},
			})
		}); err != nil {
			t.Fatalf("seed outbox: %v", err)
		}
	}
	fixture.loop.nextClose = fixture.clock.Now()

	delay := fixture.loop.step(context.Background())

	if fixture.reports.closeCalls != 1 {
		t.Errorf("CloseReports calls = %d, want 1", fixture.reports.closeCalls)
	}
	requests := cp.requests()
	if len(requests) != 1 || requests[0].Traffic == nil {
		t.Fatalf("requests = %+v, want an immediate report send", requests)
	}
	if requests[0].Traffic.ReportID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6" {
		t.Errorf("sent report id = %q, want the freshly closed report", requests[0].Traffic.ReportID)
	}
	if delay != 5*time.Minute {
		t.Errorf("next delay = %s, want the heartbeat interval", delay)
	}
}

func TestExpiredReportsDroppedEachStep(t *testing.T) {
	_, client := newControlPlane(t)
	fixture := newLoopFixture(t, client)

	fixture.loop.step(context.Background())
	if fixture.reports.dropCalls != 1 {
		t.Errorf("DropExpired calls = %d, want 1 per step", fixture.reports.dropCalls)
	}
}

func TestInvalidWorkerIntervalsAreIgnored(t *testing.T) {
	cp, client := newControlPlane(t)
	cp.respond = func(_ int, _ *Report, w http.ResponseWriter) {
		writeSuccess(w, nil, 10, 10, 13, 3)
	}
	fixture := newLoopFixture(t, client)

	delay := fixture.loop.step(context.Background())
	if fixture.loop.heartbeatInterval != 5*time.Minute {
		t.Errorf("heartbeat interval = %s, want the configured 5m", fixture.loop.heartbeatInterval)
	}
	if fixture.loop.trafficInterval != 15*time.Minute {
		t.Errorf("traffic interval = %s, want the configured 15m", fixture.loop.trafficInterval)
	}
	if delay != 5*time.Minute {
		t.Errorf("next delay = %s, want 5m", delay)
	}
}

func TestLoopStopsOnContextCancel(t *testing.T) {
	_, client := newControlPlane(t)
	fixture := newLoopFixture(t, client)
	fixture.loop.sleep = sleepContext

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	go func() { done <- fixture.loop.Run(ctx) }()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run returned %v, want nil after cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after context cancellation")
	}
}

type roundTripperFunc struct {
	roundTrip func(*http.Request) (*http.Response, error)
}

func (f *roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f.roundTrip(request)
}
