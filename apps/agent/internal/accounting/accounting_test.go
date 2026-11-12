package accounting

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/zako-panel/zako-agent/internal/collector"
	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/xray"
	bolt "go.etcd.io/bbolt"
)

var testHour = time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)

func newTestAccountant(t *testing.T) (*Accountant, *state.Store) {
	t.Helper()
	store, err := state.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	sequence := 0
	accountant, err := New(store, WithReportIDGenerator(func(time.Time) string {
		sequence++
		return fmt.Sprintf("01J2Z6Q8Y3V9M4K7T1B5C0D2E%02d", sequence)
	}))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return accountant, store
}

func makeSample(at time.Time, users map[string][2]int64, inbounds map[string][2]int64, uptime int64) collector.Sample {
	sample := collector.Sample{At: at, XrayUptimeSeconds: uptime}
	for email, counters := range users {
		sample.Users = append(sample.Users, xray.UserCounters{
			Email: email, UplinkBytes: counters[0], DownlinkBytes: counters[1],
		})
	}
	sample.Inbounds = make(map[string]xray.ByteCounters, len(inbounds))
	for tag, counters := range inbounds {
		sample.Inbounds[tag] = xray.ByteCounters{UplinkBytes: counters[0], DownlinkBytes: counters[1]}
	}
	return sample
}

func handle(t *testing.T, accountant *Accountant, sample collector.Sample) {
	t.Helper()
	if err := accountant.Handle(context.Background(), sample); err != nil {
		t.Fatalf("Handle: %v", err)
	}
}

func readBaselines(t *testing.T, store *state.Store) state.Baselines {
	t.Helper()
	var baselines state.Baselines
	if err := store.View(func(tx *bolt.Tx) error {
		var err error
		baselines, err = state.ReadBaselines(tx)
		return err
	}); err != nil {
		t.Fatalf("ReadBaselines: %v", err)
	}
	return baselines
}

func readPending(t *testing.T, store *state.Store) []state.TrafficReport {
	t.Helper()
	var reports []state.TrafficReport
	if err := store.View(func(tx *bolt.Tx) error {
		var err error
		reports, err = state.PendingReports(tx)
		return err
	}); err != nil {
		t.Fatalf("PendingReports: %v", err)
	}
	return reports
}

func readOutbox(t *testing.T, store *state.Store) []state.TrafficReport {
	t.Helper()
	var reports []state.TrafficReport
	if err := store.View(func(tx *bolt.Tx) error {
		var err error
		reports, err = state.OutboxReports(tx)
		return err
	}); err != nil {
		t.Fatalf("OutboxReports: %v", err)
	}
	return reports
}

func TestFirstSampleOnlyEstablishesBaseline(t *testing.T) {
	accountant, store := newTestAccountant(t)

	handle(t, accountant, makeSample(testHour,
		map[string][2]int64{"alice@example.com": {100, 200}},
		map[string][2]int64{"proxy": {10, 20}}, 50))

	if pending := readPending(t, store); len(pending) != 0 {
		t.Errorf("pending = %+v, want no report from the first sample", pending)
	}
	if count := len(readOutbox(t, store)); count != 0 {
		t.Errorf("outbox = %d reports, want none", count)
	}

	baselines := readBaselines(t, store)
	if !baselines.Initialized || baselines.UptimeSeconds != 50 {
		t.Errorf("baselines = %+v, want initialized with uptime 50", baselines)
	}
	if got := baselines.Users["alice@example.com"]; got.UplinkBytes != 100 || got.DownlinkBytes != 200 {
		t.Errorf("alice baseline = %+v, want 100/200", got)
	}
	if got := baselines.Inbounds["proxy"]; got.UplinkBytes != 10 || got.DownlinkBytes != 20 {
		t.Errorf("proxy baseline = %+v, want 10/20", got)
	}
}

func TestDeltasAccumulateIntoHourlyReport(t *testing.T) {
	accountant, store := newTestAccountant(t)
	first := makeSample(testHour, map[string][2]int64{"alice@example.com": {100, 200}}, map[string][2]int64{"proxy": {10, 20}}, 50)
	handle(t, accountant, first)

	handle(t, accountant, makeSample(testHour.Add(30*time.Second),
		map[string][2]int64{"alice@example.com": {150, 260}},
		map[string][2]int64{"proxy": {15, 28}}, 80))

	pending := readPending(t, store)
	if len(pending) != 1 {
		t.Fatalf("pending = %+v, want one open report", pending)
	}
	report := pending[0]
	if report.PeriodStart != testHour.Unix() || report.PeriodEnd != testHour.Unix()+3600 {
		t.Errorf("period = [%d, %d], want the sample's hour bucket", report.PeriodStart, report.PeriodEnd)
	}
	if report.HasCounterGap {
		t.Error("has_counter_gap = true, want false for a monotonic sample")
	}
	if got := report.Users[0]; got.Email != "alice@example.com" || got.UplinkBytes != 50 || got.DownlinkBytes != 60 {
		t.Errorf("user delta = %+v, want 50/60", got)
	}
	if report.UplinkBytes != 5 || report.DownlinkBytes != 8 {
		t.Errorf("node delta = %d/%d, want 5/8 from the non-api inbound", report.UplinkBytes, report.DownlinkBytes)
	}

	// A sample with no movement must not change the stored traffic.
	handle(t, accountant, makeSample(testHour.Add(time.Minute),
		map[string][2]int64{"alice@example.com": {150, 260}},
		map[string][2]int64{"proxy": {15, 28}}, 110))
	pending = readPending(t, store)
	if len(pending) != 1 || pending[0].Users[0].UplinkBytes != 50 || pending[0].UplinkBytes != 5 {
		t.Errorf("pending after zero delta = %+v, want unchanged", pending)
	}

	baselines := readBaselines(t, store)
	if baselines.UptimeSeconds != 110 || baselines.Users["alice@example.com"].UplinkBytes != 150 {
		t.Errorf("baselines = %+v, want the latest counters", baselines)
	}
}

func TestCounterDecreaseUsesCurrentValueAndMarksGap(t *testing.T) {
	accountant, store := newTestAccountant(t)
	handle(t, accountant, makeSample(testHour,
		map[string][2]int64{"alice@example.com": {100, 200}},
		map[string][2]int64{"proxy": {100, 200}}, 1000))

	handle(t, accountant, makeSample(testHour.Add(30*time.Second),
		map[string][2]int64{"alice@example.com": {20, 30}},
		map[string][2]int64{"proxy": {30, 250}}, 1030))

	pending := readPending(t, store)
	if len(pending) != 1 {
		t.Fatalf("pending = %+v, want one report", pending)
	}
	report := pending[0]
	if !report.HasCounterGap {
		t.Error("has_counter_gap = false, want true after a counter decrease")
	}
	if got := report.Users[0]; got.UplinkBytes != 20 || got.DownlinkBytes != 30 {
		t.Errorf("user delta = %+v, want the current value 20/30", got)
	}
	// The proxy uplink regressed (30 < 100), the downlink did not (250 >= 200).
	if report.UplinkBytes != 30 || report.DownlinkBytes != 50 {
		t.Errorf("node delta = %d/%d, want 30/50", report.UplinkBytes, report.DownlinkBytes)
	}
}

func TestPartialCounterDecreaseKeepsOtherDirectionDelta(t *testing.T) {
	accountant, store := newTestAccountant(t)
	handle(t, accountant, makeSample(testHour, map[string][2]int64{"alice@example.com": {100, 200}}, nil, 10))
	handle(t, accountant, makeSample(testHour.Add(time.Minute), map[string][2]int64{"alice@example.com": {120, 50}}, nil, 70))

	report := readPending(t, store)[0]
	if !report.HasCounterGap {
		t.Error("has_counter_gap = false, want true")
	}
	if got := report.Users[0]; got.UplinkBytes != 20 || got.DownlinkBytes != 50 {
		t.Errorf("user delta = %+v, want 20/50", got)
	}
}

func TestUptimeRegressionTreatsCurrentCountersAsDelta(t *testing.T) {
	accountant, store := newTestAccountant(t)
	handle(t, accountant, makeSample(testHour,
		map[string][2]int64{"alice@example.com": {100, 200}},
		map[string][2]int64{"proxy": {10, 20}}, 1000))

	// Xray restarted: uptime went backwards and its counters restarted too.
	handle(t, accountant, makeSample(testHour.Add(time.Minute),
		map[string][2]int64{"alice@example.com": {30, 40}},
		map[string][2]int64{"proxy": {3, 4}}, 10))

	report := readPending(t, store)[0]
	if !report.HasCounterGap {
		t.Error("has_counter_gap = false, want true after an uptime regression")
	}
	if got := report.Users[0]; got.UplinkBytes != 30 || got.DownlinkBytes != 40 {
		t.Errorf("user delta = %+v, want the current values 30/40", got)
	}
	if report.UplinkBytes != 3 || report.DownlinkBytes != 4 {
		t.Errorf("node delta = %d/%d, want 3/4", report.UplinkBytes, report.DownlinkBytes)
	}
	baselines := readBaselines(t, store)
	if baselines.UptimeSeconds != 10 {
		t.Errorf("uptime baseline = %d, want 10", baselines.UptimeSeconds)
	}
}

func TestMissingCounterClearsBaselineWithoutNegativeDelta(t *testing.T) {
	accountant, store := newTestAccountant(t)
	handle(t, accountant, makeSample(testHour,
		map[string][2]int64{"alice@example.com": {100, 200}, "bob@example.com": {300, 400}},
		map[string][2]int64{"proxy": {10, 20}, "removed": {1, 2}}, 50))

	// bob and the "removed" inbound disappear from the sample.
	handle(t, accountant, makeSample(testHour.Add(30*time.Second),
		map[string][2]int64{"alice@example.com": {110, 210}},
		map[string][2]int64{"proxy": {11, 22}}, 80))

	baselines := readBaselines(t, store)
	if _, found := baselines.Users["bob@example.com"]; found {
		t.Errorf("missing user baseline survived: %+v", baselines.Users)
	}
	if _, found := baselines.Inbounds["removed"]; found {
		t.Errorf("missing inbound baseline survived: %+v", baselines.Inbounds)
	}
	reports := readPending(t, store)
	if len(reports) != 1 {
		t.Fatalf("pending = %+v, want one report", reports)
	}
	for _, user := range reports[0].Users {
		if user.Email == "bob@example.com" {
			t.Errorf("report contains a delta for the missing counter: %+v", user)
		}
		if user.UplinkBytes < 0 || user.DownlinkBytes < 0 {
			t.Errorf("negative delta recorded: %+v", user)
		}
	}

	// When bob reappears its counter is used as a fresh baseline, not backfilled.
	handle(t, accountant, makeSample(testHour.Add(time.Minute),
		map[string][2]int64{"alice@example.com": {120, 220}, "bob@example.com": {500, 600}},
		map[string][2]int64{"proxy": {12, 24}}, 110))
	reports = readPending(t, store)
	if len(reports) != 1 {
		t.Fatalf("pending = %+v, want one report", reports)
	}
	if _, found := reports[0].User("bob@example.com"); found {
		t.Errorf("reappearing counter backfilled traffic: %+v", reports[0].Users)
	}
	if got, _ := reports[0].User("alice@example.com"); got.UplinkBytes != 20 || got.DownlinkBytes != 20 {
		t.Errorf("alice delta = %+v, want 20/20", got)
	}
}

func TestHourBoundarySplitsReports(t *testing.T) {
	accountant, store := newTestAccountant(t)
	handle(t, accountant, makeSample(testHour, map[string][2]int64{"alice@example.com": {0, 0}}, nil, 10))
	handle(t, accountant, makeSample(testHour.Add(59*time.Minute+59*time.Second),
		map[string][2]int64{"alice@example.com": {10, 10}}, nil, 70))
	handle(t, accountant, makeSample(testHour.Add(time.Hour+time.Second),
		map[string][2]int64{"alice@example.com": {30, 30}}, nil, 130))

	pending := readPending(t, store)
	if len(pending) != 2 {
		t.Fatalf("pending = %d reports, want one per hour bucket", len(pending))
	}
	if pending[0].PeriodStart != testHour.Unix() || pending[1].PeriodStart != testHour.Add(time.Hour).Unix() {
		t.Errorf("period starts = [%d %d], want [%d %d]",
			pending[0].PeriodStart, pending[1].PeriodStart, testHour.Unix(), testHour.Add(time.Hour).Unix())
	}
	for _, report := range pending {
		if report.PeriodEnd-report.PeriodStart != 3600 {
			t.Errorf("report %s period = %d..%d, want one hour",
				report.ReportID, report.PeriodStart, report.PeriodEnd)
		}
	}
	// The sample at 11:00:01 carries traffic from the previous bucket, so its
	// report is marked approximate; the 10:59:59 sample stays exact.
	if pending[0].HasCounterGap {
		t.Error("first hour report has_counter_gap = true, want false")
	}
	if !pending[1].HasCounterGap {
		t.Error("cross-boundary report has_counter_gap = false, want true")
	}

	closed, err := accountant.CloseReports()
	if err != nil {
		t.Fatalf("CloseReports: %v", err)
	}
	if closed != 2 {
		t.Errorf("closed = %d, want 2", closed)
	}
	outbox := readOutbox(t, store)
	if len(outbox) != 2 {
		t.Fatalf("outbox = %+v, want two reports", outbox)
	}
	if outbox[0].ReportID == outbox[1].ReportID {
		t.Error("report IDs are not unique across hour buckets")
	}
}

func TestFortyUserLimitSplitsReport(t *testing.T) {
	accountant, store := newTestAccountant(t)

	users := make(map[string][2]int64, 45)
	for index := 0; index < 45; index++ {
		users[fmt.Sprintf("u%02d@example.com", index)] = [2]int64{0, 0}
	}
	handle(t, accountant, makeSample(testHour, users, map[string][2]int64{"proxy": {0, 0}}, 10))

	for index := 0; index < 45; index++ {
		users[fmt.Sprintf("u%02d@example.com", index)] = [2]int64{int64(index + 1), int64(index + 2)}
	}
	handle(t, accountant, makeSample(testHour.Add(30*time.Second), users, map[string][2]int64{"proxy": {1, 2}}, 40))

	pending := readPending(t, store)
	if len(pending) != 2 {
		t.Fatalf("pending = %d reports, want 2 for 45 users", len(pending))
	}
	totalUsers := 0
	for _, report := range pending {
		if len(report.Users) > MaxUsersPerReport {
			t.Errorf("report %s has %d users, limit is %d", report.ReportID, len(report.Users), MaxUsersPerReport)
		}
		totalUsers += len(report.Users)
	}
	if totalUsers != 45 {
		t.Errorf("users across reports = %d, want 45", totalUsers)
	}

	// Node totals must be counted exactly once, independent of how users split.
	var nodeUplink, nodeDownlink int64
	for _, report := range pending {
		nodeUplink += report.UplinkBytes
		nodeDownlink += report.DownlinkBytes
	}
	if nodeUplink != 1 || nodeDownlink != 2 {
		t.Errorf("node totals across reports = %d/%d, want 1/2", nodeUplink, nodeDownlink)
	}
	if pending[0].ReportID == pending[1].ReportID {
		t.Error("split reports share a report id")
	}
}

func TestNodeTrafficExcludesAPIInbound(t *testing.T) {
	accountant, store := newTestAccountant(t)
	handle(t, accountant, makeSample(testHour, nil, map[string][2]int64{"api": {0, 0}, "proxy": {0, 0}}, 10))
	handle(t, accountant, makeSample(testHour.Add(30*time.Second), nil,
		map[string][2]int64{"api": {1000, 1000}, "proxy": {7, 8}}, 40))

	reports := readPending(t, store)
	if len(reports) != 1 {
		t.Fatalf("pending = %+v, want one report", reports)
	}
	if reports[0].UplinkBytes != 7 || reports[0].DownlinkBytes != 8 {
		t.Errorf("node delta = %d/%d, want only the proxy inbound 7/8",
			reports[0].UplinkBytes, reports[0].DownlinkBytes)
	}
	if _, found := readBaselines(t, store).Inbounds["api"]; found {
		t.Error("api inbound baseline was stored")
	}
}

func TestRestartRecoversBaselinesAndOutbox(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	store, err := state.Open(path)
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	sequence := 0
	newID := func(time.Time) string {
		sequence++
		return fmt.Sprintf("01J2Z6Q8Y3V9M4K7T1B5C0D2E%02d", sequence)
	}
	accountant, err := New(store, WithReportIDGenerator(newID))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	handle(t, accountant, makeSample(testHour,
		map[string][2]int64{"alice@example.com": {100, 200}}, map[string][2]int64{"proxy": {10, 20}}, 50))
	handle(t, accountant, makeSample(testHour.Add(time.Minute),
		map[string][2]int64{"alice@example.com": {150, 250}}, map[string][2]int64{"proxy": {13, 24}}, 110))
	if _, err := accountant.CloseReports(); err != nil {
		t.Fatalf("CloseReports: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := state.Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	restarted, err := New(reopened, WithReportIDGenerator(newID))
	if err != nil {
		t.Fatalf("New after restart: %v", err)
	}

	outbox := readOutbox(t, reopened)
	if len(outbox) != 1 {
		t.Fatalf("outbox after restart = %+v, want the closed report", outbox)
	}
	if outbox[0].Users[0].UplinkBytes != 50 || outbox[0].UplinkBytes != 3 {
		t.Errorf("outbox report = %+v, want the pre-restart deltas", outbox[0])
	}

	// The stored baseline is the second sample; the delta must continue from it.
	handle(t, restarted, makeSample(testHour.Add(2*time.Minute),
		map[string][2]int64{"alice@example.com": {180, 290}}, map[string][2]int64{"proxy": {15, 27}}, 170))
	pending := readPending(t, reopened)
	if len(pending) != 1 {
		t.Fatalf("pending after restart = %+v, want one report", pending)
	}
	if got := pending[0].Users[0]; got.UplinkBytes != 30 || got.DownlinkBytes != 40 {
		t.Errorf("post-restart delta = %+v, want 30/40 from the stored baseline", got)
	}
}

func TestDropExpiredReports(t *testing.T) {
	accountant, store := newTestAccountant(t)
	now := testHour
	expired := state.TrafficReport{
		ReportID:    "01J2Z6Q8Y3V9M4K7T1B5C0D2E01",
		PeriodStart: now.Add(-9 * 24 * time.Hour).Unix(),
		PeriodEnd:   now.Add(-9*24*time.Hour + time.Hour).Unix(),
	}
	fresh := state.TrafficReport{
		ReportID:    "01J2Z6Q8Y3V9M4K7T1B5C0D2E02",
		PeriodStart: now.Add(-time.Hour).Unix(),
		PeriodEnd:   now.Unix(),
	}
	if err := store.Update(func(tx *bolt.Tx) error {
		if err := state.PutOutboxReport(tx, expired); err != nil {
			return err
		}
		return state.PutOutboxReport(tx, fresh)
	}); err != nil {
		t.Fatalf("seed outbox: %v", err)
	}

	dropped, err := accountant.DropExpired(now)
	if err != nil {
		t.Fatalf("DropExpired: %v", err)
	}
	if dropped != 1 {
		t.Errorf("dropped = %d, want 1", dropped)
	}
	if outbox := readOutbox(t, store); len(outbox) != 1 || outbox[0].ReportID != fresh.ReportID {
		t.Errorf("outbox = %+v, want only the fresh report", outbox)
	}
}
