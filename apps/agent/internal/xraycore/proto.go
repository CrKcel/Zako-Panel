package xraycore

import (
	"fmt"
	"strings"

	"google.golang.org/protobuf/encoding/protowire"
)

// This file contains the minimal Xray StatsService protobuf so the agent does not
// depend on xray-core or a generated protoc output. Only the fields the collector
// reads are encoded; unknown response fields are skipped by the protowire walker,
// which keeps the client compatible with future Xray releases (docs/traffic.md §1).
//
// Wire layout of xray.app.stats.command (Xray v1.x):
//
//	QueryStatsRequest  { string pattern = 1; bool reset = 2; string regexp = 3; }
//	QueryStatsResponse { repeated Stat stat = 1; }
//	SysStatsRequest    {}
//	SysStatsResponse   { ...; uint32 uptime = 10; }
//	Stat               { string name = 1; int64 value = 2; }
const (
	statsServiceName = "xray.app.stats.command.StatsService"
	queryStatsMethod = "/" + statsServiceName + "/QueryStats"
	getSysStats      = "/" + statsServiceName + "/GetSysStats"

	// APITag is the loopback API inbound tag from docs/traffic.md §1. Its
	// counters describe Agent/Xray control traffic and are never billed.
	APITag = "api"

	statUplink    = "uplink"
	statDownlink  = "downlink"
	statTraffic   = "traffic"
	userPrefix    = "user>>>"
	inboundPrefix = "inbound>>>"
)

// stat is one entry of QueryStatsResponse.
type stat struct {
	Name  string
	Value int64
}

type queryStatsRequest struct {
	Pattern string
	// Reset is always false: resetting counters destroys the delta accounting
	// that must survive an agent restart.
	Reset bool
}

type queryStatsResponse struct {
	Stats []stat
}

type sysStatsRequest struct{}

type sysStatsResponse struct {
	// Uptime is field 10. Other fields are intentionally not decoded.
	Uptime uint32
}

func encodeQueryStatsRequest(request *queryStatsRequest) []byte {
	var out []byte
	if request.Pattern != "" {
		out = protowire.AppendTag(out, 1, protowire.BytesType)
		out = protowire.AppendString(out, request.Pattern)
	}
	if request.Reset {
		out = protowire.AppendTag(out, 2, protowire.VarintType)
		out = protowire.AppendVarint(out, 1)
	}
	return out
}

func decodeQueryStatsResponse(data []byte, response *queryStatsResponse) error {
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return fmt.Errorf("stats response: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		if number == 1 && wireType == protowire.BytesType {
			raw, consumed := protowire.ConsumeBytes(data)
			if consumed < 0 {
				return fmt.Errorf("stats response: consume stat: %w", protowire.ParseError(consumed))
			}
			parsed, err := decodeStat(raw)
			if err != nil {
				return err
			}
			response.Stats = append(response.Stats, parsed)
			data = data[consumed:]
			continue
		}

		consumed := protowire.ConsumeFieldValue(number, wireType, data)
		if consumed < 0 {
			return fmt.Errorf("stats response: skip field %d: %w", number, protowire.ParseError(consumed))
		}
		data = data[consumed:]
	}
	return nil
}

func decodeStat(data []byte) (stat, error) {
	var parsed stat
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return stat{}, fmt.Errorf("stat: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		switch {
		case number == 1 && wireType == protowire.BytesType:
			value, consumed := protowire.ConsumeString(data)
			if consumed < 0 {
				return stat{}, fmt.Errorf("stat: consume name: %w", protowire.ParseError(consumed))
			}
			parsed.Name = value
			data = data[consumed:]
		case number == 2 && wireType == protowire.VarintType:
			value, consumed := protowire.ConsumeVarint(data)
			if consumed < 0 {
				return stat{}, fmt.Errorf("stat: consume value: %w", protowire.ParseError(consumed))
			}
			parsed.Value = int64(value)
			data = data[consumed:]
		default:
			consumed := protowire.ConsumeFieldValue(number, wireType, data)
			if consumed < 0 {
				return stat{}, fmt.Errorf("stat: skip field %d: %w", number, protowire.ParseError(consumed))
			}
			data = data[consumed:]
		}
	}
	return parsed, nil
}

func decodeQueryStatsRequest(data []byte, request *queryStatsRequest) error {
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return fmt.Errorf("stats request: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		switch {
		case number == 1 && wireType == protowire.BytesType:
			value, consumed := protowire.ConsumeString(data)
			if consumed < 0 {
				return fmt.Errorf("stats request: consume pattern: %w", protowire.ParseError(consumed))
			}
			request.Pattern = value
			data = data[consumed:]
		case number == 2 && wireType == protowire.VarintType:
			value, consumed := protowire.ConsumeVarint(data)
			if consumed < 0 {
				return fmt.Errorf("stats request: consume reset: %w", protowire.ParseError(consumed))
			}
			request.Reset = value != 0
			data = data[consumed:]
		default:
			consumed := protowire.ConsumeFieldValue(number, wireType, data)
			if consumed < 0 {
				return fmt.Errorf("stats request: skip field %d: %w", number, protowire.ParseError(consumed))
			}
			data = data[consumed:]
		}
	}
	return nil
}

func encodeQueryStatsResponse(response *queryStatsResponse) []byte {
	var out []byte
	for _, entry := range response.Stats {
		var encoded []byte
		encoded = protowire.AppendTag(encoded, 1, protowire.BytesType)
		encoded = protowire.AppendString(encoded, entry.Name)
		encoded = protowire.AppendTag(encoded, 2, protowire.VarintType)
		encoded = protowire.AppendVarint(encoded, uint64(entry.Value))
		out = protowire.AppendTag(out, 1, protowire.BytesType)
		out = protowire.AppendBytes(out, encoded)
	}
	return out
}

func encodeSysStatsResponse(response *sysStatsResponse) []byte {
	var out []byte
	out = protowire.AppendTag(out, 10, protowire.VarintType)
	out = protowire.AppendVarint(out, uint64(response.Uptime))
	return out
}

func decodeSysStatsResponse(data []byte, response *sysStatsResponse) error {
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return fmt.Errorf("sys stats response: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		if number == 10 && wireType == protowire.VarintType {
			value, consumed := protowire.ConsumeVarint(data)
			if consumed < 0 {
				return fmt.Errorf("sys stats response: consume uptime: %w", protowire.ParseError(consumed))
			}
			response.Uptime = uint32(value)
			data = data[consumed:]
			continue
		}

		consumed := protowire.ConsumeFieldValue(number, wireType, data)
		if consumed < 0 {
			return fmt.Errorf("sys stats response: skip field %d: %w", number, protowire.ParseError(consumed))
		}
		data = data[consumed:]
	}
	return nil
}

// statsCodec marshals only the message types above. Its name is "proto" so the
// call carries the content-type Xray expects; grpc.ForceCodec bypasses the
// registry lookup, so no generated proto.Message implementation is needed.
type statsCodec struct{}

func (statsCodec) Name() string { return "proto" }

func (statsCodec) Marshal(value any) ([]byte, error) {
	switch message := value.(type) {
	case *queryStatsRequest:
		return encodeQueryStatsRequest(message), nil
	case *queryStatsResponse:
		return encodeQueryStatsResponse(message), nil
	case *sysStatsRequest:
		return nil, nil
	case *sysStatsResponse:
		return encodeSysStatsResponse(message), nil
	default:
		return nil, fmt.Errorf("xray stats codec: cannot marshal %T", value)
	}
}

func (statsCodec) Unmarshal(data []byte, value any) error {
	switch message := value.(type) {
	case *queryStatsRequest:
		return decodeQueryStatsRequest(data, message)
	case *queryStatsResponse:
		return decodeQueryStatsResponse(data, message)
	case *sysStatsRequest:
		return nil
	case *sysStatsResponse:
		return decodeSysStatsResponse(data, message)
	default:
		return fmt.Errorf("xray stats codec: cannot unmarshal into %T", value)
	}
}

const tokenSeparator = ">>>"

// parseUserStat splits user>>>EMAIL>>>traffic>>>uplink|downlink.
func parseUserStat(name string) (email, direction string, ok bool) {
	return parseStatKey(name, userPrefix)
}

// parseInboundStat splits inbound>>>TAG>>>traffic>>>uplink|downlink.
func parseInboundStat(name string) (tag, direction string, ok bool) {
	return parseStatKey(name, inboundPrefix)
}

// parseStatKey decodes the shared "<scope>>>>ENTITY>>>traffic>>>DIRECTION"
// shape. Malformed keys are ignored: patterns are advisory and an unknown key
// must not fail the whole sample.
func parseStatKey(name, prefix string) (entity, direction string, ok bool) {
	if !strings.HasPrefix(name, prefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(name, prefix)
	index := strings.Index(rest, tokenSeparator)
	if index <= 0 {
		return "", "", false
	}
	entity = rest[:index]
	tail := rest[index+len(tokenSeparator):]
	direction, found := strings.CutPrefix(tail, statTraffic+tokenSeparator)
	if !found {
		return "", "", false
	}
	switch direction {
	case statUplink, statDownlink:
		return entity, direction, true
	default:
		return "", "", false
	}
}
