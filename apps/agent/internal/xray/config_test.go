package xray

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	users := []User{
		{Email: "u_b", UUID: "uuid-b", Flow: FlowVision},
		{Email: "u_a", UUID: "uuid-a", Flow: FlowVision},
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
	if first["email"] != "u_a" || first["id"] != "uuid-a" || first["flow"] != FlowVision {
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
	rendered, err := file.Render(static, []User{{Email: "u_a", UUID: "uuid-a"}})
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
