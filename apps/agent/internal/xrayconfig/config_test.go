package xrayconfig

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
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
	clients, ok := settings["clients"].([]any)
	if !ok {
		t.Fatalf("clients = %T, want array", settings["clients"])
	}
	if len(clients) != 2 {
		t.Fatalf("clients = %d, want 2", len(clients))
	}
	// Clients are rendered in email order so two renders of one set are byte
	// identical and cannot look like a config change.
	first, _ := clients[0].(map[string]any)
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

func TestRenderConfigRejectsUnexpectedStaticConfig(t *testing.T) {
	cases := map[string]string{
		"no inbounds":   `{"stats": {}}`,
		"no vless":      `{"inbounds": [{"tag": "api", "protocol": "dokodemo-door"}]}`,
		"two vless":     `{"inbounds": [{"protocol": "vless", "settings": {}}, {"protocol": "vless", "settings": {}}]}`,
		"no settings":   `{"inbounds": [{"protocol": "vless"}]}`,
		"invalid json":  `{"inbounds": [`,
		"empty clients": `{"inbounds": []}`,
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

func TestRenderConfigFillsEveryManagedInboundAndKeepsOtherProtocols(t *testing.T) {
	static := `{
	  "inbounds": [
	    {"tag": "vmess-in", "port": 10086, "protocol": "vmess",
	     "settings": {"clients": [{"id": "vmess-user"}]}},
	    {"tag": "reality-a", "port": 443, "protocol": "vless",
	     "settings": {"clients": []},
	     "streamSettings": {"network": "tcp", "security": "reality",
	       "realitySettings": {"serverNames": ["a.example.com"], "shortIds": ["aa"]}}},
	    {"tag": "reality-b", "port": 8443, "protocol": "vless",
	     "settings": {"clients": []},
	     "streamSettings": {"network": "tcp", "security": "reality",
	       "realitySettings": {"serverNames": ["b.example.com"], "shortIds": ["bb"]}}}
	  ]
	}`
	users := []xraycore.User{{Email: "u_a", UUID: "uuid-a"}}
	rendered, err := RenderConfig([]byte(static), users, "local-key")
	if err != nil {
		t.Fatalf("RenderConfig: %v", err)
	}
	document := decodeDocument(t, rendered)

	for _, tag := range []string{"reality-a", "reality-b"} {
		inbound := inboundByTag(t, document, tag)
		settings, _ := inbound["settings"].(map[string]any)
		clients, _ := settings["clients"].([]any)
		if len(clients) != 1 {
			t.Errorf("%s clients = %+v, want the managed user set", tag, clients)
		}
		stream, _ := inbound["streamSettings"].(map[string]any)
		reality, _ := stream["realitySettings"].(map[string]any)
		if reality["privateKey"] != "local-key" {
			t.Errorf("%s privateKey = %v, want the local key", tag, reality["privateKey"])
		}
		if reality["serverNames"].([]any)[0] != map[string]string{"reality-a": "a.example.com", "reality-b": "b.example.com"}[tag] {
			t.Errorf("%s reality parameters were not preserved", tag)
		}
	}

	// A protocol the panel does not implement keeps its settings untouched.
	vmess := inboundByTag(t, document, "vmess-in")
	vmessSettings, _ := vmess["settings"].(map[string]any)
	vmessClients, _ := vmessSettings["clients"].([]any)
	if len(vmessClients) != 1 || vmessClients[0].(map[string]any)["id"] != "vmess-user" {
		t.Errorf("vmess clients = %+v, want untouched", vmessClients)
	}
}

func TestManagedInboundTagsSkipsUnsupportedProtocols(t *testing.T) {
	static := `{"inbounds": [
	  {"tag": "vmess-in", "protocol": "vmess"},
	  {"tag": "vless-plain", "protocol": "vless", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "none"}},
	  {"tag": "reality-a", "protocol": "vless", "settings": {},
	   "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": {}}}
	]}`
	tags, err := ManagedInboundTags([]byte(static))
	if err != nil {
		t.Fatalf("ManagedInboundTags: %v", err)
	}
	if len(tags) != 1 || tags[0] != "reality-a" {
		t.Errorf("tags = %v, want only the managed inbound", tags)
	}
}

func TestPrepareDocumentAdoptsExistingConfig(t *testing.T) {
	privateKey := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	existing := `{"inbounds": [
	  {"tag": "vmess-in", "port": 10086, "protocol": "vmess", "settings": {"clients": []}},
	  {"tag": "reality-a", "port": 8443, "protocol": "vless", "settings": {"clients": []},
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
	if len(prepared.Endpoints) != 1 {
		t.Fatalf("endpoints = %d, want 1", len(prepared.Endpoints))
	}
	endpoint := prepared.Endpoints[0]
	if endpoint.Name != "reality-a" || endpoint.Port != 8443 || endpoint.SNI != "cdn.example.com" {
		t.Errorf("endpoint = %+v", endpoint)
	}
	if endpoint.PublicKey == "" || endpoint.ShortID != "aabb" || endpoint.Fingerprint != "firefox" {
		t.Errorf("endpoint params = %+v", endpoint)
	}

	// The unsupported inbound is still present in the document that gets written.
	tags, err := ManagedInboundTags(prepared.Document)
	if err != nil || len(tags) != 1 || tags[0] != "reality-a" {
		t.Fatalf("ManagedInboundTags = %v, %v", tags, err)
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
	if endpoint.SNI != DefaultSNI || endpoint.Port != DefaultPort || endpoint.ShortID != "aabbccdd" {
		t.Errorf("endpoint = %+v", endpoint)
	}
}

func TestPrepareDocumentAddsManagementScaffolding(t *testing.T) {
	privateKey := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	existing := `{"inbounds": [
	  {"tag": "reality-a", "port": 8443, "protocol": "vless", "settings": {"clients": []},
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
	tags, err := ManagedInboundTags(prepared.Document)
	if err != nil || len(tags) != 1 || tags[0] != "vless-reality-8443" {
		t.Fatalf("ManagedInboundTags = %v, %v", tags, err)
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
