package reporter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// fixtures live in the shared contracts package so a field rename on either side
// of the HTTP contract fails a Go test instead of surfacing in production.
func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "packages", "contracts", "fixtures", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", path, err)
	}
	return data
}

func TestReportFixture(t *testing.T) {
	var report Report
	if err := json.Unmarshal(readFixture(t, "agent-report.json"), &report); err != nil {
		t.Fatalf("unmarshal report: %v", err)
	}

	if report.SentAt != 1780000000 {
		t.Errorf("sent_at = %d, want 1780000000", report.SentAt)
	}
	if report.UsersVer != 12 {
		t.Errorf("users_ver = %d, want 12", report.UsersVer)
	}
	if report.Sys == nil || report.Sys.Uptime != 86400 {
		t.Errorf("sys = %+v, want uptime 86400", report.Sys)
	}
	if report.Traffic == nil {
		t.Fatal("traffic is missing")
	}
	if got, want := report.Traffic.ReportID, "01J2Z6Q8Y3V9M4K7T1B5C0D2E6"; got != want {
		t.Errorf("traffic.report_id = %q, want %q", got, want)
	}
	if got := report.Traffic.PeriodEnd - report.Traffic.PeriodStart; got != 900 {
		t.Errorf("traffic period = %d seconds, want 900", got)
	}
	if len(report.Traffic.Users) != 1 || report.Traffic.Users[0].XrayEmail != "u_01J2Z6Q8Y3V9M4K7T1B5C0D2E6" {
		t.Errorf("traffic.users = %+v, want one fixture user", report.Traffic.Users)
	}

	// The agent writes reports, so the fixture decode alone cannot catch a broken
	// write-side tag. Re-marshal and assert the required top-level keys survive.
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &keys); err != nil {
		t.Fatalf("unmarshal marshaled report: %v", err)
	}
	for _, key := range []string{
		"sent_at", "agent_version", "xray_version", "xray_healthy", "stats_healthy",
		"applied_config_version", "users_ver", "sys", "traffic",
	} {
		if _, ok := keys[key]; !ok {
			t.Errorf("marshaled report is missing key %q", key)
		}
	}
}

func TestReportResponseFixture(t *testing.T) {
	var response Response
	if err := json.Unmarshal(readFixture(t, "agent-report-response.json"), &response); err != nil {
		t.Fatalf("unmarshal report response: %v", err)
	}

	if response.AckReportID == nil || *response.AckReportID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6" {
		t.Errorf("ack_report_id = %v, want fixture report id", response.AckReportID)
	}
	if response.ServerTime != 1780000002 {
		t.Errorf("server_time = %d, want 1780000002", response.ServerTime)
	}
	if response.HeartbeatIntervalSeconds != 300 {
		t.Errorf("heartbeat_interval_seconds = %d, want 300", response.HeartbeatIntervalSeconds)
	}
	if response.TrafficIntervalSeconds != 900 {
		t.Errorf("traffic_interval_seconds = %d, want 900", response.TrafficIntervalSeconds)
	}
	if response.UsersVer != 13 {
		t.Errorf("users_ver = %d, want 13", response.UsersVer)
	}
	if response.DesiredConfigVersion != 3 {
		t.Errorf("desired_config_version = %d, want 3", response.DesiredConfigVersion)
	}
	if response.Directives == nil || len(response.Directives) != 0 {
		t.Errorf("directives = %+v, want an empty array", response.Directives)
	}
}

func TestUsersFixture(t *testing.T) {
	var users UsersResponse
	if err := json.Unmarshal(readFixture(t, "agent-users.json"), &users); err != nil {
		t.Fatalf("unmarshal users: %v", err)
	}

	if users.Version != 13 {
		t.Errorf("version = %d, want 13", users.Version)
	}
	if len(users.Users) != 1 {
		t.Fatalf("users = %d entries, want 1", len(users.Users))
	}
	if got, want := users.Users[0].XrayEmail, "u_01J2Z6Q8Y3V9M4K7T1B5C0D2E6"; got != want {
		t.Errorf("xray_email = %q, want %q", got, want)
	}
	if got, want := users.Users[0].VlessUUID, "00000000-0000-0000-0000-000000000000"; got != want {
		t.Errorf("vless_uuid = %q, want %q", got, want)
	}
}

func TestConfigResultFixture(t *testing.T) {
	var result ConfigResult
	if err := json.Unmarshal(readFixture(t, "agent-config-result.json"), &result); err != nil {
		t.Fatalf("unmarshal config result: %v", err)
	}

	if result.Version != 4 {
		t.Errorf("version = %d, want 4", result.Version)
	}
	if result.Status != ConfigStatusApplied {
		t.Errorf("status = %q, want %q", result.Status, ConfigStatusApplied)
	}
	if result.AppliedAt != 1780000000 {
		t.Errorf("applied_at = %d, want 1780000000", result.AppliedAt)
	}
	if result.Error != nil {
		t.Errorf("error = %+v, want nil", result.Error)
	}
}

func TestConfigFixture(t *testing.T) {
	var cfg AgentConfig
	if err := json.Unmarshal(readFixture(t, "agent-config.json"), &cfg); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}

	if cfg.Version != 4 {
		t.Errorf("version = %d, want 4", cfg.Version)
	}
	if cfg.DefinitionSHA256 != "07866b080adc3987b886731eb991fa0d258cd7afdf91a2959f4b70691e8990ca" {
		t.Errorf("definition_sha256 = %q, want expected sha256", cfg.DefinitionSHA256)
	}
	var doc map[string]any
	if err := json.Unmarshal(cfg.Definition, &doc); err != nil {
		t.Fatalf("unmarshal definition: %v", err)
	}
	if _, ok := doc["inbounds"]; !ok {
		t.Errorf("definition missing inbounds key")
	}
}

func TestEnrollFixtures(t *testing.T) {
	var req EnrollRequest
	if err := json.Unmarshal(readFixture(t, "agent-enroll.json"), &req); err != nil {
		t.Fatalf("unmarshal enroll request: %v", err)
	}
	if req.Name != "edge-tokyo-01" || req.Host != "203.0.113.10" {
		t.Errorf("unexpected enroll request: %+v", req)
	}
	if len(req.Endpoints) != 1 {
		t.Fatalf("endpoints = %d, want 1", len(req.Endpoints))
	}
	endpoint := req.Endpoints[0]
	if endpoint.Port != 443 || endpoint.Protocol != "vless-reality" || endpoint.Params.SNI != "www.microsoft.com" {
		t.Errorf("unexpected enroll endpoint: %+v", endpoint)
	}
	if endpoint.Params.Flow != "xtls-rprx-vision" || endpoint.Params.Network != "tcp" {
		t.Errorf("unexpected enroll params: %+v", endpoint.Params)
	}

	var resp EnrollResponse
	if err := json.Unmarshal(readFixture(t, "agent-enroll-response.json"), &resp); err != nil {
		t.Fatalf("unmarshal enroll response: %v", err)
	}
	if resp.NodeID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6" || resp.HeartbeatIntervalSeconds != 300 {
		t.Errorf("unexpected enroll response: %+v", resp)
	}
	if len(resp.Endpoints) != 1 || resp.Endpoints[0].Port != 443 || resp.Endpoints[0].Protocol != "vless-reality" {
		t.Errorf("unexpected enrolled endpoints: %+v", resp.Endpoints)
	}
}
