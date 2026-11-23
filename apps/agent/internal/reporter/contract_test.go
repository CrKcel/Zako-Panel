package reporter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
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

// enrollFixtureEndpoint is the write shape of one enrollment endpoint with the
// params kept raw, so the test decodes the union the same way the Worker does.
type enrollFixtureEndpoint struct {
	Name     string          `json:"name"`
	Protocol string          `json:"protocol"`
	Port     int             `json:"port"`
	Params   json.RawMessage `json:"params"`
}

// decodeEnrollParams picks the params struct named by the endpoint protocol.
func decodeEnrollParams(t *testing.T, protocol string, raw json.RawMessage) EnrollEndpointParams {
	t.Helper()
	var params EnrollEndpointParams
	switch protocol {
	case "vless-reality":
		params = &VlessRealityParams{}
	case "vmess":
		params = &VmessParams{}
	case "trojan":
		params = &TrojanParams{}
	case "shadowsocks":
		params = &ShadowsocksParams{}
	default:
		t.Fatalf("enrollment fixture uses protocol %q, which the agent cannot report", protocol)
	}
	if err := json.Unmarshal(raw, params); err != nil {
		t.Fatalf("unmarshal %s params: %v", protocol, err)
	}
	return params
}

func TestEnrollFixtures(t *testing.T) {
	data := readFixture(t, "agent-enroll.json")
	var request struct {
		Name      string                  `json:"name"`
		Host      string                  `json:"host"`
		Endpoints []enrollFixtureEndpoint `json:"endpoints"`
	}
	if err := json.Unmarshal(data, &request); err != nil {
		t.Fatalf("unmarshal enroll request: %v", err)
	}
	if request.Name != "edge-tokyo-01" || request.Host != "203.0.113.10" {
		t.Errorf("unexpected enroll request: %+v", request)
	}
	if len(request.Endpoints) == 0 {
		t.Fatal("enroll request reports no endpoints")
	}

	// The vless-reality endpoint is first: the agent keeps the existing primary
	// endpoint ahead of the added protocols.
	first := request.Endpoints[0]
	if first.Protocol != "vless-reality" || first.Port != 443 {
		t.Fatalf("first endpoint = %+v, want the vless-reality endpoint", first)
	}
	vless := decodeEnrollParams(t, first.Protocol, first.Params)
	vlessParams, ok := vless.(*VlessRealityParams)
	if !ok {
		t.Fatalf("vless params = %T", vless)
	}
	if vlessParams.SNI != "www.microsoft.com" || vlessParams.Flow != "xtls-rprx-vision" || vlessParams.Network != "tcp" {
		t.Errorf("vless params = %+v", vlessParams)
	}
	if vlessParams.PublicKey == "" || vlessParams.ShortID == "" || vlessParams.Fingerprint == "" {
		t.Errorf("vless params = %+v, want the REALITY fields", vlessParams)
	}

	// The union must also decode the added protocols when the fixture carries
	// them: a renamed field on either side has to fail here.
	for _, endpoint := range request.Endpoints[1:] {
		params := decodeEnrollParams(t, endpoint.Protocol, endpoint.Params)
		switch protocol := params.(type) {
		case *VmessParams:
			if protocol.Security != "tls" || protocol.Network != "ws" || protocol.Path != "/ws" || protocol.Host == "" {
				t.Errorf("vmess params = %+v", protocol)
			}
		case *TrojanParams:
			if protocol.Network != "grpc" || protocol.Path != "trojan-grpc" || protocol.Host != "" {
				t.Errorf("trojan params = %+v", protocol)
			}
			if protocol.SNI == "" {
				t.Errorf("trojan params = %+v, want the TLS SNI", protocol)
			}
		case *ShadowsocksParams:
			if protocol.Method != "aes-256-gcm" {
				t.Errorf("shadowsocks params = %+v", protocol)
			}
		default:
			t.Fatalf("unexpected decoded params %T", params)
		}
	}

	// The agent writes these payloads, so the fixture decode alone cannot catch a
	// broken write-side tag. Re-marshal every endpoint and compare it with the
	// fixture object, including fields that are present but empty.
	var wire struct {
		Endpoints []map[string]any `json:"endpoints"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatalf("unmarshal enroll request as wire objects: %v", err)
	}
	for index, endpoint := range request.Endpoints {
		params := decodeEnrollParams(t, endpoint.Protocol, endpoint.Params)
		encoded, err := json.Marshal(EnrollEndpoint{
			Name:     endpoint.Name,
			Protocol: endpoint.Protocol,
			Port:     endpoint.Port,
			Params:   params,
		})
		if err != nil {
			t.Fatalf("marshal %s endpoint: %v", endpoint.Protocol, err)
		}
		var got map[string]any
		if err := json.Unmarshal(encoded, &got); err != nil {
			t.Fatalf("unmarshal marshaled %s endpoint: %v", endpoint.Protocol, err)
		}
		if !reflect.DeepEqual(got, wire.Endpoints[index]) {
			t.Errorf("%s endpoint = %v, want the fixture shape %v", endpoint.Protocol, got, wire.Endpoints[index])
		}
	}

	var resp EnrollResponse
	if err := json.Unmarshal(readFixture(t, "agent-enroll-response.json"), &resp); err != nil {
		t.Fatalf("unmarshal enroll response: %v", err)
	}
	if resp.NodeID != "01J2Z6Q8Y3V9M4K7T1B5C0D2E6" || resp.HeartbeatIntervalSeconds != 300 {
		t.Errorf("unexpected enroll response: %+v", resp)
	}
	if len(resp.Endpoints) == 0 {
		t.Fatal("enroll response has no endpoints")
	}
	if resp.Endpoints[0].Protocol != "vless-reality" || resp.Endpoints[0].Port != 443 {
		t.Errorf("first enrolled endpoint = %+v, want the vless-reality endpoint", resp.Endpoints[0])
	}
	// Every stored endpoint the panel returns must be addressable by name and keep
	// the protocol and port the agent reported.
	stored := make(map[string]EnrolledEndpoint, len(resp.Endpoints))
	for _, endpoint := range resp.Endpoints {
		if endpoint.ID == "" || endpoint.Name == "" || endpoint.Port < 1 || endpoint.Port > 65535 {
			t.Errorf("stored endpoint = %+v", endpoint)
		}
		switch endpoint.Protocol {
		case "vless-reality", "vmess", "trojan", "shadowsocks":
		default:
			t.Errorf("stored endpoint protocol = %q, want an agent protocol", endpoint.Protocol)
		}
		stored[endpoint.Name] = endpoint
	}
	for _, endpoint := range request.Endpoints {
		enrolled, ok := stored[endpoint.Name]
		if !ok {
			continue
		}
		if enrolled.Protocol != endpoint.Protocol || enrolled.Port != endpoint.Port {
			t.Errorf("stored endpoint %q = %+v, want protocol %q on port %d",
				endpoint.Name, enrolled, endpoint.Protocol, endpoint.Port)
		}
	}
}
