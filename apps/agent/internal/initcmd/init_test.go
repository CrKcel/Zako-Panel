package initcmd

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zako-panel/zako-agent/internal/config"
)

func writeRealityKey(t *testing.T, dir string) (privateKey, publicKey string) {
	t.Helper()
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate x25519 key: %v", err)
	}
	privateKey = base64.RawURLEncoding.EncodeToString(priv.Bytes())
	publicKey = base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes())
	if err := os.WriteFile(filepath.Join(dir, "reality.key"), []byte(privateKey+"\n"), 0o600); err != nil {
		t.Fatalf("write reality key: %v", err)
	}
	return privateKey, publicKey
}

func enrollServer(t *testing.T, wantPublicKey string) (*httptest.Server, *map[string]any, *string) {
	t.Helper()
	var body map[string]any
	var auth string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agent/enroll" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		auth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		endpoints, _ := body["endpoints"].([]any)
		if len(endpoints) == 0 {
			t.Fatalf("request reported no endpoints")
		}
		first, _ := endpoints[0].(map[string]any)
		params, _ := first["params"].(map[string]any)
		if wantPublicKey != "" && params["public_key"] != wantPublicKey {
			t.Errorf("public_key = %v, want %s", params["public_key"], wantPublicKey)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{
			"data": {
				"node_id": "01J2Z6Q8Y3V9M4K7T1B5C0D2E6",
				"agent_token": "01J2Z6Q8Y3V9M4K7T1B5C0D2E6.permanent-secret",
				"heartbeat_interval_seconds": 180,
				"endpoints": [
					{"id": "01J2Z6Q8Y3V9M4K7T1B5C0D2E7", "name": "vless-reality", "protocol": "vless-reality", "port": 443}
				]
			},
			"meta": {"request_id": "req-1"}
		}`))
	}))
	return server, &body, &auth
}

func TestExecuteCreatesDefaultConfigAndEnrolls(t *testing.T) {
	dir := t.TempDir()
	privateKey, publicKey := writeRealityKey(t, dir)
	server, body, auth := enrollServer(t, publicKey)
	defer server.Close()

	configPath := filepath.Join(dir, "config.yaml")
	xrayConfigPath := filepath.Join(dir, "xray", "config.json")
	out, err := Execute(context.Background(), Options{
		PanelURL:       server.URL,
		Token:          "01J2Z6Q8Y3V9M4K7T1B5C0D2E0.one-time-secret",
		NodeName:       "edge-01",
		Host:           "203.0.113.10",
		ConfigPath:     configPath,
		TokenFile:      filepath.Join(dir, "token"),
		RealityKeyPath: filepath.Join(dir, "reality.key"),
		XrayConfigPath: xrayConfigPath,
		XrayBinaryPath: "/usr/local/bin/xray",
		AgentVersion:   "0.1.0",
	}, server.Client())
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if *auth != "Bearer 01J2Z6Q8Y3V9M4K7T1B5C0D2E0.one-time-secret" {
		t.Errorf("Authorization = %q", *auth)
	}
	if out.NodeID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6" || !out.CreatedConfig {
		t.Errorf("unexpected output: %+v", out)
	}
	if len(out.Endpoints) != 1 || out.Endpoints[0].Port != 443 {
		t.Errorf("endpoints = %+v, want one default endpoint", out.Endpoints)
	}

	endpoints, _ := (*body)["endpoints"].([]any)
	first, _ := endpoints[0].(map[string]any)
	params, _ := first["params"].(map[string]any)
	if params["sni"] != "www.microsoft.com" || first["protocol"] != "vless-reality" {
		t.Errorf("reported endpoint = %+v", first)
	}
	// The private key must stay on the node: only the public half is reported.
	encoded, _ := json.Marshal((*body)["endpoints"])
	if strings.Contains(string(encoded), privateKey) {
		t.Error("enrollment request leaked the REALITY private key")
	}

	loadedCfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if loadedCfg.NodeID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6" || loadedCfg.XrayConfigPath != xrayConfigPath {
		t.Errorf("loaded config = %+v", loadedCfg)
	}

	document, err := os.ReadFile(xrayConfigPath)
	if err != nil {
		t.Fatalf("read written xray config: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(document, &decoded); err != nil {
		t.Fatalf("decode written xray config: %v", err)
	}
	inbounds, _ := decoded["inbounds"].([]any)
	if len(inbounds) != 2 {
		t.Fatalf("inbounds = %d, want api plus one managed inbound", len(inbounds))
	}
}

func TestExecuteAdoptsExistingConfigAndPreservesOtherProtocols(t *testing.T) {
	dir := t.TempDir()
	_, publicKey := writeRealityKey(t, dir)

	existing := `{
	  "inbounds": [
	    {"tag": "vmess-in", "listen": "0.0.0.0", "port": 10086, "protocol": "vmess",
	     "settings": {"clients": [{"id": "keep-me", "alterId": 0}]},
	     "streamSettings": {"network": "kcp"}},
	    {"tag": "reality-8443", "listen": "0.0.0.0", "port": 8443, "protocol": "vless",
	     "settings": {"clients": [], "decryption": "none"},
	     "streamSettings": {"network": "tcp", "security": "reality",
	       "realitySettings": {"dest": "cdn.example.com:443", "serverNames": ["cdn.example.com"],
	         "privateKey": "", "shortIds": ["aabbccdd"], "fingerprint": "firefox"}}}
	  ],
	  "outbounds": [{"protocol": "freedom"}]
	}`
	xrayConfigPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(xrayConfigPath, []byte(existing), 0o640); err != nil {
		t.Fatalf("write existing config: %v", err)
	}

	server, body, _ := enrollServer(t, publicKey)
	defer server.Close()

	out, err := Execute(context.Background(), Options{
		PanelURL:       server.URL,
		Token:          "01J2Z6Q8Y3V9M4K7T1B5C0D2E0.one-time-secret",
		NodeName:       "edge-02",
		Host:           "203.0.113.11",
		ConfigPath:     filepath.Join(dir, "agent.yaml"),
		TokenFile:      filepath.Join(dir, "token"),
		RealityKeyPath: filepath.Join(dir, "reality.key"),
		XrayConfigPath: xrayConfigPath,
	}, server.Client())
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if out.CreatedConfig {
		t.Error("CreatedConfig = true, want the existing document to be adopted")
	}

	endpoints, _ := (*body)["endpoints"].([]any)
	if len(endpoints) != 1 {
		t.Fatalf("endpoints = %d, want the single managed inbound", len(endpoints))
	}
	first, _ := endpoints[0].(map[string]any)
	params, _ := first["params"].(map[string]any)
	if first["name"] != "reality-8443" || first["port"] != float64(8443) {
		t.Errorf("adopted endpoint = %+v", first)
	}
	if params["sni"] != "cdn.example.com" || params["short_id"] != "aabbccdd" || params["fingerprint"] != "firefox" {
		t.Errorf("adopted params = %+v", params)
	}

	written, err := os.ReadFile(xrayConfigPath)
	if err != nil {
		t.Fatalf("read adopted config: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(written, &decoded); err != nil {
		t.Fatalf("decode adopted config: %v", err)
	}
	inbounds, _ := decoded["inbounds"].([]any)
	// The node keeps its vmess and reality inbounds; the management inbound is
	// added so stats and hot updates can work.
	if len(inbounds) != 3 {
		t.Fatalf("inbounds = %d, want vmess, reality and api", len(inbounds))
	}
	vmess, _ := inbounds[0].(map[string]any)
	if vmess["tag"] != "vmess-in" || vmess["port"] != float64(10086) {
		t.Errorf("vmess inbound was changed: %+v", vmess)
	}
	if findInbound(decoded, "api") == nil {
		t.Error("management inbound was not added to the adopted document")
	}
	settings, _ := vmess["settings"].(map[string]any)
	clients, _ := settings["clients"].([]any)
	if len(clients) != 1 {
		t.Errorf("vmess clients = %+v, want preserved", clients)
	}
}

func TestExecuteAppendsManagedInboundWhenExistingConfigHasNone(t *testing.T) {
	dir := t.TempDir()
	_, publicKey := writeRealityKey(t, dir)

	xrayConfigPath := filepath.Join(dir, "config.json")
	existing := `{"inbounds": [{"tag": "trojan-in", "port": 443, "protocol": "trojan",
	  "settings": {"clients": [{"password": "secret"}]}}]}`
	if err := os.WriteFile(xrayConfigPath, []byte(existing), 0o640); err != nil {
		t.Fatalf("write existing config: %v", err)
	}

	server, body, _ := enrollServer(t, publicKey)
	defer server.Close()

	out, err := Execute(context.Background(), Options{
		PanelURL:       server.URL,
		Token:          "01J2Z6Q8Y3V9M4K7T1B5C0D2E0.one-time-secret",
		NodeName:       "edge-03",
		Host:           "203.0.113.12",
		ConfigPath:     filepath.Join(dir, "agent.yaml"),
		TokenFile:      filepath.Join(dir, "token"),
		RealityKeyPath: filepath.Join(dir, "reality.key"),
		XrayConfigPath: xrayConfigPath,
	}, server.Client())
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if out.CreatedConfig {
		t.Error("CreatedConfig = true, want only the managed inbound appended")
	}
	endpoints, _ := (*body)["endpoints"].([]any)
	if len(endpoints) != 1 {
		t.Fatalf("endpoints = %d, want one appended managed inbound", len(endpoints))
	}
	first, _ := endpoints[0].(map[string]any)
	// Port 443 is occupied by the trojan inbound, so the managed inbound moves on.
	if first["port"] != float64(8443) {
		t.Errorf("appended endpoint port = %v, want 8443", first["port"])
	}

	written, err := os.ReadFile(xrayConfigPath)
	if err != nil {
		t.Fatalf("read written config: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(written, &decoded); err != nil {
		t.Fatalf("decode written config: %v", err)
	}
	inbounds, _ := decoded["inbounds"].([]any)
	if len(inbounds) != 3 {
		t.Fatalf("inbounds = %d, want trojan, the appended inbound and api", len(inbounds))
	}
	trojan, _ := inbounds[0].(map[string]any)
	if trojan["protocol"] != "trojan" || trojan["port"] != float64(443) {
		t.Errorf("trojan inbound was changed: %+v", trojan)
	}
}

// Enrollment reports every adopted endpoint with its own protocol and parameters;
// the panel validates each payload per protocol.
func TestExecuteReportsEveryManagedProtocol(t *testing.T) {
	dir := t.TempDir()
	_, publicKey := writeRealityKey(t, dir)

	existing := `{
	  "inbounds": [
	    {"tag": "vless-reality", "listen": "0.0.0.0", "port": 443, "protocol": "vless",
	     "settings": {"clients": [], "decryption": "none"},
	     "streamSettings": {"network": "tcp", "security": "reality",
	       "realitySettings": {"dest": "cdn.example.com:443", "serverNames": ["cdn.example.com"],
	         "privateKey": "", "shortIds": ["aabbccdd"], "fingerprint": "chrome"}}},
	    {"tag": "vmess-ws", "listen": "0.0.0.0", "port": 8443, "protocol": "vmess",
	     "settings": {"clients": []},
	     "streamSettings": {"network": "ws", "security": "tls",
	       "tlsSettings": {"serverNames": ["cdn.example.com"]},
	       "wsSettings": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}}},
	    {"tag": "trojan-grpc", "listen": "0.0.0.0", "port": 9000, "protocol": "trojan",
	     "settings": {"clients": []},
	     "streamSettings": {"network": "grpc", "security": "tls",
	       "tlsSettings": {"serverName": "www.example.com"},
	       "grpcSettings": {"serviceName": "trojan-grpc"}}},
	    {"tag": "ss-gcm", "listen": "0.0.0.0", "port": 9001, "protocol": "shadowsocks",
	     "settings": {"method": "aes-256-gcm", "clients": []}}
	  ],
	  "outbounds": [{"protocol": "freedom"}]
	}`
	xrayConfigPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(xrayConfigPath, []byte(existing), 0o640); err != nil {
		t.Fatalf("write existing config: %v", err)
	}

	server, body, _ := enrollServer(t, publicKey)
	defer server.Close()

	out, err := Execute(context.Background(), Options{
		PanelURL:       server.URL,
		Token:          "01J2Z6Q8Y3V9M4K7T1B5C0D2E0.one-time-secret",
		NodeName:       "edge-mixed",
		Host:           "203.0.113.13",
		ConfigPath:     filepath.Join(dir, "agent.yaml"),
		TokenFile:      filepath.Join(dir, "token"),
		RealityKeyPath: filepath.Join(dir, "reality.key"),
		XrayConfigPath: xrayConfigPath,
	}, server.Client())
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if out.CreatedConfig {
		t.Error("CreatedConfig = true, want the existing document to be adopted")
	}

	wantProtocols := []string{"vless-reality", "vmess", "trojan", "shadowsocks"}
	if out.EndpointCount != len(wantProtocols) || len(out.Endpoints) != len(wantProtocols) {
		t.Fatalf("output endpoints = %+v, want one per adopted protocol", out.Endpoints)
	}
	for index, protocol := range wantProtocols {
		if out.Endpoints[index].Protocol != protocol {
			t.Errorf("output endpoint %d protocol = %q, want %q", index, out.Endpoints[index].Protocol, protocol)
		}
	}

	endpoints, _ := (*body)["endpoints"].([]any)
	if len(endpoints) != len(wantProtocols) {
		t.Fatalf("reported endpoints = %d, want %d", len(endpoints), len(wantProtocols))
	}
	wantParams := []map[string]any{
		{"sni": "cdn.example.com", "network": "tcp", "short_id": "aabbccdd"},
		{"security": "tls", "sni": "cdn.example.com", "network": "ws", "path": "/ws", "host": "cdn.example.com"},
		{"sni": "www.example.com", "network": "grpc", "path": "trojan-grpc", "host": ""},
		{"method": "aes-256-gcm"},
	}
	for index, protocol := range wantProtocols {
		endpoint, _ := endpoints[index].(map[string]any)
		if endpoint["protocol"] != protocol {
			t.Errorf("reported endpoint %d protocol = %v, want %q", index, endpoint["protocol"], protocol)
		}
		params, _ := endpoint["params"].(map[string]any)
		for key, want := range wantParams[index] {
			if params[key] != want {
				t.Errorf("%s params[%q] = %v, want %v", protocol, key, params[key], want)
			}
		}
		if _, hasPublicKey := params["public_key"]; protocol != "vless-reality" && hasPublicKey {
			t.Errorf("%s params = %+v, want no vless fields", protocol, params)
		}
	}
}

func findInbound(document map[string]any, tag string) map[string]any {
	inbounds, _ := document["inbounds"].([]any)
	for _, raw := range inbounds {
		inbound, _ := raw.(map[string]any)
		if inbound["tag"] == tag {
			return inbound
		}
	}
	return nil
}
