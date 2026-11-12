package state

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func openTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.db")
	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return store, path
}

func putOutbox(t *testing.T, store *Store, report TrafficReport) {
	t.Helper()
	if err := store.Update(func(tx *bolt.Tx) error {
		return PutOutboxReport(tx, report)
	}); err != nil {
		t.Fatalf("put outbox report %s: %v", report.ReportID, err)
	}
}

func TestOutboxOrderingAndDelete(t *testing.T) {
	store, _ := openTestStore(t)
	t.Cleanup(func() { _ = store.Close() })

	for _, id := range []string{"01J2Z6Q8Y3V9M4K7T1B5C0D2E7", "01J2Z6Q8Y3V9M4K7T1B5C0D2E6", "01J2Z6Q8Y3V9M4K7T1B5C0D2E8"} {
		putOutbox(t, store, TrafficReport{ReportID: id, PeriodStart: 1, PeriodEnd: 3600})
	}

	count, err := store.OutboxLen()
	if err != nil {
		t.Fatalf("OutboxLen: %v", err)
	}
	if count != 3 {
		t.Errorf("outbox length = %d, want 3", count)
	}

	earliest, found, err := store.EarliestOutbox()
	if err != nil {
		t.Fatalf("EarliestOutbox: %v", err)
	}
	if !found || earliest.ReportID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6" {
		t.Errorf("earliest = %+v, want the lexicographically smallest report id", earliest)
	}

	// Duplicate deletes are harmless: a repeated ACK must not fail the loop.
	if err := store.DeleteOutbox("01J2Z6Q8Y3V9M4K7T1B5C0D2E6"); err != nil {
		t.Fatalf("DeleteOutbox: %v", err)
	}
	if err := store.DeleteOutbox("01J2Z6Q8Y3V9M4K7T1B5C0D2E6"); err != nil {
		t.Fatalf("second DeleteOutbox: %v", err)
	}
	earliest, found, err = store.EarliestOutbox()
	if err != nil {
		t.Fatalf("EarliestOutbox: %v", err)
	}
	if !found || earliest.ReportID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E7" {
		t.Errorf("earliest after delete = %+v, want ...E7", earliest)
	}
}

func TestClosePendingReportsMovesToOutbox(t *testing.T) {
	store, _ := openTestStore(t)
	t.Cleanup(func() { _ = store.Close() })

	pending := TrafficReport{
		ReportID:    "01J2Z6Q8Y3V9M4K7T1B5C0D2E6",
		PeriodStart: 1_780_000_000 / 3600 * 3600,
		PeriodEnd:   1_780_000_000/3600*3600 + 3600,
		Users:       []ReportUser{{Email: "alice@example.com", UplinkBytes: 10, DownlinkBytes: 20}},
	}
	empty := TrafficReport{
		ReportID:    "01J2Z6Q8Y3V9M4K7T1B5C0D2E7",
		PeriodStart: pending.PeriodStart,
		PeriodEnd:   pending.PeriodEnd,
	}
	if err := store.Update(func(tx *bolt.Tx) error {
		if err := PutPendingReport(tx, pending); err != nil {
			return err
		}
		return PutPendingReport(tx, empty)
	}); err != nil {
		t.Fatalf("put pending: %v", err)
	}

	closed, err := store.ClosePendingReports()
	if err != nil {
		t.Fatalf("ClosePendingReports: %v", err)
	}
	if closed != 1 {
		t.Errorf("closed = %d, want 1 (empty reports are discarded)", closed)
	}

	var remaining []TrafficReport
	if err := store.View(func(tx *bolt.Tx) error {
		var err error
		remaining, err = PendingReports(tx)
		return err
	}); err != nil {
		t.Fatalf("PendingReports: %v", err)
	}
	if len(remaining) != 0 {
		t.Errorf("pending reports = %+v, want none", remaining)
	}

	stored, found, err := store.EarliestOutbox()
	if err != nil {
		t.Fatalf("EarliestOutbox: %v", err)
	}
	if !found || stored.ReportID != pending.ReportID || len(stored.Users) != 1 {
		t.Errorf("outbox report = %+v, want the closed report", stored)
	}
}

func TestBaselinesReplaceRemovesStaleCounters(t *testing.T) {
	store, _ := openTestStore(t)
	t.Cleanup(func() { _ = store.Close() })

	initial := Baselines{
		Initialized:   true,
		UptimeSeconds: 100,
		Users: map[string]CounterBaseline{
			"alice@example.com": {UplinkBytes: 10, DownlinkBytes: 20},
			"bob@example.com":   {UplinkBytes: 30, DownlinkBytes: 40},
		},
		Inbounds: map[string]CounterBaseline{
			"proxy": {UplinkBytes: 1, DownlinkBytes: 2},
			"api":   {UplinkBytes: 3, DownlinkBytes: 4},
		},
	}
	if err := store.Update(func(tx *bolt.Tx) error { return ReplaceBaselines(tx, initial) }); err != nil {
		t.Fatalf("ReplaceBaselines: %v", err)
	}

	var read Baselines
	if err := store.View(func(tx *bolt.Tx) error {
		var err error
		read, err = ReadBaselines(tx)
		return err
	}); err != nil {
		t.Fatalf("ReadBaselines: %v", err)
	}
	if !read.Initialized || read.UptimeSeconds != 100 {
		t.Errorf("baselines = %+v, want initialized with uptime 100", read)
	}
	if len(read.Users) != 2 || read.Users["bob@example.com"].DownlinkBytes != 40 {
		t.Errorf("users = %+v, want both users", read.Users)
	}
	if len(read.Inbounds) != 2 {
		t.Errorf("inbounds = %+v, want both tags", read.Inbounds)
	}

	// A counter that disappears from the sample must be dropped, not carried
	// forward as a negative delta source.
	next := Baselines{
		Initialized:   true,
		UptimeSeconds: 200,
		Users: map[string]CounterBaseline{
			"alice@example.com": {UplinkBytes: 15, DownlinkBytes: 25},
		},
		Inbounds: map[string]CounterBaseline{
			"proxy": {UplinkBytes: 5, DownlinkBytes: 6},
		},
	}
	if err := store.Update(func(tx *bolt.Tx) error { return ReplaceBaselines(tx, next) }); err != nil {
		t.Fatalf("second ReplaceBaselines: %v", err)
	}
	if err := store.View(func(tx *bolt.Tx) error {
		var err error
		read, err = ReadBaselines(tx)
		return err
	}); err != nil {
		t.Fatalf("ReadBaselines: %v", err)
	}
	if _, found := read.Users["bob@example.com"]; found {
		t.Errorf("stale user baseline survived: %+v", read.Users)
	}
	if _, found := read.Inbounds["api"]; found {
		t.Errorf("stale inbound baseline survived: %+v", read.Inbounds)
	}
	if read.UptimeSeconds != 200 {
		t.Errorf("uptime = %d, want 200", read.UptimeSeconds)
	}
}

func TestDiscardExpiredOutbox(t *testing.T) {
	store, _ := openTestStore(t)
	t.Cleanup(func() { _ = store.Close() })

	now := time.Unix(1_780_000_000, 0).UTC()
	old := TrafficReport{ReportID: "01J2Z6Q8Y3V9M4K7T1B5C0D2E6", PeriodStart: 1, PeriodEnd: now.Add(-8 * 24 * time.Hour).Unix()}
	fresh := TrafficReport{ReportID: "01J2Z6Q8Y3V9M4K7T1B5C0D2E7", PeriodStart: 2, PeriodEnd: now.Add(-1 * 24 * time.Hour).Unix()}
	putOutbox(t, store, old)
	putOutbox(t, store, fresh)

	dropped, err := store.DiscardExpiredOutbox(now, 7*24*time.Hour)
	if err != nil {
		t.Fatalf("DiscardExpiredOutbox: %v", err)
	}
	if len(dropped) != 1 || dropped[0].ReportID != old.ReportID {
		t.Errorf("dropped = %+v, want only the 8 day old report", dropped)
	}
	remaining, found, err := store.EarliestOutbox()
	if err != nil {
		t.Fatalf("EarliestOutbox: %v", err)
	}
	if !found || remaining.ReportID != fresh.ReportID {
		t.Errorf("remaining = %+v, want the fresh report", remaining)
	}

	if _, err := store.DiscardExpiredOutbox(now, 0); err == nil {
		t.Error("DiscardExpiredOutbox accepted a non-positive max age")
	}
}

func TestStoreSurvivesReopen(t *testing.T) {
	store, path := openTestStore(t)

	baselines := Baselines{
		Initialized:   true,
		UptimeSeconds: 500,
		Users: map[string]CounterBaseline{
			"alice@example.com": {UplinkBytes: 10, DownlinkBytes: 20},
		},
		Inbounds: map[string]CounterBaseline{
			"proxy": {UplinkBytes: 3, DownlinkBytes: 4},
		},
	}
	pending := TrafficReport{
		ReportID:    "01J2Z6Q8Y3V9M4K7T1B5C0D2E6",
		PeriodStart: 1_780_000_000,
		PeriodEnd:   1_780_003_600,
		Users:       []ReportUser{{Email: "alice@example.com", UplinkBytes: 5, DownlinkBytes: 6}},
	}
	if err := store.Update(func(tx *bolt.Tx) error {
		if err := ReplaceBaselines(tx, baselines); err != nil {
			return err
		}
		return PutPendingReport(tx, pending)
	}); err != nil {
		t.Fatalf("seed state: %v", err)
	}
	if err := store.SetMetaInt64(KeyUsersVersion, 12); err != nil {
		t.Fatalf("SetMetaInt64: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	var read Baselines
	var reports []TrafficReport
	if err := reopened.View(func(tx *bolt.Tx) error {
		var err error
		if read, err = ReadBaselines(tx); err != nil {
			return err
		}
		reports, err = PendingReports(tx)
		return err
	}); err != nil {
		t.Fatalf("read reopened state: %v", err)
	}
	if !read.Initialized || read.UptimeSeconds != 500 || read.Users["alice@example.com"].UplinkBytes != 10 {
		t.Errorf("baselines after reopen = %+v", read)
	}
	if len(reports) != 1 || reports[0].ReportID != pending.ReportID {
		t.Errorf("pending reports after reopen = %+v, want the sealed batch", reports)
	}
	version, found, err := reopened.MetaInt64(KeyUsersVersion)
	if err != nil {
		t.Fatalf("MetaInt64: %v", err)
	}
	if !found || version != 12 {
		t.Errorf("users version after reopen = %d (found=%v), want 12", version, found)
	}
}

func TestMetaInt64MissingAndClosed(t *testing.T) {
	store, _ := openTestStore(t)

	value, found, err := store.MetaInt64(KeyAppliedConfigVersion)
	if err != nil {
		t.Fatalf("MetaInt64: %v", err)
	}
	if found || value != 0 {
		t.Errorf("missing key = (%d, %v), want (0, false)", value, found)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, _, err := store.MetaInt64(KeyUsersVersion); !errors.Is(err, ErrClosed) {
		t.Errorf("MetaInt64 after Close error = %v, want ErrClosed", err)
	}
	if err := store.SetMetaInt64(KeyUsersVersion, 1); !errors.Is(err, ErrClosed) {
		t.Errorf("SetMetaInt64 after Close error = %v, want ErrClosed", err)
	}
}
