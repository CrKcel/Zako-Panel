// Package xray defines the agent's boundary to Xray-core.
//
// P0 reads StatsService over loopback gRPC through StatsClient. HandlerService
// (user add/remove) belongs to P1 and is exposed as an interface only. Message
// encoding is hand written in proto.go, so the agent does not vendor xray-core
// or depend on protoc.
package xray

import (
	"context"
	"errors"
	"fmt"
)

// ErrNotImplemented marks capabilities that have no transport yet.
var ErrNotImplemented = errors.New("not implemented")

// FlowVision is the only VLESS flow P0 supports for REALITY inbounds.
const FlowVision = "xtls-rprx-vision"

// ByteCounters are cumulative traffic counters. The agent never resets them.
type ByteCounters struct {
	UplinkBytes   int64
	DownlinkBytes int64
}

// UserCounters are the cumulative counters for one xray_email, read from the
// user>>>EMAIL>>>traffic>>>uplink|downlink stats keys.
type UserCounters struct {
	Email         string
	UplinkBytes   int64
	DownlinkBytes int64
}

// SystemStats carries the Xray process uptime used to detect counter resets
// after a restart.
type SystemStats struct {
	UptimeSeconds int64
}

// StatsReader mirrors the StatsService queries the collector needs.
//
// Implementations must call QueryStats with reset=false. Resetting counters
// destroys the delta accounting that outlives a single agent process.
type StatsReader interface {
	// UserTraffic returns counters for every stats-enabled user.
	UserTraffic(ctx context.Context) ([]UserCounters, error)
	// InboundTraffic returns counters keyed by inbound tag. The "api" inbound
	// must be excluded so local control traffic is not billed as proxy traffic.
	InboundTraffic(ctx context.Context) (map[string]ByteCounters, error)
	// SysStats returns process-level stats for reset detection.
	SysStats(ctx context.Context) (SystemStats, error)
}

// User is a VLESS credential applied through HandlerService. Level is fixed at 0
// because P0 statistics policy enables user stats only at level 0.
type User struct {
	Email string
	UUID  string
	Flow  string
}

// UserManager mutates the running inbound. RemoveUser stops future connections
// but cannot terminate sessions that are already established.
type UserManager interface {
	AddUser(ctx context.Context, user User) error
	RemoveUser(ctx context.Context, email string) error
}

// Unimplemented fails every capability explicitly. Tests and future call sites use
// it to get ErrNotImplemented instead of zero counters that would look like idle
// traffic.
type Unimplemented struct{}

func (Unimplemented) UserTraffic(context.Context) ([]UserCounters, error) {
	return nil, fmt.Errorf("xray: user traffic: %w", ErrNotImplemented)
}

func (Unimplemented) InboundTraffic(context.Context) (map[string]ByteCounters, error) {
	return nil, fmt.Errorf("xray: inbound traffic: %w", ErrNotImplemented)
}

func (Unimplemented) SysStats(context.Context) (SystemStats, error) {
	return SystemStats{}, fmt.Errorf("xray: system stats: %w", ErrNotImplemented)
}

func (Unimplemented) AddUser(context.Context, User) error {
	return fmt.Errorf("xray: add user: %w", ErrNotImplemented)
}

func (Unimplemented) RemoveUser(context.Context, string) error {
	return fmt.Errorf("xray: remove user: %w", ErrNotImplemented)
}

var (
	_ StatsReader = Unimplemented{}
	_ UserManager = Unimplemented{}
)
