package xraycore

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/encoding/protowire"
)

// fakeStatsServer is the loopback StatsService used by the tests. It records the
// request patterns so a reset=true regression fails a test.
type fakeStatsServer interface {
	QueryStats(ctx context.Context, request *queryStatsRequest) (*queryStatsResponse, error)
	GetSysStats(ctx context.Context, request *sysStatsRequest) (*sysStatsResponse, error)
}

type recordingStats struct {
	mu       sync.Mutex
	patterns []string
	resets   []bool
	users    []stat
	inbounds []stat
	uptime   uint32
	queryErr error
	sysErr   error
}

func (s *recordingStats) QueryStats(_ context.Context, request *queryStatsRequest) (*queryStatsResponse, error) {
	s.mu.Lock()
	s.patterns = append(s.patterns, request.Pattern)
	s.resets = append(s.resets, request.Reset)
	s.mu.Unlock()

	if s.queryErr != nil {
		return nil, s.queryErr
	}
	switch request.Pattern {
	case userPrefix:
		return &queryStatsResponse{Stats: s.users}, nil
	case inboundPrefix:
		return &queryStatsResponse{Stats: s.inbounds}, nil
	default:
		return &queryStatsResponse{}, nil
	}
}

func (s *recordingStats) GetSysStats(context.Context, *sysStatsRequest) (*sysStatsResponse, error) {
	if s.sysErr != nil {
		return nil, s.sysErr
	}
	return &sysStatsResponse{Uptime: s.uptime}, nil
}

var statsTestServiceDesc = grpc.ServiceDesc{
	ServiceName: statsServiceName,
	HandlerType: (*fakeStatsServer)(nil),
	Methods: []grpc.MethodDesc{
		{MethodName: "QueryStats", Handler: queryStatsTestHandler},
		{MethodName: "GetSysStats", Handler: getSysStatsTestHandler},
	},
}

func queryStatsTestHandler(service any, ctx context.Context, decode func(any) error, _ grpc.UnaryServerInterceptor) (any, error) {
	request := new(queryStatsRequest)
	if err := decode(request); err != nil {
		return nil, err
	}
	return service.(fakeStatsServer).QueryStats(ctx, request)
}

func getSysStatsTestHandler(service any, ctx context.Context, decode func(any) error, _ grpc.UnaryServerInterceptor) (any, error) {
	request := new(sysStatsRequest)
	if err := decode(request); err != nil {
		return nil, err
	}
	return service.(fakeStatsServer).GetSysStats(ctx, request)
}

func startStatsServer(t *testing.T, stats *recordingStats) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := grpc.NewServer(grpc.ForceServerCodec(statsCodec{}))
	server.RegisterService(&statsTestServiceDesc, stats)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	return listener.Addr().String()
}

func TestStatsClientReadsAndAggregates(t *testing.T) {
	stats := &recordingStats{
		users: []stat{
			{Name: "user>>>alice@example.com>>>traffic>>>uplink", Value: 10},
			{Name: "user>>>alice@example.com>>>traffic>>>downlink", Value: 20},
			{Name: "user>>>bob@example.com>>>traffic>>>downlink", Value: 5},
			{Name: "user>>>malformed", Value: 99},
		},
		inbounds: []stat{
			{Name: "inbound>>>api>>>traffic>>>uplink", Value: 1000},
			{Name: "inbound>>>proxy>>>traffic>>>uplink", Value: 7},
			{Name: "inbound>>>proxy>>>traffic>>>downlink", Value: 8},
		},
		uptime: 42,
	}
	target := startStatsServer(t, stats)
	client, err := NewStatsClient(target, WithCallTimeout(5*time.Second))
	if err != nil {
		t.Fatalf("NewStatsClient: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	ctx := context.Background()
	users, err := client.UserTraffic(ctx)
	if err != nil {
		t.Fatalf("UserTraffic: %v", err)
	}
	if len(users) != 2 {
		t.Fatalf("users = %+v, want alice and bob", users)
	}
	if users[0].Email != "alice@example.com" || users[0].UplinkBytes != 10 || users[0].DownlinkBytes != 20 {
		t.Errorf("users[0] = %+v, want alice 10/20", users[0])
	}
	if users[1].Email != "bob@example.com" || users[1].UplinkBytes != 0 || users[1].DownlinkBytes != 5 {
		t.Errorf("users[1] = %+v, want bob 0/5", users[1])
	}

	inbounds, err := client.InboundTraffic(ctx)
	if err != nil {
		t.Fatalf("InboundTraffic: %v", err)
	}
	if _, found := inbounds[APITag]; found {
		t.Errorf("api inbound must be excluded, got %+v", inbounds)
	}
	if got := inbounds["proxy"]; got.UplinkBytes != 7 || got.DownlinkBytes != 8 {
		t.Errorf("proxy inbound = %+v, want 7/8", got)
	}

	system, err := client.SysStats(ctx)
	if err != nil {
		t.Fatalf("SysStats: %v", err)
	}
	if system.UptimeSeconds != 42 {
		t.Errorf("uptime = %d, want 42", system.UptimeSeconds)
	}

	stats.mu.Lock()
	defer stats.mu.Unlock()
	for index, reset := range stats.resets {
		if reset {
			t.Errorf("query %d used reset=true; counters must never be reset", index)
		}
	}
	if len(stats.patterns) < 2 || stats.patterns[0] != userPrefix || stats.patterns[1] != inboundPrefix {
		t.Errorf("query patterns = %v, want [%q %q]", stats.patterns, userPrefix, inboundPrefix)
	}
}

func TestStatsClientReturnsServiceErrors(t *testing.T) {
	stats := &recordingStats{queryErr: errors.New("stats unavailable"), sysErr: errors.New("stats unavailable")}
	target := startStatsServer(t, stats)
	client, err := NewStatsClient(target, WithCallTimeout(5*time.Second))
	if err != nil {
		t.Fatalf("NewStatsClient: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	if _, err := client.UserTraffic(context.Background()); err == nil {
		t.Fatal("UserTraffic succeeded while StatsService returned an error")
	}
	if _, err := client.InboundTraffic(context.Background()); err == nil {
		t.Fatal("InboundTraffic succeeded while StatsService returned an error")
	}
	if _, err := client.SysStats(context.Background()); err == nil {
		t.Fatal("SysStats succeeded while StatsService returned an error")
	}
}

func TestStatsClientUnreachableAddress(t *testing.T) {
	// Grab a free port, then close it so nothing is listening.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := listener.Addr().String()
	_ = listener.Close()

	client, err := NewStatsClient(target, WithCallTimeout(150*time.Millisecond))
	if err != nil {
		t.Fatalf("NewStatsClient: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	if _, err := client.SysStats(context.Background()); err == nil {
		t.Fatal("SysStats succeeded against an unreachable address")
	}
}

func TestNewStatsClientRejectsInvalidTarget(t *testing.T) {
	for _, target := range []string{"", "127.0.0.1", "127.0.0.1:not-a-port", ":10085", "127.0.0.1:0"} {
		if _, err := NewStatsClient(target); err == nil {
			t.Errorf("NewStatsClient accepted target %q", target)
		}
	}
}

func TestDecodeResponseSkipsUnknownFields(t *testing.T) {
	var data []byte
	// An unknown varint field before the stat payload.
	data = protowire.AppendTag(data, 9, protowire.VarintType)
	data = protowire.AppendVarint(data, 123)

	var encodedStat []byte
	encodedStat = protowire.AppendTag(encodedStat, 1, protowire.BytesType)
	encodedStat = protowire.AppendString(encodedStat, "user>>>a>>>traffic>>>uplink")
	encodedStat = protowire.AppendTag(encodedStat, 2, protowire.VarintType)
	encodedStat = protowire.AppendVarint(encodedStat, 55)
	encodedStat = protowire.AppendTag(encodedStat, 7, protowire.BytesType)
	encodedStat = protowire.AppendString(encodedStat, "ignored")
	data = protowire.AppendTag(data, 1, protowire.BytesType)
	data = protowire.AppendBytes(data, encodedStat)

	var response queryStatsResponse
	if err := decodeQueryStatsResponse(data, &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(response.Stats) != 1 || response.Stats[0].Name != "user>>>a>>>traffic>>>uplink" || response.Stats[0].Value != 55 {
		t.Errorf("stats = %+v, want one stat with value 55", response.Stats)
	}
}

func TestDecodeSysStatsUptimeField10(t *testing.T) {
	var data []byte
	data = protowire.AppendTag(data, 1, protowire.VarintType)
	data = protowire.AppendVarint(data, 3)
	data = protowire.AppendTag(data, 10, protowire.VarintType)
	data = protowire.AppendVarint(data, 86400)

	var response sysStatsResponse
	if err := decodeSysStatsResponse(data, &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.Uptime != 86400 {
		t.Errorf("uptime = %d, want 86400", response.Uptime)
	}
}

func TestDecodeRejectsTruncatedPayload(t *testing.T) {
	var truncatedStat []byte
	truncatedStat = protowire.AppendTag(truncatedStat, 1, protowire.BytesType)
	truncatedStat = protowire.AppendVarint(truncatedStat, 10)
	truncatedStat = append(truncatedStat, []byte("ab")...)

	var response queryStatsResponse
	if err := decodeQueryStatsResponse(truncatedStat, &response); err == nil {
		t.Fatal("decode accepted a truncated stat payload")
	}

	var truncatedSys []byte
	truncatedSys = protowire.AppendTag(truncatedSys, 10, protowire.VarintType)
	truncatedSys = append(truncatedSys, 0x80)
	if err := decodeSysStatsResponse(truncatedSys, &sysStatsResponse{}); err == nil {
		t.Fatal("decode accepted a truncated sys stats payload")
	}
}

func TestParseStatKey(t *testing.T) {
	tests := []struct {
		name      string
		prefix    string
		entity    string
		direction string
		ok        bool
	}{
		{"user>>>a@b>>>traffic>>>uplink", userPrefix, "a@b", "uplink", true},
		{"user>>>a@b>>>traffic>>>downlink", userPrefix, "a@b", "downlink", true},
		{"inbound>>>proxy>>>traffic>>>uplink", inboundPrefix, "proxy", "uplink", true},
		{"user>>>a@b>>>traffic>>>other", userPrefix, "", "", false},
		{"user>>>>>>traffic>>>uplink", userPrefix, "", "", false},
		{"inbound>>>proxy", inboundPrefix, "", "", false},
		{"user>>>a@b", userPrefix, "", "", false},
		{"inbound>>>proxy>>>traffic", inboundPrefix, "", "", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			entity, direction, ok := parseStatKey(test.name, test.prefix)
			if ok != test.ok || entity != test.entity || direction != test.direction {
				t.Errorf("parseStatKey(%q) = (%q, %q, %v), want (%q, %q, %v)",
					test.name, entity, direction, ok, test.entity, test.direction, test.ok)
			}
		})
	}
}

func TestStatsCodecRejectsUnsupportedTypes(t *testing.T) {
	if _, err := (statsCodec{}).Marshal(struct{}{}); err == nil {
		t.Error("Marshal accepted an unsupported type")
	}
	if err := (statsCodec{}).Unmarshal(nil, struct{}{}); err == nil {
		t.Error("Unmarshal accepted an unsupported type")
	}
	if got := (statsCodec{}).Name(); !strings.Contains(got, "proto") {
		t.Errorf("codec name = %q, must select the proto content type", got)
	}
}
