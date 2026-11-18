// Package accounting converts cumulative Xray counters into report deltas.
//
// It implements docs/traffic.md §2: the first sample only establishes baselines,
// later samples produce deltas, and the deltas are appended to a persisted hourly
// report in the same Bolt transaction that stores the new baselines and uptime.
// Reports are capped at 40 users and split on hour boundaries; closed reports move
// to the outbox and stay there until the Worker acknowledges them.
package accounting

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/zako-panel/zako-agent/internal/collector"
	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/xraycore"
)

const (
	// MaxUsersPerReport matches the Worker request-body and contract limit.
	MaxUsersPerReport = 40
	// OutboxMaxAge is how long an unacknowledged report is retried before it is
	// dropped. The Worker keeps report IDs for 30 days, so a 7 day local backlog
	// is always still accepted.
	OutboxMaxAge = 7 * 24 * time.Hour

	hourSeconds = int64(3600)
)

// Accountant owns delta accounting.
//
// Sampling (Handle, collector goroutine) and closing (CloseReports, reporter
// goroutine) are not guarded by a caller lock. Every state change runs inside one
// state.Store.Update write transaction, and bbolt serializes writers, so the two
// goroutines cannot interleave a baseline read with a report write. Do not add an
// in-memory cache that lives across transactions: Handle must read the baselines,
// update the open report and replace the baselines in the same transaction, or a
// concurrent close could split one sample across two transactions.
type Accountant struct {
	store       *state.Store
	now         func() time.Time
	newReportID func(time.Time) string
	logger      *slog.Logger
}

// Option customizes an Accountant. Tests use the clock and ID generator to stay
// deterministic.
type Option func(*Accountant)

// WithClock overrides the wall clock used when a sample carries no timestamp.
func WithClock(now func() time.Time) Option {
	return func(accountant *Accountant) {
		if now != nil {
			accountant.now = now
		}
	}
}

// WithReportIDGenerator overrides report ID creation.
func WithReportIDGenerator(generate func(time.Time) string) Option {
	return func(accountant *Accountant) {
		if generate != nil {
			accountant.newReportID = generate
		}
	}
}

// WithLogger sets the diagnostic logger.
func WithLogger(logger *slog.Logger) Option {
	return func(accountant *Accountant) {
		if logger != nil {
			accountant.logger = logger
		}
	}
}

// New validates dependencies.
func New(store *state.Store, opts ...Option) (*Accountant, error) {
	if store == nil {
		return nil, fmt.Errorf("accounting: state store is required")
	}
	accountant := &Accountant{
		store:       store,
		now:         time.Now,
		newReportID: defaultReportID,
		logger:      slog.Default(),
	}
	for _, opt := range opts {
		opt(accountant)
	}
	return accountant, nil
}

func defaultReportID(now time.Time) string {
	return ulid.Make().String()
}

// Handle is a collector.Handler. Returning an error drops only this sample; the
// baselines are written in the same transaction as the delta, so a failed write
// cannot advance the counters without accounting for the traffic.
func (a *Accountant) Handle(_ context.Context, sample collector.Sample) error {
	at := sample.At
	if at.IsZero() {
		at = a.now()
	}

	var (
		gap            bool
		boundaryGap    bool
		counterReset   bool
		sampledUsers   int
		sampledInbound int
		missingUsers   int
		missingInbound int
	)

	err := a.store.Update(func(tx *state.Tx) error {
		baselines, err := state.ReadBaselines(tx)
		if err != nil {
			return err
		}

		first := !baselines.Initialized
		// An Xray restart resets every cumulative counter. Trusting the stored
		// baselines would produce a negative delta, so the current value is
		// treated as the delta since the restart.
		uptimeRegressed := baselines.Initialized && sample.XrayUptimeSeconds < baselines.UptimeSeconds

		// A sample that crosses an hour boundary contains traffic from the
		// previous bucket. It is attributed to the sample's hour (docs/traffic.md
		// §2) and the report is marked as approximate.
		boundaryGap = baselines.Initialized && baselines.LastSampleAt != 0 &&
			hourBucket(baselines.LastSampleAt) != hourBucket(at.Unix())

		next := state.Baselines{
			Initialized:   true,
			LastSampleAt:  at.Unix(),
			UptimeSeconds: sample.XrayUptimeSeconds,
			Users:         make(map[string]state.CounterBaseline, len(sample.Users)),
			Inbounds:      make(map[string]state.CounterBaseline, len(sample.Inbounds)),
		}
		for _, user := range sample.Users {
			next.Users[user.Email] = state.CounterBaseline{
				UplinkBytes:   user.UplinkBytes,
				DownlinkBytes: user.DownlinkBytes,
			}
		}
		for tag, counter := range sample.Inbounds {
			// API inbound traffic is control traffic; the StatsClient already
			// filters it, and ignoring it here keeps the billing invariant local
			// to the code that sums node traffic.
			if tag == xraycore.APITag {
				continue
			}
			next.Inbounds[tag] = state.CounterBaseline{
				UplinkBytes:   counter.UplinkBytes,
				DownlinkBytes: counter.DownlinkBytes,
			}
		}

		userDeltas := make(map[string]state.CounterBaseline)
		if !first {
			regressed := uptimeRegressed
			for _, email := range sortedKeys(next.Users) {
				current := next.Users[email]
				previous, existed := baselines.Users[email]
				if !existed {
					// New counter: establish its baseline without backfilling
					// traffic that happened before the agent saw it.
					continue
				}
				uplink, downlink, counterGap := delta(current.UplinkBytes, previous.UplinkBytes, current.DownlinkBytes, previous.DownlinkBytes, uptimeRegressed)
				if counterGap {
					regressed = true
				}
				if uplink != 0 || downlink != 0 {
					userDeltas[email] = state.CounterBaseline{UplinkBytes: uplink, DownlinkBytes: downlink}
				}
			}
			sampledUsers = len(userDeltas)

			var nodeUplink, nodeDownlink int64
			for _, tag := range sortedKeys(next.Inbounds) {
				current := next.Inbounds[tag]
				previous, existed := baselines.Inbounds[tag]
				if !existed {
					continue
				}
				uplink, downlink, counterGap := delta(current.UplinkBytes, previous.UplinkBytes, current.DownlinkBytes, previous.DownlinkBytes, uptimeRegressed)
				if counterGap {
					regressed = true
				}
				nodeUplink += uplink
				nodeDownlink += downlink
			}
			sampledInbound = len(next.Inbounds)
			// Counters that vanished from the sample have no delta. Their
			// baselines are dropped by ReplaceBaselines so a later reappearance
			// starts from scratch instead of backfilling traffic.
			for email := range baselines.Users {
				if _, found := next.Users[email]; !found {
					missingUsers++
				}
			}
			for tag := range baselines.Inbounds {
				if _, found := next.Inbounds[tag]; !found {
					missingInbound++
				}
			}
			counterReset = regressed
			gap = regressed || boundaryGap

			if err := a.appendDelta(tx, at, userDeltas, nodeUplink, nodeDownlink, gap); err != nil {
				return err
			}
		}

		return state.ReplaceBaselines(tx, next)
	})
	if err != nil {
		return fmt.Errorf("accounting: apply sample: %w", err)
	}

	if missingUsers > 0 || missingInbound > 0 {
		a.logger.Debug("dropped missing counters",
			"users", missingUsers, "inbounds", missingInbound, "sample_at", at.Unix())
	}
	if gap {
		a.logger.Warn("traffic report marked with counter gap",
			"users", sampledUsers, "inbounds", sampledInbound,
			"hour_boundary", boundaryGap, "counter_reset", counterReset,
			"sample_at", at.Unix())
	}
	return nil
}

// delta compares one counter pair. A counter that moved backwards means Xray
// restarted or the stats were reset; the current value is the delta since that
// reset. A missing baseline is handled by the caller and yields no delta.
func delta(uplink, previousUplink, downlink, previousDownlink int64, uptimeRegressed bool) (int64, int64, bool) {
	if uptimeRegressed {
		return uplink, downlink, true
	}
	gap := false
	uplinkDelta := uplink - previousUplink
	if uplinkDelta < 0 {
		uplinkDelta = uplink
		gap = true
	}
	downlinkDelta := downlink - previousDownlink
	if downlinkDelta < 0 {
		downlinkDelta = downlink
		gap = true
	}
	return uplinkDelta, downlinkDelta, gap
}

func hourBucket(unix int64) int64 {
	return unix - unix%hourSeconds
}

// appendDelta stores the sample's deltas in the open report for at's hour. When
// the current report already holds MaxUsersPerReport users, a new report for the
// same hour is opened instead of exceeding the contract limit.
func (a *Accountant) appendDelta(tx *state.Tx, at time.Time, userDeltas map[string]state.CounterBaseline, nodeUplink, nodeDownlink int64, gap bool) error {
	if len(userDeltas) == 0 && nodeUplink == 0 && nodeDownlink == 0 {
		return nil
	}

	hourStart := at.UTC().Truncate(time.Hour).Unix()
	hourEnd := hourStart + hourSeconds
	open, err := state.PendingReportsForHour(tx, hourStart)
	if err != nil {
		return err
	}

	// choose returns the first report with room for another user entry.
	choose := func() *state.TrafficReport {
		for index := range open {
			if len(open[index].Users) < MaxUsersPerReport {
				return &open[index]
			}
		}
		report := state.TrafficReport{
			ReportID:    a.newReportID(at),
			PeriodStart: hourStart,
			PeriodEnd:   hourEnd,
		}
		open = append(open, report)
		return &open[len(open)-1]
	}

	nodeAdded := false
	emails := sortedKeys(userDeltas)
	for _, email := range emails {
		counter := userDeltas[email]
		report := choose()
		if !nodeAdded {
			report.UplinkBytes += nodeUplink
			report.DownlinkBytes += nodeDownlink
			nodeAdded = true
		}
		report.AddUser(email, counter.UplinkBytes, counter.DownlinkBytes)
		if gap {
			report.HasCounterGap = true
		}
	}
	if !nodeAdded && (nodeUplink != 0 || nodeDownlink != 0) {
		report := choose()
		report.UplinkBytes += nodeUplink
		report.DownlinkBytes += nodeDownlink
		report.HasCounterGap = report.HasCounterGap || gap
	}

	for _, report := range open {
		if err := state.PutPendingReport(tx, report); err != nil {
			return err
		}
	}
	return nil
}

// CloseReports moves every open report to the outbox in one transaction. The
// close policy lives here because it is a reporting rule, not a storage format:
// period_end is clamped to the close time because the Worker rejects a period_end
// more than five minutes in the future, and it stays inside the report's hour
// bucket because the Worker requires period_start and period_end in one hour.
// Empty reports are discarded instead of enqueued.
func (a *Accountant) CloseReports() (int, error) {
	closeAt := a.now()
	closed := 0
	err := a.store.Update(func(tx *state.Tx) error {
		reports, err := state.PendingReports(tx)
		if err != nil {
			return err
		}
		for _, report := range reports {
			if report.Empty() {
				if err := state.DeletePendingReport(tx, report); err != nil {
					return err
				}
				continue
			}
			report.PeriodEnd = closedPeriodEnd(report, closeAt)
			if err := state.PutOutboxReport(tx, report); err != nil {
				return err
			}
			if err := state.DeletePendingReport(tx, report); err != nil {
				return err
			}
			closed++
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("accounting: close reports: %w", err)
	}
	if closed > 0 {
		a.logger.Debug("closed traffic reports", "reports", closed)
	}
	return closed, nil
}

// DropExpired removes outbox reports older than OutboxMaxAge and logs one warning
// per dropped report so an operator can see the lost traffic window. The Worker
// keeps report IDs for 30 days, so a 7 day local backlog is always still accepted
// and a longer one would retry forever.
func (a *Accountant) DropExpired(now time.Time) (int, error) {
	cutoff := now.Add(-OutboxMaxAge).Unix()
	dropped := make([]state.TrafficReport, 0)
	err := a.store.Update(func(tx *state.Tx) error {
		reports, err := state.OutboxReports(tx)
		if err != nil {
			return err
		}
		for _, report := range reports {
			if report.PeriodEnd >= cutoff {
				continue
			}
			if err := state.DeleteOutboxReport(tx, report.ReportID); err != nil {
				return err
			}
			dropped = append(dropped, report)
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("accounting: drop expired reports: %w", err)
	}
	for _, report := range dropped {
		a.logger.Warn("dropped expired traffic report",
			"report_id", report.ReportID,
			"period_start", report.PeriodStart,
			"period_end", report.PeriodEnd,
			"max_age_hours", int(OutboxMaxAge.Hours()),
		)
	}
	return len(dropped), nil
}

// closedPeriodEnd caps a report at the close time without leaving its hour
// bucket. The clamp keeps period_end greater than period_start.
func closedPeriodEnd(report state.TrafficReport, closeAt time.Time) int64 {
	end := closeAt.Unix()
	if end > report.PeriodEnd {
		end = report.PeriodEnd
	}
	if end <= report.PeriodStart {
		end = report.PeriodStart + 1
	}
	return end
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

var _ collector.Handler = (*Accountant)(nil).Handle
