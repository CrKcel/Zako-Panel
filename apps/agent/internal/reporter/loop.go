package reporter

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/zako-panel/zako-agent/internal/state"
	"github.com/zako-panel/zako-agent/internal/sysinfo"
)

const (
	// Interval bounds mirror docs/architecture.md §1.4. A Worker response outside
	// these bounds is ignored; accepting it could starve or flood the control
	// plane.
	minHeartbeatInterval = 60 * time.Second
	maxHeartbeatInterval = 900 * time.Second
	minTrafficInterval   = 300 * time.Second
	maxTrafficInterval   = 3600 * time.Second

	minRetryBackoff = 5 * time.Second
	maxRetryBackoff = 5 * time.Minute

	// clockSkewWarn is the server_time difference above which the node clock is
	// reported as suspect. Timesyncd/NTP remains the operator's responsibility.
	clockSkewWarn = 5 * time.Minute
)

// HealthSource reports whether the last Xray StatsService sample succeeded.
type HealthSource interface {
	Healthy() bool
}

// ReportCloser owns the accounting side effects the reporter schedules: closing
// open reports and dropping expired outbox entries.
type ReportCloser interface {
	CloseReports() (int, error)
	DropExpired(now time.Time) (int, error)
}

// LoopOptions assembles a Loop. Interval defaults come from the agent config; the
// Worker response may override them within the documented bounds.
type LoopOptions struct {
	Client            *Reporter
	Store             *state.Store
	Reports           ReportCloser
	Health            HealthSource
	ReadSys           func() (sysinfo.Stats, error)
	AgentVersion      string
	HeartbeatInterval time.Duration
	TrafficInterval   time.Duration
	Logger            *slog.Logger
	Clock             func() time.Time
	Sleep             func(ctx context.Context, delay time.Duration) error
	Jitter            func(delay time.Duration) time.Duration
	// OnResponse runs after a response was accepted and its versions stored. It
	// is called on the reporting goroutine, so it must not block; the agent uses
	// it to wake the user syncer.
	OnResponse func(response *Response)
}

// Loop sends heartbeats and the oldest unacknowledged traffic report on the
// shared report endpoint. All scheduling times are explicit so tests advance a
// fake clock instead of sleeping.
type Loop struct {
	client       *Reporter
	store        *state.Store
	reports      ReportCloser
	health       HealthSource
	readSys      func() (sysinfo.Stats, error)
	agentVersion string
	logger       *slog.Logger
	clock        func() time.Time
	sleep        func(ctx context.Context, delay time.Duration) error
	jitter       func(delay time.Duration) time.Duration
	onResponse   func(response *Response)

	heartbeatInterval time.Duration
	trafficInterval   time.Duration

	nextSend  time.Time
	nextClose time.Time
	backoff   time.Duration
}

// NewLoop validates dependencies and intervals.
func NewLoop(opts LoopOptions) (*Loop, error) {
	if opts.Client == nil {
		return nil, errors.New("reporter: client is required")
	}
	if opts.Store == nil {
		return nil, errors.New("reporter: state store is required")
	}
	if opts.Reports == nil {
		return nil, errors.New("reporter: report closer is required")
	}
	if opts.Health == nil {
		return nil, errors.New("reporter: health source is required")
	}
	heartbeat := opts.HeartbeatInterval
	if heartbeat == 0 {
		heartbeat = 5 * time.Minute
	}
	if err := validateInterval("heartbeat_interval", heartbeat, minHeartbeatInterval, maxHeartbeatInterval); err != nil {
		return nil, err
	}
	traffic := opts.TrafficInterval
	if traffic == 0 {
		traffic = 15 * time.Minute
	}
	if err := validateInterval("traffic_interval", traffic, minTrafficInterval, maxTrafficInterval); err != nil {
		return nil, err
	}

	loop := &Loop{
		client:            opts.Client,
		store:             opts.Store,
		reports:           opts.Reports,
		health:            opts.Health,
		readSys:           opts.ReadSys,
		agentVersion:      opts.AgentVersion,
		logger:            opts.Logger,
		clock:             opts.Clock,
		sleep:             opts.Sleep,
		jitter:            opts.Jitter,
		onResponse:        opts.OnResponse,
		heartbeatInterval: heartbeat,
		trafficInterval:   traffic,
	}
	if loop.readSys == nil {
		loop.readSys = sysinfo.Read
	}
	if loop.logger == nil {
		loop.logger = slog.Default()
	}
	if loop.clock == nil {
		loop.clock = time.Now
	}
	if loop.sleep == nil {
		loop.sleep = sleepContext
	}
	if loop.jitter == nil {
		loop.jitter = randomJitter
	}
	return loop, nil
}

// Run schedules sends until ctx is canceled. The first heartbeat happens
// immediately so node health and intervals are known without waiting one full
// period.
func (l *Loop) Run(ctx context.Context) error {
	l.nextSend = l.clock()
	l.nextClose = l.nextSend.Add(l.trafficInterval)

	for {
		delay := l.step(ctx)
		if err := l.sleep(ctx, delay); err != nil {
			return nil
		}
	}
}

// step performs at most one send and returns how long to wait before the next
// step. Keeping the scheduling decision synchronous lets tests drive it with a
// fake clock instead of sleeping.
func (l *Loop) step(ctx context.Context) time.Duration {
	now := l.clock()
	if l.nextSend.IsZero() {
		l.nextSend = now
	}
	if l.nextClose.IsZero() {
		l.nextClose = now.Add(l.trafficInterval)
	}

	if _, err := l.reports.DropExpired(now); err != nil {
		l.logger.Warn("drop expired reports failed", "error", err)
	}

	// Closing creates outbox entries. Sending immediately keeps the traffic
	// reporting cadence independent of the heartbeat cadence.
	forceSend := false
	if !now.Before(l.nextClose) {
		closed, err := l.reports.CloseReports()
		if err != nil {
			l.logger.Warn("close traffic reports failed", "error", err)
		}
		forceSend = closed > 0
		l.nextClose = now.Add(l.trafficInterval)
	}

	report, hasReport, err := l.store.EarliestOutbox()
	if err != nil {
		l.logger.Error("read outbox failed", "error", err)
		return l.wait(now)
	}
	if !forceSend && now.Before(l.nextSend) {
		// A waiting outbox report is piggybacked on the next heartbeat so the
		// request cadence stays at the Worker-configured interval.
		return l.wait(now)
	}

	return l.send(ctx, now, report, hasReport)
}

// send performs one POST and applies ACK, retry and drop policy. It always returns
// a strictly positive delay so the caller cannot busy loop.
func (l *Loop) send(ctx context.Context, now time.Time, report state.TrafficReport, hasReport bool) time.Duration {
	payload, err := l.buildReport(now, report, hasReport)
	if err != nil {
		l.logger.Error("build report failed", "error", err)
		return l.scheduleBackoff(now)
	}

	response, err := l.client.Submit(ctx, payload)
	if err != nil {
		var httpErr *HTTPError
		if errors.As(err, &httpErr) {
			return l.handleHTTPError(now, httpErr, report, hasReport)
		}
		l.logger.Warn("report send failed", "error", err)
		return l.scheduleBackoff(now)
	}

	l.applyResponse(now, response)
	if l.onResponse != nil {
		l.onResponse(response)
	}

	if hasReport {
		switch {
		case response.AckReportID == nil:
			l.logger.Warn("report accepted without ack", "report_id", report.ReportID)
			return l.scheduleBackoff(now)
		case *response.AckReportID != report.ReportID:
			l.logger.Warn("report ack does not match sent report",
				"report_id", report.ReportID, "ack_report_id", *response.AckReportID)
			return l.scheduleBackoff(now)
		default:
			if err := l.store.DeleteOutbox(report.ReportID); err != nil {
				l.logger.Error("delete acknowledged report failed",
					"report_id", report.ReportID, "error", err)
			}
			l.logger.Debug("report acknowledged", "report_id", report.ReportID)
		}
	}

	l.backoff = 0
	l.nextSend = now.Add(l.heartbeatInterval)
	return l.wait(now)
}

func (l *Loop) handleHTTPError(now time.Time, httpErr *HTTPError, report state.TrafficReport, hasReport bool) time.Duration {
	switch httpErr.StatusCode {
	case 409:
		// The Worker already stored a different payload under this report_id.
		// Keeping it would retry the same conflict forever.
		l.dropReport("payload conflict", report, hasReport, httpErr)
		l.backoff = 0
		l.nextSend = now.Add(l.heartbeatInterval)
		return l.wait(now)
	case 413, 422:
		// Reports are split to 40 users and validated locally, so this means a
		// contract mismatch; retrying the same body cannot succeed.
		l.dropReport("report rejected", report, hasReport, httpErr)
		l.backoff = 0
		l.nextSend = now.Add(l.heartbeatInterval)
		return l.wait(now)
	case 429:
		delay := httpErr.RetryAfter
		if delay <= 0 {
			delay = l.nextBackoff()
		} else {
			l.backoff = delay
		}
		l.logger.Warn("report rate limited", "retry_after_seconds", int(delay.Seconds()))
		l.nextSend = now.Add(delay)
		return l.wait(now)
	default:
		// 5xx and unexpected 4xx: the report may already be valid, so keep it and
		// retry with exponential backoff.
		l.logger.Warn("report rejected by control plane",
			"status", httpErr.StatusCode, "code", httpErr.Code)
		return l.scheduleBackoff(now)
	}
}

func (l *Loop) dropReport(reason string, report state.TrafficReport, hasReport bool, httpErr *HTTPError) {
	if !hasReport {
		return
	}
	l.logger.Warn("dropping traffic report",
		"reason", reason, "report_id", report.ReportID,
		"period_start", report.PeriodStart, "status", httpErr.StatusCode)
	if err := l.store.DeleteOutbox(report.ReportID); err != nil {
		l.logger.Error("delete dropped report failed", "report_id", report.ReportID, "error", err)
	}
}

func (l *Loop) scheduleBackoff(now time.Time) time.Duration {
	delay := l.nextBackoff()
	l.nextSend = now.Add(delay)
	return l.wait(now)
}

func (l *Loop) nextBackoff() time.Duration {
	if l.backoff < minRetryBackoff {
		l.backoff = minRetryBackoff
	} else {
		l.backoff *= 2
		if l.backoff > maxRetryBackoff {
			l.backoff = maxRetryBackoff
		}
	}
	return l.jitter(l.backoff)
}

// applyResponse stores the versions and intervals the Worker declared. Interval
// values outside the documented bounds are ignored rather than trusted.
func (l *Loop) applyResponse(now time.Time, response *Response) {
	if response.HeartbeatIntervalSeconds > 0 {
		interval := time.Duration(response.HeartbeatIntervalSeconds) * time.Second
		if interval >= minHeartbeatInterval && interval <= maxHeartbeatInterval {
			l.heartbeatInterval = interval
		}
	}
	if response.TrafficIntervalSeconds > 0 {
		interval := time.Duration(response.TrafficIntervalSeconds) * time.Second
		if interval >= minTrafficInterval && interval <= maxTrafficInterval && interval != l.trafficInterval {
			l.trafficInterval = interval
			l.nextClose = now.Add(interval)
		}
	}

	// response.users_ver is the Worker's expectation, not proof that the node
	// applied it. Persisting it as users_version would make the next report claim
	// a set the node may not serve; the syncer owns that key.
	if err := l.store.SetMetaInt64(state.KeyDesiredUsersVersion, response.UsersVer); err != nil {
		l.logger.Warn("store desired users version failed", "error", err)
	}
	if err := l.store.SetMetaInt64(state.KeyDesiredConfigVersion, response.DesiredConfigVersion); err != nil {
		l.logger.Warn("store desired config version failed", "error", err)
	}

	// The agent cannot change the node clock; a large skew is logged so an
	// operator can fix time sync before hourly buckets drift.
	if skew := time.Duration(response.ServerTime-now.Unix()) * time.Second; skew > clockSkewWarn || skew < -clockSkewWarn {
		l.logger.Warn("clock skew detected", "skew_seconds", int(skew.Seconds()))
	}
}

func (l *Loop) buildReport(now time.Time, report state.TrafficReport, hasReport bool) (*Report, error) {
	usersVersion, _, err := l.store.MetaInt64(state.KeyUsersVersion)
	if err != nil {
		return nil, err
	}
	appliedVersion, _, err := l.store.MetaInt64(state.KeyAppliedConfigVersion)
	if err != nil {
		return nil, err
	}

	healthy := l.health.Healthy()
	payload := &Report{
		SentAt:               now.Unix(),
		AgentVersion:         l.agentVersion,
		XrayVersion:          "",
		XrayHealthy:          healthy,
		StatsHealthy:         healthy,
		AppliedConfigVersion: appliedVersion,
		UsersVer:             usersVersion,
	}

	if l.readSys != nil {
		// Non-Linux hosts have no /proc; sys is optional in the contract.
		if stats, err := l.readSys(); err == nil {
			payload.Sys = &SysStats{
				CPU:    stats.CPU,
				Mem:    stats.Mem,
				Load:   stats.Load,
				Uptime: stats.Uptime,
			}
		} else if !errors.Is(err, sysinfo.ErrUnsupported) {
			l.logger.Debug("read system stats failed", "error", err)
		}
	}

	if hasReport {
		payload.Traffic = trafficPayload(report)
	}
	return payload, nil
}

func trafficPayload(report state.TrafficReport) *Traffic {
	users := make([]TrafficUser, 0, len(report.Users))
	for _, user := range report.Users {
		users = append(users, TrafficUser{
			XrayEmail:     user.Email,
			UplinkBytes:   user.UplinkBytes,
			DownlinkBytes: user.DownlinkBytes,
		})
	}
	return &Traffic{
		ReportID:      report.ReportID,
		PeriodStart:   report.PeriodStart,
		PeriodEnd:     report.PeriodEnd,
		HasCounterGap: report.HasCounterGap,
		Node: TrafficNode{
			UplinkBytes:   report.UplinkBytes,
			DownlinkBytes: report.DownlinkBytes,
		},
		Users: users,
	}
}

// wait returns the time until the next scheduled action. A zero or negative gap
// is clamped so the run loop cannot spin when the clock does not advance.
func (l *Loop) wait(now time.Time) time.Duration {
	next := l.nextSend
	if !l.nextClose.IsZero() && l.nextClose.Before(next) {
		next = l.nextClose
	}
	delay := next.Sub(now)
	if delay <= 0 {
		return time.Millisecond
	}
	return delay
}

func validateInterval(field string, value, minValue, maxValue time.Duration) error {
	if value < minValue || value > maxValue {
		return fmt.Errorf("reporter: %s must be between %s and %s, got %s", field, minValue, maxValue, value)
	}
	return nil
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

// randomJitter spreads retries by ±20% so many nodes do not retry in lockstep
// after a Worker outage.
func randomJitter(delay time.Duration) time.Duration {
	if delay <= 0 {
		return delay
	}
	spread := int64(delay) / 5
	offset := rand.Int64N(spread*2+1) - spread
	adjusted := delay + time.Duration(offset)
	if adjusted < time.Second {
		return time.Second
	}
	return adjusted
}
