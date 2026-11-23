package xraycore

import (
	"bytes"
	"context"
	"encoding/hex"
	"strings"
	"testing"
)

const (
	testInboundTag = "vless-reality"
	testUUID       = "11111111-1111-1111-1111-111111111111"
	testEmail      = "u_1"
)

func vlessTarget() InboundTarget {
	return InboundTarget{Tag: testInboundTag, Protocol: ProtocolVlessReality}
}

func encodeTestAddUser(t *testing.T, user User) []byte {
	t.Helper()
	request, err := encodeAddUserRequest(vlessTarget(), user)
	if err != nil {
		t.Fatalf("encodeAddUserRequest: %v", err)
	}
	encoded, err := encodeAlterInboundRequest(request)
	if err != nil {
		t.Fatalf("encodeAlterInboundRequest: %v", err)
	}
	return encoded
}

// The golden bytes pin the wire layout against Xray-core's protos. A reordered or
// renumbered field would otherwise only fail against a live Xray, where the mistake
// is a 500 from the API instead of a test failure.
func TestAlterInboundAddUserEncodesXrayWireFormat(t *testing.T) {
	encoded := encodeTestAddUser(t, User{Email: testEmail, UUID: testUUID})
	// AlterInboundRequest{tag="vless-reality", operation=TypedMessage{
	// type="xray.app.proxyman.command.AddUserOperation",
	// value=AddUserOperation{user=User{email="u_1", account=TypedMessage{
	// type="xray.proxy.vless.Account",
	// value=Account{id=<uuid>, flow="xtls-rprx-vision"}}}}}}
	const golden = "0a0d766c6573732d7265616c697479128b010a2a787261792e6170702e70726f78796d616e2e" +
		"636f6d6d616e642e416464557365724f7065726174696f6e125d0a5b1203755f311a" +
		"540a18787261792e70726f78792e766c6573732e4163636f756e7412380a2431313131" +
		"313131312d313131312d313131312d313131312d3131313131313131313131311210" +
		"78746c732d727072782d766973696f6e"
	if got := hex.EncodeToString(encoded); got != golden {
		t.Fatalf("add user request = %s, want %s", got, golden)
	}
}

// Each managed protocol stores the node-client secret in its own account message.
// The account bytes are asserted per protocol: a wrong typed-message name or field
// number is rejected by Xray at call time and cannot be caught by a decode alone.
func TestAddUserRequestEncodesAccountPerProtocol(t *testing.T) {
	cases := []struct {
		name     string
		target   InboundTarget
		wantType string
		check    func(t *testing.T, account *typedMessage)
	}{
		{
			name:     "vless",
			target:   vlessTarget(),
			wantType: vlessAccountType,
			check: func(t *testing.T, account *typedMessage) {
				var decoded vlessAccount
				if err := decodeVlessAccount(account.Value, &decoded); err != nil {
					t.Fatalf("decode vless account: %v", err)
				}
				if decoded.ID != testUUID || decoded.Flow != FlowVision {
					t.Errorf("vless account = %+v, want the uuid with the vision flow", decoded)
				}
			},
		},
		{
			name:     "vmess",
			target:   InboundTarget{Tag: "vmess-ws", Protocol: ProtocolVmess},
			wantType: vmessAccountType,
			check: func(t *testing.T, account *typedMessage) {
				var decoded vmessAccount
				if err := decodeVmessAccount(account.Value, &decoded); err != nil {
					t.Fatalf("decode vmess account: %v", err)
				}
				if decoded.ID != testUUID {
					t.Errorf("vmess account = %+v, want the uuid", decoded)
				}
				// The account carries the id alone: alterId is fixed at 0, which was
				// the proto3 default before Xray dropped the field.
				if got, want := hex.EncodeToString(account.Value), "0a24"+hex.EncodeToString([]byte(testUUID)); got != want {
					t.Errorf("vmess account bytes = %s, want %s", got, want)
				}
			},
		},
		{
			name:     "trojan",
			target:   InboundTarget{Tag: "trojan-grpc", Protocol: ProtocolTrojan},
			wantType: trojanAccountType,
			check: func(t *testing.T, account *typedMessage) {
				var decoded trojanAccount
				if err := decodeTrojanAccount(account.Value, &decoded); err != nil {
					t.Fatalf("decode trojan account: %v", err)
				}
				if decoded.Password != testUUID {
					t.Errorf("trojan account = %+v, want the secret verbatim as password", decoded)
				}
			},
		},
		{
			name:     "shadowsocks",
			target:   InboundTarget{Tag: "ss-gcm", Protocol: ProtocolShadowsocks, Method: "aes-256-gcm"},
			wantType: shadowsocksAccountType,
			check: func(t *testing.T, account *typedMessage) {
				var decoded shadowsocksAccount
				if err := decodeShadowsocksAccount(account.Value, &decoded); err != nil {
					t.Fatalf("decode shadowsocks account: %v", err)
				}
				if decoded.Password != testUUID || decoded.Cipher != shadowsocksCipherAES256GCM {
					t.Errorf("shadowsocks account = %+v, want password with the aes-256-gcm cipher", decoded)
				}
				// The cipher enum is a varint field 2: the panel method name alone
				// carries no wire meaning, so the enum value is part of the contract.
				if got, want := hex.EncodeToString(account.Value), "0a24"+hex.EncodeToString([]byte(testUUID))+"1006"; got != want {
					t.Errorf("shadowsocks account bytes = %s, want %s", got, want)
				}
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request, err := encodeAddUserRequest(testCase.target, User{Email: testEmail, UUID: testUUID})
			if err != nil {
				t.Fatalf("encodeAddUserRequest: %v", err)
			}
			wire, err := encodeAlterInboundRequest(request)
			if err != nil {
				t.Fatalf("encodeAlterInboundRequest: %v", err)
			}
			var decoded alterInboundRequest
			if err := decodeAlterInboundRequest(wire, &decoded); err != nil {
				t.Fatalf("decodeAlterInboundRequest: %v", err)
			}
			if decoded.Tag != testCase.target.Tag {
				t.Errorf("tag = %q, want %q", decoded.Tag, testCase.target.Tag)
			}
			if decoded.Operation == nil || decoded.Operation.Type != addUserOperationType {
				t.Fatalf("operation = %+v, want %s", decoded.Operation, addUserOperationType)
			}
			var operation addUserOperation
			if err := decodeAddUserOperation(decoded.Operation.Value, &operation); err != nil {
				t.Fatalf("decodeAddUserOperation: %v", err)
			}
			if operation.User.Email != testEmail || operation.User.Level != 0 {
				t.Errorf("user = %+v, want email %q at level 0", operation.User, testEmail)
			}
			if operation.User.Account == nil || operation.User.Account.Type != testCase.wantType {
				t.Fatalf("account type = %+v, want %s", operation.User.Account, testCase.wantType)
			}
			testCase.check(t, operation.User.Account)
		})
	}
}

// An unknown protocol or cipher must fail before any RPC so the syncer falls back
// to the config-restart path instead of leaving the running inbound half-updated.
func TestAddUserRequestRejectsUnsupportedTargets(t *testing.T) {
	cases := map[string]InboundTarget{
		"unknown protocol":      {Tag: "mystery", Protocol: "hysteria2"},
		"unresolved protocol":   {Tag: "vless-reality"},
		"unsupported ss method": {Tag: "ss-2022", Protocol: ProtocolShadowsocks, Method: "2022-blake3-aes-128-gcm"},
		"missing ss method":     {Tag: "ss", Protocol: ProtocolShadowsocks},
	}
	for name, target := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := encodeAddUserRequest(target, User{Email: testEmail, UUID: testUUID}); err == nil {
				t.Fatalf("encodeAddUserRequest accepted %s", name)
			}
		})
	}
}

func TestAlterInboundRemoveUserEncodesXrayWireFormat(t *testing.T) {
	operation, err := encodeRemoveUserOperation(&removeUserOperation{Email: testEmail})
	if err != nil {
		t.Fatalf("encodeRemoveUserOperation: %v", err)
	}
	encoded, err := encodeAlterInboundRequest(&alterInboundRequest{
		Tag:       testInboundTag,
		Operation: &typedMessage{Type: removeUserOperationType, Value: operation},
	})
	if err != nil {
		t.Fatalf("encodeAlterInboundRequest: %v", err)
	}
	const golden = "0a0d766c6573732d7265616c69747912360a2d787261792e6170702e70726f78796d616e2e" +
		"636f6d6d616e642e52656d6f7665557365724f7065726174696f6e12050a03755f31"
	if got := hex.EncodeToString(encoded); got != golden {
		t.Fatalf("remove user request = %s, want %s", got, golden)
	}
}

func TestAlterInboundAddUserRoundTrip(t *testing.T) {
	encoded := encodeTestAddUser(t, User{Email: testEmail, UUID: testUUID})

	var request alterInboundRequest
	if err := decodeAlterInboundRequest(encoded, &request); err != nil {
		t.Fatalf("decodeAlterInboundRequest: %v", err)
	}
	if request.Tag != testInboundTag {
		t.Errorf("tag = %q, want %q", request.Tag, testInboundTag)
	}
	if request.Operation == nil || request.Operation.Type != addUserOperationType {
		t.Fatalf("operation = %+v, want %s", request.Operation, addUserOperationType)
	}

	var operation addUserOperation
	if err := decodeAddUserOperation(request.Operation.Value, &operation); err != nil {
		t.Fatalf("decodeAddUserOperation: %v", err)
	}
	if operation.User.Email != testEmail || operation.User.Level != 0 {
		t.Errorf("user = %+v, want email %q at level 0", operation.User, testEmail)
	}
	if operation.User.Account == nil || operation.User.Account.Type != vlessAccountType {
		t.Fatalf("account = %+v, want %s", operation.User.Account, vlessAccountType)
	}

	var account vlessAccount
	if err := decodeVlessAccount(operation.User.Account.Value, &account); err != nil {
		t.Fatalf("decodeVlessAccount: %v", err)
	}
	if account.ID != testUUID || account.Flow != FlowVision {
		t.Errorf("account = %+v, want uuid %q with flow %q", account, testUUID, FlowVision)
	}
}

func TestAlterInboundUnknownFieldsAreSkipped(t *testing.T) {
	encoded := encodeTestAddUser(t, User{Email: testEmail, UUID: testUUID})
	// A future Xray may append fields; the client must keep decoding the ones it
	// knows instead of failing the call.
	encoded = append(encoded, 0x18, 0x01)
	var request alterInboundRequest
	if err := decodeAlterInboundRequest(encoded, &request); err != nil {
		t.Fatalf("decodeAlterInboundRequest with unknown field: %v", err)
	}
	if request.Tag != testInboundTag {
		t.Errorf("tag = %q, want %q", request.Tag, testInboundTag)
	}
}

func TestHandlerCodecRoundTripsAlterInbound(t *testing.T) {
	request := &alterInboundRequest{Tag: testInboundTag, Operation: &typedMessage{
		Type:  removeUserOperationType,
		Value: []byte{0x0a, 0x03, 'u', '_', '1'},
	}}
	codec := handlerCodec{}
	encoded, err := codec.Marshal(request)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	decoded := &alterInboundRequest{}
	if err := codec.Unmarshal(encoded, decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.Tag != request.Tag || decoded.Operation.Type != request.Operation.Type ||
		!bytes.Equal(decoded.Operation.Value, request.Operation.Value) {
		t.Errorf("round trip = %+v, want %+v", decoded, request)
	}
}

func TestHandlerClientRejectsIncompleteUsers(t *testing.T) {
	client := &HandlerClient{targets: []InboundTarget{vlessTarget()}}
	if err := client.AddUser(context.Background(), User{Email: testEmail}); err == nil {
		t.Error("AddUser accepted a user without a UUID")
	}
	if err := client.AddUser(context.Background(), User{UUID: testUUID}); err == nil {
		t.Error("AddUser accepted a user without an email")
	}
	if err := client.RemoveUser(context.Background(), ""); err == nil {
		t.Error("RemoveUser accepted an empty email")
	}
	if err := client.AddUser(context.Background(), User{Email: testEmail, UUID: testUUID}); err == nil {
		t.Error("AddUser succeeded on a client without a connection")
	}
}

// NewHandlerClient only knows the initial tag from the agent config; the protocol
// arrives with the first syncer refresh. A user applied before that refresh must
// fail so the syncer converges through the config-restart path instead of sending
// an account Xray cannot resolve.
func TestHandlerClientAddUserFailsBeforeTargetRefresh(t *testing.T) {
	client, err := NewHandlerClient("127.0.0.1:10085", testInboundTag)
	if err != nil {
		t.Fatalf("NewHandlerClient: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	targets := client.InboundTargets()
	if len(targets) != 1 || targets[0].Tag != testInboundTag || targets[0].Protocol != "" {
		t.Fatalf("targets = %+v, want the initial tag without a protocol", targets)
	}
	err = client.AddUser(context.Background(), User{Email: testEmail, UUID: testUUID})
	if err == nil {
		t.Fatal("AddUser succeeded before the protocol was refreshed")
	}
	if !strings.Contains(err.Error(), "unknown inbound protocol") {
		t.Errorf("AddUser error = %v, want an unknown protocol failure", err)
	}
}

func TestHandlerClientTargetsAreNormalized(t *testing.T) {
	client := &HandlerClient{}
	err := client.SetInboundTargets([]InboundTarget{
		{Tag: " a ", Protocol: ProtocolVmess},
		{Tag: "", Protocol: ProtocolTrojan},
		{Tag: "a", Protocol: ProtocolShadowsocks, Method: "aes-256-gcm"},
	})
	if err != nil {
		t.Fatalf("SetInboundTargets: %v", err)
	}
	targets := client.InboundTargets()
	if len(targets) != 1 || targets[0].Tag != "a" || targets[0].Protocol != ProtocolVmess {
		t.Errorf("targets = %+v, want the first entry only", targets)
	}

	if err := client.SetInboundTargets(nil); err == nil {
		t.Error("SetInboundTargets accepted an empty target list")
	}
}
