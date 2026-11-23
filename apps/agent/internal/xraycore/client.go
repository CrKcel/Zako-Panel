// Package xraycore defines the agent's gRPC boundary to Xray-core.
//
// StatsClient reads StatsService and HandlerClient mutates the running managed
// inbounds through HandlerService, both over loopback gRPC. Message encoding is
// hand written in proto.go and handler_proto.go, so the agent does not vendor
// xray-core or depend on protoc.
//
// The package is the bottom layer of the agent's Xray support: the credential
// and counter types here are shared with the config renderer and the callers,
// and nothing in this package imports another xray* package.
package xraycore

import (
	"context"
)

// FlowVision is the VLESS flow used for REALITY inbounds.
const FlowVision = "xtls-rprx-vision"

// Protocol is the panel id of a managed inbound's protocol. The values are the
// panel's protocol ids rather than Xray protocol names, so they can travel to the
// Worker unchanged.
type Protocol string

const (
	ProtocolVlessReality Protocol = "vless-reality"
	ProtocolVmess        Protocol = "vmess"
	ProtocolTrojan       Protocol = "trojan"
	ProtocolShadowsocks  Protocol = "shadowsocks"
)

// InboundTarget is one inbound HandlerService must mutate, together with the
// protocol its account encoding belongs to. Method is the shadowsocks cipher; the
// other protocols leave it empty.
type InboundTarget struct {
	Tag      string
	Protocol Protocol
	Method   string
}

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

// User is one proxy credential applied through HandlerService. UUID is the single
// node-client secret: the UUID for vless and vmess, the password verbatim for
// trojan and shadowsocks. Flow applies to vless only. Level is fixed at 0 because
// the shipped policy enables user stats only at level 0.
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

var _ UserManager = (*HandlerClient)(nil)
