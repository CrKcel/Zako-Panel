package xraycore

import (
	"bytes"
	"context"
	"encoding/hex"
	"testing"
)

const (
	testInboundTag = "vless-reality"
	testUUID       = "11111111-1111-1111-1111-111111111111"
	testEmail      = "u_1"
)

func encodeTestAddUser(t *testing.T, tag string, user User) []byte {
	t.Helper()
	account, err := encodeVlessAccount(&vlessAccount{ID: user.UUID, Flow: FlowVision})
	if err != nil {
		t.Fatalf("encodeVlessAccount: %v", err)
	}
	operation, err := encodeAddUserOperation(&addUserOperation{
		User: protocolUser{
			Level:   0,
			Email:   user.Email,
			Account: &typedMessage{Type: vlessAccountType, Value: account},
		},
	})
	if err != nil {
		t.Fatalf("encodeAddUserOperation: %v", err)
	}
	encoded, err := encodeAlterInboundRequest(&alterInboundRequest{
		Tag:       tag,
		Operation: &typedMessage{Type: addUserOperationType, Value: operation},
	})
	if err != nil {
		t.Fatalf("encodeAlterInboundRequest: %v", err)
	}
	return encoded
}

// The golden bytes pin the wire layout against Xray-core's protos. A reordered or
// renumbered field would otherwise only fail against a live Xray, where the mistake
// is a 500 from the API instead of a test failure.
func TestAlterInboundAddUserEncodesXrayWireFormat(t *testing.T) {
	encoded := encodeTestAddUser(t, testInboundTag, User{Email: testEmail, UUID: testUUID})
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
	encoded := encodeTestAddUser(t, testInboundTag, User{Email: testEmail, UUID: testUUID})

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
	encoded := encodeTestAddUser(t, testInboundTag, User{Email: testEmail, UUID: testUUID})
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
	client := &HandlerClient{tags: []string{testInboundTag}}
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
