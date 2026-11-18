package xraycore

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// defaultStatsCallTimeout bounds one StatsService RPC. The collector runs every
// sample interval; a hung loopback call must not stall the whole sampling loop.
const defaultStatsCallTimeout = 5 * time.Second

// StatsClient is the loopback gRPC StatsService client.
//
// The underlying connection is created lazily and grpc reconnects it on its own,
// so a restarted Xray is picked up without an agent restart. Failed calls are
// returned to the caller; the collector turns that into stats_healthy=false.
type StatsClient struct {
	conn    *grpc.ClientConn
	timeout time.Duration
}

// StatsClientOption customizes a StatsClient.
type StatsClientOption func(*StatsClient)

// WithCallTimeout overrides the per-call deadline.
func WithCallTimeout(timeout time.Duration) StatsClientOption {
	return func(client *StatsClient) {
		if timeout > 0 {
			client.timeout = timeout
		}
	}
}

// NewStatsClient dials target without blocking. target must be host:port, which
// the config loader already enforces; it is validated again so tests and future
// callers cannot construct a client that fails only at the first sample.
func NewStatsClient(target string, opts ...StatsClientOption) (*StatsClient, error) {
	if err := validateTarget(target); err != nil {
		return nil, err
	}

	client := &StatsClient{timeout: defaultStatsCallTimeout}
	for _, opt := range opts {
		opt(client)
	}

	conn, err := grpc.NewClient(target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.ForceCodec(statsCodec{})),
	)
	if err != nil {
		return nil, fmt.Errorf("xray: dial stats service %s: %w", target, err)
	}
	client.conn = conn
	return client, nil
}

// Close releases the gRPC connection. It is safe to call once at shutdown.
func (c *StatsClient) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	err := c.conn.Close()
	c.conn = nil
	if err != nil {
		return fmt.Errorf("xray: close stats client: %w", err)
	}
	return nil
}

// UserTraffic returns cumulative counters per email. reset is always false.
func (c *StatsClient) UserTraffic(ctx context.Context) ([]UserCounters, error) {
	stats, err := c.queryStats(ctx, userPrefix)
	if err != nil {
		return nil, fmt.Errorf("xray: user traffic: %w", err)
	}

	byEmail := make(map[string]*UserCounters)
	for _, entry := range stats {
		email, direction, ok := parseUserStat(entry.Name)
		if !ok {
			continue
		}
		counter, found := byEmail[email]
		if !found {
			counter = &UserCounters{Email: email}
			byEmail[email] = counter
		}
		if direction == statUplink {
			counter.UplinkBytes = entry.Value
		} else {
			counter.DownlinkBytes = entry.Value
		}
	}

	users := make([]UserCounters, 0, len(byEmail))
	for _, counter := range byEmail {
		users = append(users, *counter)
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Email < users[j].Email })
	return users, nil
}

// InboundTraffic returns counters per inbound tag, excluding the loopback API
// inbound so control traffic is never billed as proxy traffic.
func (c *StatsClient) InboundTraffic(ctx context.Context) (map[string]ByteCounters, error) {
	stats, err := c.queryStats(ctx, inboundPrefix)
	if err != nil {
		return nil, fmt.Errorf("xray: inbound traffic: %w", err)
	}

	inbounds := make(map[string]ByteCounters)
	for _, entry := range stats {
		tag, direction, ok := parseInboundStat(entry.Name)
		if !ok || tag == APITag {
			continue
		}
		counter := inbounds[tag]
		if direction == statUplink {
			counter.UplinkBytes = entry.Value
		} else {
			counter.DownlinkBytes = entry.Value
		}
		inbounds[tag] = counter
	}
	return inbounds, nil
}

// SysStats returns the Xray process uptime. Uptime regression means the process
// restarted and its counters reset.
func (c *StatsClient) SysStats(ctx context.Context) (SystemStats, error) {
	callCtx, cancel := c.callContext(ctx)
	defer cancel()

	response := &sysStatsResponse{}
	if err := c.conn.Invoke(callCtx, getSysStats, &sysStatsRequest{}, response); err != nil {
		return SystemStats{}, fmt.Errorf("xray: system stats: %w", err)
	}
	return SystemStats{UptimeSeconds: int64(response.Uptime)}, nil
}

func (c *StatsClient) queryStats(ctx context.Context, pattern string) ([]stat, error) {
	callCtx, cancel := c.callContext(ctx)
	defer cancel()

	request := &queryStatsRequest{Pattern: pattern, Reset: false}
	response := &queryStatsResponse{}
	if err := c.conn.Invoke(callCtx, queryStatsMethod, request, response); err != nil {
		return nil, fmt.Errorf("query stats %q: %w", pattern, err)
	}
	return response.Stats, nil
}

func (c *StatsClient) callContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if c.timeout <= 0 {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, c.timeout)
}

func validateTarget(target string) error {
	if strings.TrimSpace(target) == "" {
		return errors.New("xray: stats target is required")
	}
	host, port, err := net.SplitHostPort(target)
	if err != nil {
		return fmt.Errorf("xray: stats target %q must be host:port: %w", target, err)
	}
	if strings.TrimSpace(host) == "" {
		return fmt.Errorf("xray: stats target %q must include a host", target)
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return fmt.Errorf("xray: stats target %q must include a port between 1 and 65535", target)
	}
	return nil
}

var _ StatsReader = (*StatsClient)(nil)
