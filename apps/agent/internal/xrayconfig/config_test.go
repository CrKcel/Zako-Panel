package xrayconfig

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/zako-panel/zako-agent/internal/xraycore"
)

const staticConfig = `{
  "log": {"loglevel": "warning"},
  "stats": {},
  "api": {"tag": "api", "services": ["StatsService", "HandlerService"]},
  "inbounds": [
    {
      "tag": "api",
      "listen": "127.0.0.1",
      "port": 10085,
      "protocol": "dokodemo-door",
      "settings": {"address": "127.0.0.1"}
    },
    {
      "tag": "vless-reality",
      "listen": "0.0.0.0",
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [{"id": "old-uuid", "flow": "xtls-rprx-vision", "email": "old", "level": 0}],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {"dest": "example.com:443", "serverNames": ["example.com"]}
      }
    }
  ],
  "outbounds": [{"protocol": "freedom", "tag": "direct"}]
}`

// multiProtocolConfig carries one managed inbound per protocol plus inbounds the
// panel does not own, so a render can be checked for both account shapes and
// byte-identical leftovers.
const multiProtocolConfig = `{
  "stats": {},
  "api": {"tag": "api", "services": ["StatsService", "HandlerService"]},
  "inbounds": [
    {"tag": "api", "listen": "127.0.0.1", "port": 10085, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1"}},
    {"tag": "vless-reality", "port": 443, "protocol": "vless",
     "settings": {"clients": [{"id": "stale", "flow": "xtls-rprx-vision", "email": "stale", "level": 0}], "decryption": "none"},
     "streamSettings": {"network": "tcp", "security": "reality",
       "realitySettings": {"dest": "cdn.example.com:443", "serverNames": ["cdn.example.com"],
         "privateKey": "pinned-key", "shortIds": ["aabb"]}}},
    {"tag": "vmess-ws", "port": 8443, "protocol": "vmess",
     "settings": {"clients": []},
     "streamSettings": {"network": "ws", "security": "tls",
       "tlsSettings": {"serverNames": ["cdn.example.com"]},
       "wsSettings": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}}},
    {"tag": "trojan-grpc", "port": 9000, "protocol": "trojan",
     "settings": {"clients": []},
     "streamSettings": {"network": "grpc", "security": "tls",
       "tlsSettings": {"serverName": "www.example.com"},
       "grpcSettings": {"serviceName": "trojan-grpc"}}},
    {"tag": "ss-gcm", "port": 9001, "protocol": "shadowsocks",
     "settings": {"method": "aes-256-gcm", "clients": []}},
    {"tag": "vless-tls", "port": 9443, "protocol": "vless",
     "settings": {"clients": [{"id": "keep-me", "email": "operator", "level": 0}]},
     "streamSettings": {"network": "tcp", "security": "tls", "tlsSettings": {"serverNames": ["keep.example.com"]}}}
  ]
}`

func decodeDocument(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("decode rendered config: %v", err)
	}
	return document
}

func inboundByTag(t *testing.T, document map[string]any, tag string) map[string]any {
	t.Helper()
	inbounds, ok := document["inbounds"].([]any)
	if !ok {
		t.Fatalf("inbounds = %T, want array", document["inbounds"])
	}
	for _, raw := range inbounds {
		inbound, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if name, _ := inbound["tag"].(string); name == tag {
			return inbound
		}
	}
	t.Fatalf("inbound %q is missing", tag)
	return nil
}

// clientsOf returns the decoded settings.clients of one inbound.
func clientsOf(t *testing.T, inbound map[string]any) []map[string]any {
	t.Helper()
	settings, ok := inbound["settings"].(map[string]any)
	if !ok {
		t.Fatalf("settings = %T, want object", inbound["settings"])
	}
	raw, ok := settings["clients"].([]any)
	if !ok {
		t.Fatalf("clients = %T, want array", settings["clients"])
	}
	clients := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		client, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("client = %T, want object", entry)
		}
		clients = append(clients, client)
	}
	return clients
}

func TestRenderConfigReplacesClientsAndKeepsStaticFields(t *testing.T) {
	users := []xraycore.User{
		{Email: "u_b", UUID: "uuid-b", Flow: xraycore.FlowVision},
		{Email: "u_a", UUID: "uuid-a", Flow: xraycore.FlowVision},
	}
	rendered, err := RenderConfig([]byte(staticConfig), users, "reality-private-key")
	if err != nil {
		t.Fatalf("RenderConfig: %v", err)
	}
	document := decodeDocument(t, rendered)

	inbound := inboundByTag(t, document, "vless-reality")
	settings, ok := inbound["settings"].(map[string]any)
	if !ok {
		t.Fatalf("settings = %T, want object", inbound["settings"])
	}
	if settings["decryption"] != "none" {
		t.Errorf("decryption = %v, want the static value preserved", settings["decryption"])
	}
	clients := clientsOf(t, inbound)
	if len(clients) != 2 {
		t.Fatalf("clients = %d, want 2", len(clients))
	}
	// Clients are rendered in email order so two renders of one set are byte
	// identical and cannot look like a config change.
	first := clients[0]
	if first["email"] != "u_a" || first["id"] != "uuid-a" || first["flow"] != xraycore.FlowVision {
		t.Errorf("first client = %+v, want u_a with its uuid and vision flow", first)
	}
	if level, ok := first["level"].(float64); !ok || level != 0 {
		t.Errorf("level = %v, want 0 because the stats policy applies at level 0", first["level"])
	}

	// The API inbound and everything the panel owns must survive the render.
	api := inboundByTag(t, document, "api")
	apiSettings, _ := api["settings"].(map[string]any)
	if apiSettings["address"] != "127.0.0.1" {
		t.Errorf("api settings = %+v, want the static value", apiSettings)
	}
	if document["outbounds"] == nil {
		t.Error("outbounds were dropped by the render")
	}

	stream, _ := inbound["streamSettings"].(map[string]any)
	reality, _ := stream["realitySettings"].(map[string]any)
	if reality["privateKey"] != "reality-private-key" {
		t.Errorf("privateKey = %v, want the local REALITY key merged in", reality["privateKey"])
	}
	if reality["dest"] != "example.com:443" {
		t.Errorf("dest = %v, want the static value preserved", reality["dest"])
	}
}

func TestRenderConfigKeepsExistingRealityKey(t *testing.T) {
	static := strings.Replace(staticConfig,
		`"realitySettings": {"dest": "example.com:443", "serverNames": ["example.com"]}`,
		`"realitySettings": {"dest": "example.com:443", "privateKey": "pinned-key"}`, 1)
	rendered, err := RenderConfig([]byte(static), nil, "unused-key")
	if err != nil {
		t.Fatalf("RenderConfig: %v", err)
	}
	document := decodeDocument(t, rendered)
	inbound := inboundByTag(t, document, "vless-reality")
	stream, _ := inbound["streamSettings"].(map[string]any)
	reality, _ := stream["realitySettings"].(map[string]any)
	if reality["privateKey"] != "pinned-key" {
		t.Errorf("privateKey = %v, want the pinned key to win over the local file", reality["privateKey"])
	}
}

func TestRenderConfigRequiresKeyForReality(t *testing.T) {
	if _, err := RenderConfig([]byte(staticConfig), nil, ""); err == nil {
		t.Fatal("RenderConfig accepted a realitySettings block without a private key")
	}
}

// A node whose managed inbounds are not VLESS carries no REALITY block, so a
// missing local key file must not block rendering.
func TestRenderConfigDoesNotRequireRealityKeyWithoutVless(t *testing.T) {
	static := `{"inbounds": [
	  {"tag": "vmess-ws", "port": 8443, "protocol": "vmess",
	   "settings": {"clients": []},
	   "streamSettings": {"network": "ws", "security": "none"}}
	]}`
	if _, err := RenderConfig([]byte(static), nil, ""); err != nil {
		t.Fatalf("RenderConfig: %v", err)
	}
}

func TestRenderConfigRejectsUnexpectedStaticConfig(t *testing.T) {
	cases := map[string]string{
		"no inbounds":        `{"stats": {}}`,
		"no managed inbound": `{"inbounds": [{"tag": "api", "protocol": "dokodemo-door"}]}`,
		"no settings":        `{"inbounds": [{"tag": "vmess", "protocol": "vmess"}]}`,
		"vless tls":          `{"inbounds": [{"tag": "tls", "protocol": "vless", "settings": {}, "streamSettings": {"network": "tcp", "security": "tls"}}]}`,
		"vless kcp":          `{"inbounds": [{"tag": "kcp", "protocol": "vless", "settings": {}, "streamSettings": {"network": "kcp", "security": "reality", "realitySettings": {}}}]}`,
		"unsupported ss":     `{"inbounds": [{"tag": "ss", "protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-256-gcm"}}]}`,
		"invalid json":       `{"inbounds": [`,
		"empty inbounds":     `{"inbounds": []}`,
	}
	for name, document := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := RenderConfig([]byte(document), nil, "key"); err == nil {
				t.Fatalf("RenderConfig accepted %s", name)
			}
		})
	}
}

func TestConfigFileRenderReadsLocalRealityKey(t *testing.T) {
	directory := t.TempDir()
	keyPath := filepath.Join(directory, "reality.key")
	if err := os.WriteFile(keyPath, []byte("local-private-key\n"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	configPath := filepath.Join(directory, "config.json")
	if err := os.WriteFile(configPath, []byte(staticConfig), 0o640); err != nil {
		t.Fatalf("write config: %v", err)
	}

	file := ConfigFile{Path: configPath, RealityPrivateKeyPath: keyPath}
	exists, err := file.Exists()
	if err != nil || !exists {
		t.Fatalf("Exists = %v, %v, want true", exists, err)
	}
	static, err := file.Static()
	if err != nil {
		t.Fatalf("Static: %v", err)
	}
	rendered, err := file.Render(static, []xraycore.User{{Email: "u_a", UUID: "uuid-a"}})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	document := decodeDocument(t, rendered)
	inbound := inboundByTag(t, document, "vless-reality")
	stream, _ := inbound["streamSettings"].(map[string]any)
	reality, _ := stream["realitySettings"].(map[string]any)
	if reality["privateKey"] != "local-private-key" {
		t.Errorf("privateKey = %v, want the trimmed local key", reality["privateKey"])
	}

	if err := file.Write(rendered); err != nil {
		t.Fatalf("Write: %v", err)
	}
	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if got, want := info.Mode().Perm(), os.FileMode(0o640); got != want {
		t.Errorf("config mode = %o, want %o", got, want)
	}
}

func TestConfigStoreCreatesPrivateDirectoryAndReplacesFile(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "xray")
	path := filepath.Join(directory, "config.json")
	store, err := NewConfigStore(path)
	if err != nil {
		t.Fatalf("NewConfigStore: %v", err)
	}

	probe, cleanup, err := store.WriteProbe([]byte(`{"inbounds": []}`))
	if err != nil {
		t.Fatalf("WriteProbe: %v", err)
	}
	// The probe must live next to the config so the binary validates it with the
	// permissions the replacement file will have.
	if filepath.Dir(probe) != directory {
		t.Errorf("probe directory = %q, want %q", filepath.Dir(probe), directory)
	}
	cleanup()
	if _, err := os.Stat(probe); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("probe survived cleanup: %v", err)
	}

	if err := store.Write([]byte(`{"inbounds": []}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	data, err := store.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(data) != `{"inbounds": []}` {
		t.Errorf("config = %q, want the written document", data)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat config: %v", err)
	}
	if got, want := info.Mode().Perm(), os.FileMode(0o640); got != want {
		t.Errorf("config mode = %o, want %o", got, want)
	}
	// A directory the agent creates itself must not be group or world writable.
	directoryInfo, err := os.Stat(directory)
	if err != nil {
		t.Fatalf("Stat directory: %v", err)
	}
	if got, want := directoryInfo.Mode().Perm(), os.FileMode(0o700); got != want {
		t.Errorf("config directory mode = %o, want %o", got, want)
	}
}

// Every managed inbound receives the account shape of its protocol from the same
// node-client secret, while an inbound the panel does not own stays byte-identical.
func TestRenderConfigWritesProtocolAccounts(t *testing.T) {
	users := []xraycore.User{
		{Email: "u_b", UUID: "secret-b"},
		{Email: "u_a", UUID: "secret-a", Flow: xraycore.FlowVision},
	}
	rendered, err := RenderConfig([]byte(multiProtocolConfig), users, "")
	if err != nil {
		t.Fatalf("RenderConfig: %v", err)
	}
	document := decodeDocument(t, rendered)

	vless := clientsOf(t, inboundByTag(t, document, "vless-reality"))
	if len(vless) != 2 || vless[0]["email"] != "u_a" || vless[1]["email"] != "u_b" {
		t.Fatalf("vless clients = %+v, want two clients in email order", vless)
	}
	if vless[0]["id"] != "secret-a" || vless[0]["flow"] != xraycore.FlowVision {
		t.Errorf("vless client = %+v, want the uuid with the vision flow", vless[0])
	}

	vmess := clientsOf(t, inboundByTag(t, document, "vmess-ws"))
	if len(vmess) != 2 || vmess[0]["email"] != "u_a" {
		t.Fatalf("vmess clients = %+v, want two clients in email order", vmess)
	}
	if vmess[0]["id"] != "secret-a" {
		t.Errorf("vmess client = %+v, want the secret as id", vmess[0])
	}
	if alterID, ok := vmess[0]["alterId"].(float64); !ok || alterID != 0 {
		t.Errorf("vmess alterId = %v, want 0", vmess[0]["alterId"])
	}
	if _, hasPassword := vmess[0]["password"]; hasPassword {
		t.Errorf("vmess client = %+v, want no password field", vmess[0])
	}

	trojan := clientsOf(t, inboundByTag(t, document, "trojan-grpc"))
	if len(trojan) != 2 || trojan[0]["email"] != "u_a" {
		t.Fatalf("trojan clients = %+v, want two clients in email order", trojan)
	}
	if trojan[0]["password"] != "secret-a" {
		t.Errorf("trojan client = %+v, want the secret verbatim as password", trojan[0])
	}
	if _, hasID := trojan[0]["id"]; hasID {
		t.Errorf("trojan client = %+v, want no id field", trojan[0])
	}

	shadowsocks := clientsOf(t, inboundByTag(t, document, "ss-gcm"))
	if len(shadowsocks) != 2 || shadowsocks[0]["email"] != "u_a" {
		t.Fatalf("shadowsocks clients = %+v, want two clients in email order", shadowsocks)
	}
	if shadowsocks[0]["password"] != "secret-a" || shadowsocks[0]["method"] != "aes-256-gcm" {
		t.Errorf("shadowsocks client = %+v, want the secret and the inbound method", shadowsocks[0])
	}

	// The REALITY private key belongs to the vless inbound only.
	reality := inboundByTag(t, document, "vless-reality")["streamSettings"].(map[string]any)["realitySettings"].(map[string]any)
	if reality["privateKey"] != "pinned-key" {
		t.Errorf("reality privateKey = %v, want the pinned key", reality["privateKey"])
	}

	// The operator-owned vless + TLS inbound and the API inbound are untouched.
	before := decodeDocument(t, []byte(multiProtocolConfig))
	for _, tag := range []string{"vless-tls", "api"} {
		if !reflect.DeepEqual(inboundByTag(t, before, tag), inboundByTag(t, document, tag)) {
			t.Errorf("unmanaged inbound %q was modified by the render", tag)
		}
	}

	// The same set in another input order must produce identical bytes.
	reversed := []xraycore.User{users[1], users[0]}
	renderedAgain, err := RenderConfig([]byte(multiProtocolConfig), reversed, "")
	if err != nil {
		t.Fatalf("RenderConfig with reversed users: %v", err)
	}
	if string(rendered) != string(renderedAgain) {
		t.Error("renders of the same user set differ; client order is not deterministic")
	}
}

func TestManagedInboundTargetsReportsProtocols(t *testing.T) {
	document := `{"inbounds": [
	  {"tag": "vless-reality", "port": 443, "protocol": "vless", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": {}}},
	  {"tag": "vmess-ws", "port": 8443, "protocol": "vmess", "settings": {},
	   "streamSettings": {"network": "ws", "security": "none"}},
	  {"tag": "trojan-grpc", "port": 9000, "protocol": "trojan", "settings": {},
	   "streamSettings": {"network": "grpc", "security": "tls", "tlsSettings": {"serverNames": ["www.example.com"]}}},
	  {"tag": "ss-gcm", "port": 9001, "protocol": "shadowsocks", "settings": {"method": "aes-256-gcm"}},
	  {"tag": "ss-2022", "port": 9002, "protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-256-gcm"}},
	  {"tag": "vless-tls", "port": 9443, "protocol": "vless", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "tls"}},
	  {"tag": "vless-grpc", "port": 9444, "protocol": "vless", "settings": {},
	   "streamSettings": {"network": "grpc", "security": "reality", "realitySettings": {}}},
	  {"tag": "vmess-kcp", "port": 9445, "protocol": "vmess", "settings": {},
	   "streamSettings": {"network": "kcp"}},
	  {"tag": "vmess-reality", "port": 9446, "protocol": "vmess", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "reality",
	     "realitySettings": {"serverNames": ["cdn.example.com"]}}},
	  {"tag": "vmess-tls-no-sni", "port": 9447, "protocol": "vmess", "settings": {},
	   "streamSettings": {"network": "ws", "security": "tls"}},
	  {"tag": "trojan-no-tls", "port": 9448, "protocol": "trojan", "settings": {}},
	  {"tag": "trojan-reality", "port": 9449, "protocol": "trojan", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "reality",
	     "realitySettings": {"serverNames": ["cdn.example.com"]}}},
	  {"tag": "api", "port": 10085, "protocol": "dokodemo-door", "settings": {}}
	]}`
	targets, err := ManagedInboundTargets([]byte(document))
	if err != nil {
		t.Fatalf("ManagedInboundTargets: %v", err)
	}
	want := []xraycore.InboundTarget{
		{Tag: "vless-reality", Protocol: xraycore.ProtocolVlessReality},
		{Tag: "vmess-ws", Protocol: xraycore.ProtocolVmess},
		{Tag: "trojan-grpc", Protocol: xraycore.ProtocolTrojan},
		{Tag: "ss-gcm", Protocol: xraycore.ProtocolShadowsocks, Method: "aes-256-gcm"},
	}
	if !reflect.DeepEqual(targets, want) {
		t.Errorf("targets = %+v, want %+v", targets, want)
	}

	// An untagged managed inbound cannot be addressed and is skipped.
	untagged, err := ManagedInboundTargets([]byte(`{"inbounds": [{"protocol": "vmess", "settings": {}}]}`))
	if err != nil {
		t.Fatalf("ManagedInboundTargets without tags: %v", err)
	}
	if len(untagged) != 0 {
		t.Errorf("targets = %+v, want none for an untagged inbound", untagged)
	}
}

// An adopted document keeps the clients the node already served, so the renderer
// replaces them. ManagedClientEmails is how the syncer notices that the file still
// grants an account the panel does not, which only a restart can revoke.
func TestManagedClientEmailsReportsOnlyManagedInbounds(t *testing.T) {
	document := `{"inbounds": [
	  {"tag": "vless-reality", "port": 443, "protocol": "vless",
	   "settings": {"clients": [{"id": "a", "email": "u_managed", "level": 0}]},
	   "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": {}}},
	  {"tag": "ss", "port": 8388, "protocol": "shadowsocks",
	   "settings": {"method": "aes-256-gcm", "clients": [{"password": "p", "email": "u_ss", "level": 0}]}},
	  {"tag": "vless-tls", "port": 8443, "protocol": "vless",
	   "settings": {"clients": [{"id": "b", "email": "u_operator", "level": 0}]},
	   "streamSettings": {"network": "tcp", "security": "tls"}}
	]}`
	got := ManagedClientEmails([]byte(document))
	if !reflect.DeepEqual(got, []string{"u_managed", "u_ss"}) {
		t.Errorf("ManagedClientEmails = %v, want the managed inbounds' clients only", got)
	}
	if got := ManagedClientEmails([]byte(`[]`)); len(got) != 0 {
		t.Errorf("ManagedClientEmails on a non-object document = %v, want none", got)
	}
}

func TestEndpointsFromDocumentMapsProtocolParams(t *testing.T) {
	const privateKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	publicKey, err := PublicKeyFromPrivateKey(privateKey)
	if err != nil {
		t.Fatalf("PublicKeyFromPrivateKey: %v", err)
	}
	document := decodeDocument(t, []byte(`{"inbounds": [
	  {"tag": "vless-reality", "port": 443, "protocol": "vless", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "reality",
	     "realitySettings": {"serverNames": ["cdn.example.com"], "privateKey": "`+privateKey+`",
	       "shortIds": ["aabb"], "fingerprint": "firefox"}}},
	  {"tag": "vmess-ws", "port": 8443, "protocol": "vmess", "settings": {},
	   "streamSettings": {"network": "ws", "security": "tls",
	     "tlsSettings": {"serverNames": ["cdn.example.com"]},
	     "wsSettings": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}}},
	  {"tag": "vmess-grpc", "port": 8444, "protocol": "vmess", "settings": {},
	   "streamSettings": {"network": "grpc",
	     "grpcSettings": {"serviceName": "grpc-svc", "authority": "grpc.example.com"}}},
	  {"tag": "trojan-ws", "port": 9000, "protocol": "trojan", "settings": {},
	   "streamSettings": {"network": "ws", "security": "tls",
	     "tlsSettings": {"serverName": "www.example.com"},
	     "wsSettings": {"path": "/trojan", "headers": {"host": "host.example.com"}}}},
	  {"tag": "trojan-tcp", "port": 9001, "protocol": "trojan", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "tls",
	     "tlsSettings": {"serverNames": ["tcp.example.com"]}}},
	  {"tag": "ss-settings-method", "port": 9100, "protocol": "shadowsocks",
	   "settings": {"method": "aes-256-gcm"}},
	  {"tag": "ss-client-method", "port": 9101, "protocol": "shadowsocks",
	   "settings": {"clients": [{"password": "p", "method": "chacha20-ietf-poly1305"}]}},
	  {"tag": "ss-2022", "port": 9102, "protocol": "shadowsocks",
	   "settings": {"method": "2022-blake3-aes-256-gcm"}},
	  {"tag": "trojan-no-sni", "port": 9200, "protocol": "trojan", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "tls"}},
	  {"tag": "vmess-tls-no-sni", "port": 9201, "protocol": "vmess", "settings": {},
	   "streamSettings": {"network": "ws", "security": "tls"}},
	  {"tag": "vmess-reality", "port": 9202, "protocol": "vmess", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "reality",
	     "realitySettings": {"serverNames": ["cdn.example.com"]}}},
	  {"tag": "trojan-reality", "port": 9203, "protocol": "trojan", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "reality",
	     "realitySettings": {"serverNames": ["cdn.example.com"]}}},
	  {"tag": "vless-tls", "port": 9443, "protocol": "vless", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "tls"}},
	  {"tag": "api", "port": 10085, "protocol": "dokodemo-door", "settings": {}}
	]}`))

	endpoints, err := endpointsFromDocument(document)
	if err != nil {
		t.Fatalf("endpointsFromDocument: %v", err)
	}
	byTag := make(map[string]ManagedEndpoint, len(endpoints))
	for _, endpoint := range endpoints {
		byTag[endpoint.Tag] = endpoint
	}

	cases := []struct {
		tag      string
		protocol xraycore.Protocol
		params   ManagedParams
	}{
		{"vless-reality", xraycore.ProtocolVlessReality, ManagedParams{
			SNI: "cdn.example.com", PublicKey: publicKey, ShortID: "aabb",
			Fingerprint: "firefox", Flow: DefaultFlow, Network: DefaultNetwork,
		}},
		{"vmess-ws", xraycore.ProtocolVmess, ManagedParams{
			SNI: "cdn.example.com", Network: "ws", Security: "tls", Path: "/ws", Host: "cdn.example.com",
		}},
		{"vmess-grpc", xraycore.ProtocolVmess, ManagedParams{
			Network: "grpc", Security: "none", Path: "grpc-svc", Host: "grpc.example.com",
		}},
		{"trojan-ws", xraycore.ProtocolTrojan, ManagedParams{
			SNI: "www.example.com", Network: "ws", Path: "/trojan", Host: "host.example.com",
		}},
		{"trojan-tcp", xraycore.ProtocolTrojan, ManagedParams{
			SNI: "tcp.example.com", Network: "tcp",
		}},
		{"ss-settings-method", xraycore.ProtocolShadowsocks, ManagedParams{Method: "aes-256-gcm"}},
		{"ss-client-method", xraycore.ProtocolShadowsocks, ManagedParams{Method: "chacha20-ietf-poly1305"}},
	}
	if len(endpoints) != len(cases) {
		t.Errorf("endpoints = %d, want %d: unmanaged inbounds must not be reported", len(endpoints), len(cases))
	}
	for _, testCase := range cases {
		endpoint, ok := byTag[testCase.tag]
		if !ok {
			t.Errorf("endpoint %q is missing", testCase.tag)
			continue
		}
		if endpoint.Protocol != testCase.protocol || endpoint.Params != testCase.params {
			t.Errorf("%s = %+v (%s), want %+v (%s)",
				testCase.tag, endpoint.Params, endpoint.Protocol, testCase.params, testCase.protocol)
		}
	}
	for _, tag := range []string{
		"ss-2022", "trojan-no-sni", "vmess-tls-no-sni", "vmess-reality",
		"trojan-reality", "vless-tls", "api",
	} {
		if _, ok := byTag[tag]; ok {
			t.Errorf("unmanaged inbound %q was reported as an endpoint", tag)
		}
	}
}

func TestPrepareDocumentAdoptsExistingConfig(t *testing.T) {
	privateKey := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	existing := `{"inbounds": [
	  {"tag": "vmess-ws", "port": 8443, "protocol": "vmess", "settings": {"clients": []},
	   "streamSettings": {"network": "ws", "security": "tls",
	     "tlsSettings": {"serverNames": ["cdn.example.com"]},
	     "wsSettings": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}}},
	  {"tag": "reality-a", "port": 8444, "protocol": "vless", "settings": {"clients": []},
	   "streamSettings": {"network": "tcp", "security": "reality",
	     "realitySettings": {"dest": "cdn.example.com:443", "serverNames": ["cdn.example.com"],
	       "privateKey": "` + privateKey + `", "shortIds": ["aabb"], "fingerprint": "firefox"}}}
	]}`
	prepared, err := PrepareDocument([]byte(existing), "", "")
	if err != nil {
		t.Fatalf("PrepareDocument: %v", err)
	}
	if prepared.Created {
		t.Error("Created = true, want the existing document adopted")
	}
	if len(prepared.Endpoints) != 2 {
		t.Fatalf("endpoints = %d, want one per managed inbound", len(prepared.Endpoints))
	}

	vmess := prepared.Endpoints[0]
	if vmess.Name != "vmess-ws" || vmess.Protocol != xraycore.ProtocolVmess || vmess.Port != 8443 {
		t.Errorf("vmess endpoint = %+v", vmess)
	}
	if vmess.Params.Security != "tls" || vmess.Params.Network != "ws" || vmess.Params.Path != "/ws" {
		t.Errorf("vmess params = %+v", vmess.Params)
	}

	reality := prepared.Endpoints[1]
	if reality.Name != "reality-a" || reality.Protocol != xraycore.ProtocolVlessReality || reality.Port != 8444 {
		t.Errorf("reality endpoint = %+v", reality)
	}
	if reality.Params.PublicKey == "" || reality.Params.ShortID != "aabb" || reality.Params.Fingerprint != "firefox" {
		t.Errorf("reality params = %+v", reality.Params)
	}

	// Both managed inbounds are addressable for hot updates after adoption.
	targets, err := ManagedInboundTargets(prepared.Document)
	if err != nil {
		t.Fatalf("ManagedInboundTargets: %v", err)
	}
	want := []xraycore.InboundTarget{
		{Tag: "vmess-ws", Protocol: xraycore.ProtocolVmess},
		{Tag: "reality-a", Protocol: xraycore.ProtocolVlessReality},
	}
	if !reflect.DeepEqual(targets, want) {
		t.Errorf("targets = %+v, want %+v", targets, want)
	}
}

func TestPrepareDocumentCreatesDefaultTemplateWithoutConfig(t *testing.T) {
	privateKey := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	prepared, err := PrepareDocument(nil, privateKey, "aabbccdd")
	if err != nil {
		t.Fatalf("PrepareDocument: %v", err)
	}
	if !prepared.Created {
		t.Error("Created = false, want the default template")
	}
	if len(prepared.Endpoints) != 1 {
		t.Fatalf("endpoints = %d, want 1", len(prepared.Endpoints))
	}
	endpoint := prepared.Endpoints[0]
	if endpoint.Protocol != xraycore.ProtocolVlessReality {
		t.Errorf("protocol = %q, want %q", endpoint.Protocol, xraycore.ProtocolVlessReality)
	}
	if endpoint.Params.SNI != DefaultSNI || endpoint.Port != DefaultPort || endpoint.Params.ShortID != "aabbccdd" {
		t.Errorf("endpoint = %+v", endpoint)
	}
}

func TestPrepareDocumentAddsManagementScaffolding(t *testing.T) {
	privateKey := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	existing := `{"inbounds": [
	  {"tag": "reality-a", "port": 8444, "protocol": "vless", "settings": {"clients": []},
	   "streamSettings": {"network": "tcp", "security": "reality",
	     "realitySettings": {"serverNames": ["a.example.com"], "privateKey": "` + privateKey + `", "shortIds": ["aa"]}}}
	]}`
	prepared, err := PrepareDocument([]byte(existing), "", "")
	if err != nil {
		t.Fatalf("PrepareDocument: %v", err)
	}
	if prepared.APIAddress != "127.0.0.1:10085" {
		t.Errorf("APIAddress = %q, want the default loopback API", prepared.APIAddress)
	}

	var root map[string]any
	if err := json.Unmarshal(prepared.Document, &root); err != nil {
		t.Fatalf("decode adopted document: %v", err)
	}
	if _, ok := root["stats"]; !ok {
		t.Error("stats section was not added")
	}
	api, _ := root["api"].(map[string]any)
	if api == nil || api["tag"] != "api" {
		t.Fatalf("api = %+v, want the management API", api)
	}
	services, _ := api["services"].([]any)
	found := map[string]bool{}
	for _, service := range services {
		found[service.(string)] = true
	}
	if !found["StatsService"] || !found["HandlerService"] {
		t.Errorf("api services = %v, want stats and handler", services)
	}

	policy, _ := root["policy"].(map[string]any)
	levels, _ := policy["levels"].(map[string]any)
	level0, _ := levels["0"].(map[string]any)
	if level0["statsUserUplink"] != true || level0["statsUserDownlink"] != true {
		t.Errorf("level 0 policy = %+v, want per-user stats enabled", level0)
	}

	if findInboundByTag(root, "api") == nil {
		t.Error("management inbound was not appended")
	}
	routing, _ := root["routing"].(map[string]any)
	rules, _ := routing["rules"].([]any)
	if len(rules) != 1 {
		t.Errorf("routing rules = %+v, want the API rule", rules)
	}
}

func TestPrepareDocumentTagsAnUntaggedManagedInbound(t *testing.T) {
	privateKey := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	existing := `{"inbounds": [
	  {"port": 8443, "protocol": "vless", "settings": {"clients": []},
	   "streamSettings": {"network": "tcp", "security": "reality",
	     "realitySettings": {"serverNames": ["a.example.com"], "privateKey": "` + privateKey + `", "shortIds": []}}}
	]}`
	prepared, err := PrepareDocument([]byte(existing), "", "")
	if err != nil {
		t.Fatalf("PrepareDocument: %v", err)
	}
	if len(prepared.Endpoints) != 1 || prepared.Endpoints[0].Name != "vless-reality-8443" {
		t.Fatalf("endpoints = %+v, want a generated tag", prepared.Endpoints)
	}
	targets, err := ManagedInboundTargets(prepared.Document)
	if err != nil || len(targets) != 1 || targets[0].Tag != "vless-reality-8443" {
		t.Fatalf("ManagedInboundTargets = %+v, %v", targets, err)
	}
}

// A tag the agent generates for a protocol without the vless naming must not
// suggest the wrong protocol in the panel.
func TestPrepareDocumentTagsUntaggedProtocolInbounds(t *testing.T) {
	existing := `{"inbounds": [
	  {"port": 8443, "protocol": "vmess", "settings": {"clients": []}},
	  {"port": 9000, "protocol": "shadowsocks", "settings": {"method": "aes-128-gcm"}}
	]}`
	prepared, err := PrepareDocument([]byte(existing), "", "")
	if err != nil {
		t.Fatalf("PrepareDocument: %v", err)
	}
	if len(prepared.Endpoints) != 2 {
		t.Fatalf("endpoints = %d, want both managed inbounds", len(prepared.Endpoints))
	}
	if prepared.Endpoints[0].Tag != "vmess-8443" || prepared.Endpoints[0].Name != "vmess-8443" {
		t.Errorf("vmess endpoint = %+v, want its generated tag as name", prepared.Endpoints[0])
	}
	if prepared.Endpoints[1].Tag != "shadowsocks-9000" || prepared.Endpoints[1].Name != "shadowsocks-9000" {
		t.Errorf("shadowsocks endpoint = %+v, want its generated tag as name", prepared.Endpoints[1])
	}
}

func TestPrepareDocumentTruncatesLongEndpointName(t *testing.T) {
	privateKey := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	longTag := strings.Repeat("t", 80)
	existing := `{"inbounds": [
	  {"tag": "` + longTag + `", "port": 8443, "protocol": "vless", "settings": {"clients": []},
	   "streamSettings": {"network": "tcp", "security": "reality",
	     "realitySettings": {"serverNames": ["a.example.com"], "privateKey": "` + privateKey + `", "shortIds": []}}}
	]}`
	prepared, err := PrepareDocument([]byte(existing), "", "")
	if err != nil {
		t.Fatalf("PrepareDocument: %v", err)
	}
	if got := len([]rune(prepared.Endpoints[0].Name)); got != 64 {
		t.Errorf("name length = %d, want 64", got)
	}
}
