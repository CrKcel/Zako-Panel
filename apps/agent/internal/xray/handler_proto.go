package xray

import (
	"fmt"

	"google.golang.org/protobuf/encoding/protowire"
)

// This file encodes the HandlerService.AlterInbound request so the agent can add
// and remove users without vendoring xray-core or running protoc. The field
// numbers were checked against Xray-core main (2026-11):
//
//	app/proxyman/command/command.proto:
//	  AlterInboundRequest { string tag = 1; xray.common.serial.TypedMessage operation = 2; }
//	  AddUserOperation    { xray.common.protocol.User user = 1; }
//	  RemoveUserOperation { string email = 1; }
//	common/serial/typed_message.proto:
//	  TypedMessage { string type = 1; bytes value = 2; }
//	common/protocol/user.proto:
//	  User { uint32 level = 1; string email = 2; xray.common.serial.TypedMessage account = 3; }
//	proxy/vless/account.proto:
//	  Account { string id = 1; string flow = 2; string encryption = 3; }
//
// The operation is a TypedMessage, not a protobuf oneof: Xray resolves the
// embedded message by its full protobuf name and rejects an unknown one. The type
// strings below are therefore part of the wire contract and must keep matching
// the upstream package paths.
const (
	handlerServiceName = "xray.app.proxyman.command.HandlerService"
	alterInboundMethod = "/" + handlerServiceName + "/AlterInbound"

	addUserOperationType    = "xray.proxyman.command.AddUserOperation"
	removeUserOperationType = "xray.proxyman.command.RemoveUserOperation"
	vlessAccountType        = "xray.proxy.vless.Account"
)

type typedMessage struct {
	Type  string
	Value []byte
}

type protocolUser struct {
	Level   uint32
	Email   string
	Account *typedMessage
}

type vlessAccount struct {
	ID         string
	Flow       string
	Encryption string
}

type addUserOperation struct {
	User protocolUser
}

type removeUserOperation struct {
	Email string
}

type alterInboundRequest struct {
	Tag       string
	Operation *typedMessage
}

// alterInboundResponse is empty on the wire; the codec only needs a target value
// so grpc can hand the empty body back.
type alterInboundResponse struct{}

func encodeAlterInboundRequest(request *alterInboundRequest) ([]byte, error) {
	var out []byte
	if request.Tag == "" {
		return nil, fmt.Errorf("alter inbound: tag is required")
	}
	out = appendStringField(out, 1, request.Tag)
	if request.Operation == nil {
		return nil, fmt.Errorf("alter inbound: operation is required")
	}
	encoded, err := encodeTypedMessage(request.Operation)
	if err != nil {
		return nil, err
	}
	out = appendBytesField(out, 2, encoded)
	return out, nil
}

func encodeTypedMessage(message *typedMessage) ([]byte, error) {
	if message.Type == "" {
		return nil, fmt.Errorf("typed message: type is required")
	}
	var out []byte
	out = appendStringField(out, 1, message.Type)
	if len(message.Value) > 0 {
		out = appendBytesField(out, 2, message.Value)
	}
	return out, nil
}

func encodeAddUserOperation(operation *addUserOperation) ([]byte, error) {
	encoded, err := encodeProtocolUser(&operation.User)
	if err != nil {
		return nil, err
	}
	var out []byte
	out = appendBytesField(out, 1, encoded)
	return out, nil
}

func encodeRemoveUserOperation(operation *removeUserOperation) ([]byte, error) {
	if operation.Email == "" {
		return nil, fmt.Errorf("remove user: email is required")
	}
	var out []byte
	out = appendStringField(out, 1, operation.Email)
	return out, nil
}

func encodeProtocolUser(user *protocolUser) ([]byte, error) {
	if user.Email == "" {
		return nil, fmt.Errorf("protocol user: email is required")
	}
	var out []byte
	// Level 0 is the proto3 default, so it is omitted exactly as a generated
	// marshaller would.
	if user.Level != 0 {
		out = protowire.AppendTag(out, 1, protowire.VarintType)
		out = protowire.AppendVarint(out, uint64(user.Level))
	}
	out = appendStringField(out, 2, user.Email)
	if user.Account == nil {
		return nil, fmt.Errorf("protocol user: account is required")
	}
	encoded, err := encodeTypedMessage(user.Account)
	if err != nil {
		return nil, err
	}
	out = appendBytesField(out, 3, encoded)
	return out, nil
}

func encodeVlessAccount(account *vlessAccount) ([]byte, error) {
	if account.ID == "" {
		return nil, fmt.Errorf("vless account: id is required")
	}
	var out []byte
	out = appendStringField(out, 1, account.ID)
	if account.Flow != "" {
		out = appendStringField(out, 2, account.Flow)
	}
	if account.Encryption != "" {
		out = appendStringField(out, 3, account.Encryption)
	}
	return out, nil
}

func decodeAlterInboundRequest(data []byte, request *alterInboundRequest) error {
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return fmt.Errorf("alter inbound request: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		switch {
		case number == 1 && wireType == protowire.BytesType:
			value, consumed := protowire.ConsumeString(data)
			if consumed < 0 {
				return fmt.Errorf("alter inbound request: consume tag: %w", protowire.ParseError(consumed))
			}
			request.Tag = value
			data = data[consumed:]
		case number == 2 && wireType == protowire.BytesType:
			raw, consumed := protowire.ConsumeBytes(data)
			if consumed < 0 {
				return fmt.Errorf("alter inbound request: consume operation: %w", protowire.ParseError(consumed))
			}
			message := &typedMessage{}
			if err := decodeTypedMessage(raw, message); err != nil {
				return err
			}
			request.Operation = message
			data = data[consumed:]
		default:
			consumed := protowire.ConsumeFieldValue(number, wireType, data)
			if consumed < 0 {
				return fmt.Errorf("alter inbound request: skip field %d: %w", number, protowire.ParseError(consumed))
			}
			data = data[consumed:]
		}
	}
	return nil
}

func decodeTypedMessage(data []byte, message *typedMessage) error {
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return fmt.Errorf("typed message: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		switch {
		case number == 1 && wireType == protowire.BytesType:
			value, consumed := protowire.ConsumeString(data)
			if consumed < 0 {
				return fmt.Errorf("typed message: consume type: %w", protowire.ParseError(consumed))
			}
			message.Type = value
			data = data[consumed:]
		case number == 2 && wireType == protowire.BytesType:
			value, consumed := protowire.ConsumeBytes(data)
			if consumed < 0 {
				return fmt.Errorf("typed message: consume value: %w", protowire.ParseError(consumed))
			}
			message.Value = append([]byte(nil), value...)
			data = data[consumed:]
		default:
			consumed := protowire.ConsumeFieldValue(number, wireType, data)
			if consumed < 0 {
				return fmt.Errorf("typed message: skip field %d: %w", number, protowire.ParseError(consumed))
			}
			data = data[consumed:]
		}
	}
	return nil
}

func decodeAddUserOperation(data []byte, operation *addUserOperation) error {
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return fmt.Errorf("add user operation: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		if number == 1 && wireType == protowire.BytesType {
			raw, consumed := protowire.ConsumeBytes(data)
			if consumed < 0 {
				return fmt.Errorf("add user operation: consume user: %w", protowire.ParseError(consumed))
			}
			if err := decodeProtocolUser(raw, &operation.User); err != nil {
				return err
			}
			data = data[consumed:]
			continue
		}

		consumed := protowire.ConsumeFieldValue(number, wireType, data)
		if consumed < 0 {
			return fmt.Errorf("add user operation: skip field %d: %w", number, protowire.ParseError(consumed))
		}
		data = data[consumed:]
	}
	return nil
}

func decodeRemoveUserOperation(data []byte, operation *removeUserOperation) error {
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return fmt.Errorf("remove user operation: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		if number == 1 && wireType == protowire.BytesType {
			value, consumed := protowire.ConsumeString(data)
			if consumed < 0 {
				return fmt.Errorf("remove user operation: consume email: %w", protowire.ParseError(consumed))
			}
			operation.Email = value
			data = data[consumed:]
			continue
		}

		consumed := protowire.ConsumeFieldValue(number, wireType, data)
		if consumed < 0 {
			return fmt.Errorf("remove user operation: skip field %d: %w", number, protowire.ParseError(consumed))
		}
		data = data[consumed:]
	}
	return nil
}

func decodeProtocolUser(data []byte, user *protocolUser) error {
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return fmt.Errorf("protocol user: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		switch {
		case number == 1 && wireType == protowire.VarintType:
			value, consumed := protowire.ConsumeVarint(data)
			if consumed < 0 {
				return fmt.Errorf("protocol user: consume level: %w", protowire.ParseError(consumed))
			}
			user.Level = uint32(value)
			data = data[consumed:]
		case number == 2 && wireType == protowire.BytesType:
			value, consumed := protowire.ConsumeString(data)
			if consumed < 0 {
				return fmt.Errorf("protocol user: consume email: %w", protowire.ParseError(consumed))
			}
			user.Email = value
			data = data[consumed:]
		case number == 3 && wireType == protowire.BytesType:
			raw, consumed := protowire.ConsumeBytes(data)
			if consumed < 0 {
				return fmt.Errorf("protocol user: consume account: %w", protowire.ParseError(consumed))
			}
			message := &typedMessage{}
			if err := decodeTypedMessage(raw, message); err != nil {
				return err
			}
			user.Account = message
			data = data[consumed:]
		default:
			consumed := protowire.ConsumeFieldValue(number, wireType, data)
			if consumed < 0 {
				return fmt.Errorf("protocol user: skip field %d: %w", number, protowire.ParseError(consumed))
			}
			data = data[consumed:]
		}
	}
	return nil
}

func decodeVlessAccount(data []byte, account *vlessAccount) error {
	for len(data) > 0 {
		number, wireType, length := protowire.ConsumeTag(data)
		if length < 0 {
			return fmt.Errorf("vless account: consume tag: %w", protowire.ParseError(length))
		}
		data = data[length:]

		if wireType == protowire.BytesType && number >= 1 && number <= 3 {
			value, consumed := protowire.ConsumeString(data)
			if consumed < 0 {
				return fmt.Errorf("vless account: consume field %d: %w", number, protowire.ParseError(consumed))
			}
			switch number {
			case 1:
				account.ID = value
			case 2:
				account.Flow = value
			case 3:
				account.Encryption = value
			}
			data = data[consumed:]
			continue
		}

		consumed := protowire.ConsumeFieldValue(number, wireType, data)
		if consumed < 0 {
			return fmt.Errorf("vless account: skip field %d: %w", number, protowire.ParseError(consumed))
		}
		data = data[consumed:]
	}
	return nil
}

func appendStringField(out []byte, number protowire.Number, value string) []byte {
	out = protowire.AppendTag(out, number, protowire.BytesType)
	return protowire.AppendString(out, value)
}

func appendBytesField(out []byte, number protowire.Number, value []byte) []byte {
	out = protowire.AppendTag(out, number, protowire.BytesType)
	return protowire.AppendBytes(out, value)
}

// handlerCodec marshals only the messages above. Its name is "proto" so the call
// carries the content type Xray expects; grpc.ForceCodec bypasses the registry
// lookup, so no generated proto.Message implementation is needed.
type handlerCodec struct{}

func (handlerCodec) Name() string { return "proto" }

func (handlerCodec) Marshal(value any) ([]byte, error) {
	switch message := value.(type) {
	case *alterInboundRequest:
		return encodeAlterInboundRequest(message)
	case *alterInboundResponse:
		return nil, nil
	default:
		return nil, fmt.Errorf("xray handler codec: cannot marshal %T", value)
	}
}

func (handlerCodec) Unmarshal(data []byte, value any) error {
	switch message := value.(type) {
	case *alterInboundRequest:
		return decodeAlterInboundRequest(data, message)
	case *alterInboundResponse:
		return nil
	default:
		return fmt.Errorf("xray handler codec: cannot unmarshal into %T", value)
	}
}
