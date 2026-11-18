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

func TestExecuteEnrollsAndWritesFiles(t *testing.T) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate x25519 key: %v", err)
	}
	wantPublicKey := base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes())

	dir := t.TempDir()
	realityKeyPath := filepath.Join(dir, "reality.key")
	if err := os.WriteFile(realityKeyPath, []byte(base64.RawURLEncoding.EncodeToString(priv.Bytes())+"\n"), 0o600); err != nil {
		t.Fatalf("write reality key: %v", err)
	}

	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agent/enroll" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{
			"data": {
				"node_id": "01J2Z6Q8Y3V9M4K7T1B5C0D2E6",
				"agent_token": "01J2Z6Q8Y3V9M4K7T1B5C0D2E6.permanent-secret",
				"heartbeat_interval_seconds": 180,
				"endpoint": {
					"id": "01J2Z6Q8Y3V9M4K7T1B5C0D2E7",
					"name": "vless-reality",
					"host": "203.0.113.10",
					"port": 443,
					"sni": "www.microsoft.com",
					"short_id": "a1b2c3d4",
					"fingerprint": "chrome"
				}
			},
			"meta": {"request_id": "req-1"}
		}`))
	}))
	defer srv.Close()

	tokenFile := filepath.Join(dir, "token")
	configPath := filepath.Join(dir, "config.yaml")

	out, err := Execute(context.Background(), Options{
		PanelURL:       srv.URL,
		Token:          "01J2Z6Q8Y3V9M4K7T1B5C0D2E0.one-time-secret",
		NodeName:       "edge-01",
		Host:           "203.0.113.10",
		ShortID:        "a1b2c3d4",
		ConfigPath:     configPath,
		TokenFile:      tokenFile,
		RealityKeyPath: realityKeyPath,
		XrayConfigPath: "/etc/xray/config.json",
		XrayBinaryPath: "/usr/local/bin/xray",
		AgentVersion:   "0.1.0",
	}, srv.Client())
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if gotAuth != "Bearer 01J2Z6Q8Y3V9M4K7T1B5C0D2E0.one-time-secret" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotBody["reality_public_key"] != wantPublicKey {
		t.Errorf("reality_public_key = %v, want %s", gotBody["reality_public_key"], wantPublicKey)
	}
	if out.NodeID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6" || out.PublicKey != wantPublicKey {
		t.Errorf("unexpected output: %+v", out)
	}

	rawToken, err := os.ReadFile(tokenFile)
	if err != nil {
		t.Fatalf("read token file: %v", err)
	}
	if strings.TrimSpace(string(rawToken)) != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6.permanent-secret" {
		t.Errorf("token file = %q", string(rawToken))
	}

	loadedCfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if loadedCfg.NodeID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6" || loadedCfg.ControlPlaneURL != srv.URL {
		t.Errorf("loaded config = %+v", loadedCfg)
	}
}
