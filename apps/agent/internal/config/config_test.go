package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const baseConfig = `
control_plane_url: https://panel.example.com
node_id: node-01
agent_token_file: /etc/zako-agent/token
state_path: /var/lib/zako-agent/state.db
users_path: /var/lib/zako-agent/users.json
xray_config_path: /etc/xray/config.json
xray_binary_path: /usr/local/bin/xray
reality_private_key_path: /etc/xray/reality.key
`

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

func TestLoadAppliesDefaults(t *testing.T) {
	cfg, err := Load(writeConfig(t, baseConfig))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got, want := cfg.HeartbeatInterval.Duration(), 5*time.Minute; got != want {
		t.Errorf("heartbeat_interval = %s, want %s", got, want)
	}
	if got, want := cfg.Collector.SampleInterval.Duration(), 30*time.Second; got != want {
		t.Errorf("sample_interval = %s, want %s", got, want)
	}
	if got, want := cfg.Collector.ReportInterval.Duration(), 15*time.Minute; got != want {
		t.Errorf("report_interval = %s, want %s", got, want)
	}
	if got, want := cfg.XrayAPIAddress, "127.0.0.1:10085"; got != want {
		t.Errorf("xray_api_address = %q, want %q", got, want)
	}
	if got, want := cfg.XrayInboundTag, "vless-reality"; got != want {
		t.Errorf("xray_inbound_tag = %q, want %q", got, want)
	}
}

func TestLoadParsesXrayAPIAddress(t *testing.T) {
	body := baseConfig + "xray_api_address: 127.0.0.1:19085\n"
	cfg, err := Load(writeConfig(t, body))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got, want := cfg.XrayAPIAddress, "127.0.0.1:19085"; got != want {
		t.Errorf("xray_api_address = %q, want %q", got, want)
	}
}

func TestLoadRejectsInvalidXrayAPIAddress(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "127.0.0.1:not-a-port", "127.0.0.1:0", "127.0.0.1:70000", ":10085"} {
		t.Run(address, func(t *testing.T) {
			body := baseConfig + "xray_api_address: \"" + address + "\"\n"
			_, err := Load(writeConfig(t, body))
			if err == nil {
				t.Fatalf("Load accepted xray_api_address %q", address)
			}
			if !strings.Contains(err.Error(), "xray_api_address") {
				t.Errorf("error %q does not name xray_api_address", err)
			}
		})
	}
}

func TestLoadParsesDurations(t *testing.T) {
	body := baseConfig + `
heartbeat_interval: 10m
collector:
  sample_interval: 45s
  report_interval: 20m
`
	cfg, err := Load(writeConfig(t, body))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got, want := cfg.HeartbeatInterval.Duration(), 10*time.Minute; got != want {
		t.Errorf("heartbeat_interval = %s, want %s", got, want)
	}
	if got, want := cfg.Collector.SampleInterval.Duration(), 45*time.Second; got != want {
		t.Errorf("sample_interval = %s, want %s", got, want)
	}
	// 20m is deliberately not a multiple of 45s: the contract does not constrain
	// the two intervals to each other, only each one's own bounds.
	if got, want := cfg.Collector.ReportInterval.Duration(), 20*time.Minute; got != want {
		t.Errorf("report_interval = %s, want %s", got, want)
	}
}

func TestLoadRejectsHeartbeatOutsideBounds(t *testing.T) {
	for _, interval := range []string{"30s", "16m"} {
		t.Run(interval, func(t *testing.T) {
			body := baseConfig + "heartbeat_interval: " + interval + "\n"
			_, err := Load(writeConfig(t, body))
			if err == nil {
				t.Fatalf("Load accepted heartbeat_interval %s", interval)
			}
			if !strings.Contains(err.Error(), "heartbeat_interval") {
				t.Errorf("error %q does not name heartbeat_interval", err)
			}
		})
	}
}

func TestLoadRejectsNonHTTPSControlPlane(t *testing.T) {
	body := strings.Replace(baseConfig, "https://panel.example.com", "http://panel.example.com", 1)
	_, err := Load(writeConfig(t, body))
	if err == nil {
		t.Fatal("Load accepted an http control_plane_url")
	}
	if !strings.Contains(err.Error(), "control_plane_url") {
		t.Errorf("error %q does not name control_plane_url", err)
	}
}

func TestLoadRejectsUnknownFields(t *testing.T) {
	body := baseConfig + "unexpected_setting: true\n"
	_, err := Load(writeConfig(t, body))
	if err == nil {
		t.Fatal("Load accepted an unknown field")
	}
	if !strings.Contains(err.Error(), "unexpected_setting") {
		t.Errorf("error %q does not name the unknown field", err)
	}
}

func TestLoadMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent.yaml")
	_, err := Load(path)
	if err == nil {
		t.Fatal("Load accepted a missing file")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("error %v does not wrap fs.ErrNotExist", err)
	}
}
