// Package reporter implements the agent side of the control-plane HTTP contract.
//
// The JSON shapes mirror packages/contracts/openapi.yaml and are pinned to the
// fixtures in packages/contracts/fixtures. The bearer token is unexported and is
// never included in errors, so callers can log errors and request metadata
// without leaking the credential.
package reporter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	enrollPath       = "/api/v1/agent/enroll"
	reportPath       = "/api/v1/agent/report"
	usersPath        = "/api/v1/agent/users"
	configPath       = "/api/v1/agent/config"
	configResultPath = "/api/v1/agent/config/result"
	updateResultPath = "/api/v1/agent/update/result"
	uninstallPath    = "/api/v1/agent/uninstall"
	maxResponseSize  = 1 << 20
)

// Report is one heartbeat plus optional traffic batch.
type Report struct {
	SentAt               int64     `json:"sent_at"`
	AgentVersion         string    `json:"agent_version"`
	XrayVersion          string    `json:"xray_version"`
	XrayHealthy          bool      `json:"xray_healthy"`
	StatsHealthy         bool      `json:"stats_healthy"`
	AppliedConfigVersion int64     `json:"applied_config_version"`
	UsersVer             int64     `json:"users_ver"`
	Sys                  *SysStats `json:"sys,omitempty"`
	Traffic              *Traffic  `json:"traffic,omitempty"`
}

// SysStats is optional in the report and limited to 2 KB by the Worker.
type SysStats struct {
	CPU    float64 `json:"cpu"`
	Mem    float64 `json:"mem"`
	Load   float64 `json:"load"`
	Uptime int64   `json:"uptime"`
}

// Traffic is one immutable report batch. ReportID is generated once, before the
// first send attempt, so retries remain idempotent on the Worker.
type Traffic struct {
	ReportID      string        `json:"report_id"`
	PeriodStart   int64         `json:"period_start"`
	PeriodEnd     int64         `json:"period_end"`
	HasCounterGap bool          `json:"has_counter_gap"`
	Node          TrafficNode   `json:"node"`
	Users         []TrafficUser `json:"users"`
}

type TrafficNode struct {
	UplinkBytes   int64 `json:"uplink_bytes"`
	DownlinkBytes int64 `json:"downlink_bytes"`
}

type TrafficUser struct {
	XrayEmail     string `json:"xray_email"`
	UplinkBytes   int64  `json:"uplink_bytes"`
	DownlinkBytes int64  `json:"downlink_bytes"`
}

// Directive is reserved for future control messages. Unknown types must be
// ignored by the agent rather than treated as protocol errors.
type Directive struct {
	Type    string                     `json:"type"`
	Payload map[string]json.RawMessage `json:"payload,omitempty"`
}

// UninstallDirectivePayload is the payload for Directive{Type: "uninstall"}.
type UninstallDirectivePayload struct {
	RemoveXray bool `json:"remove_xray"`
}

const (
	UninstallReasonPanelDirective = "panel_directive"
	UninstallReasonNodeCLI        = "node_cli"
)

type uninstallRequest struct {
	Reason string `json:"reason"`
}

// Response is the data object returned by POST /api/v1/agent/report. The Worker's
// intervals become authoritative for the next scheduling cycle.
type Response struct {
	AckReportID              *string     `json:"ack_report_id"`
	ServerTime               int64       `json:"server_time"`
	HeartbeatIntervalSeconds int         `json:"heartbeat_interval_seconds"`
	TrafficIntervalSeconds   int         `json:"traffic_interval_seconds"`
	UsersVer                 int64       `json:"users_ver"`
	DesiredConfigVersion     int64       `json:"desired_config_version"`
	UnknownUsers             int         `json:"unknown_users"`
	Directives               []Directive `json:"directives"`
}

// UsersResponse is the data object returned by GET /api/v1/agent/users.
type UsersResponse struct {
	Version int64  `json:"version"`
	Users   []User `json:"users"`
}

type User struct {
	XrayEmail string `json:"xray_email"`
	VlessUUID string `json:"vless_uuid"`
}

// AgentConfig is the data object returned by GET /api/v1/agent/config.
type AgentConfig struct {
	Version          int64           `json:"version"`
	DefinitionSHA256 string          `json:"definition_sha256"`
	Definition       json.RawMessage `json:"definition"`
}

type ConfigStatus string

const (
	ConfigStatusApplied ConfigStatus = "applied"
	ConfigStatusFailed  ConfigStatus = "failed"
)

// ConfigResult reports the outcome of applying a configuration version. Error is
// nil for applied results and must not contain private keys or full config.
type ConfigResult struct {
	Version   int64        `json:"version"`
	Status    ConfigStatus `json:"status"`
	AppliedAt int64        `json:"applied_at"`
	Error     *ConfigError `json:"error"`
}

type ConfigError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// UpdateResult reports the outcome of an agent self-update attempt.
type UpdateResult struct {
	TargetVersion string       `json:"target_version"`
	Status        ConfigStatus `json:"status"`
	ReportedAt    int64        `json:"reported_at"`
	Error         *ConfigError `json:"error"`
}

// Meta carries the control plane request ID used for support and log correlation.
type Meta struct {
	RequestID string `json:"request_id"`
}

type envelope[T any] struct {
	Data *T   `json:"data"`
	Meta Meta `json:"meta"`
}

// HTTPError is a non-success response from the control plane. StatusCode and
// RetryAfter stay separate from transport errors so callers can add 409/422/429
// policy later without changing this contract.
type HTTPError struct {
	StatusCode int
	Code       string
	Message    string
	RequestID  string
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "http %d", e.StatusCode)
	if e.Code != "" {
		fmt.Fprintf(&b, " %s", e.Code)
	}
	if e.Message != "" {
		fmt.Fprintf(&b, ": %s", e.Message)
	}
	if e.RequestID != "" {
		fmt.Fprintf(&b, " (request_id %s)", e.RequestID)
	}
	return b.String()
}

// Reporter sends agent reports and fetches versioned control-plane data.
type Reporter struct {
	baseURL *url.URL
	token   string
	client  *http.Client
}

// New validates the base URL and token shape. client must be non-nil so the
// caller owns timeouts and transport configuration.
func New(baseURL, token string, client *http.Client) (*Reporter, error) {
	if client == nil {
		return nil, errors.New("reporter: http client is required")
	}
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("reporter: agent token is required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("reporter: parse base url: %w", err)
	}
	if parsed.Scheme != "https" {
		return nil, fmt.Errorf("reporter: base url must use https, got %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return nil, errors.New("reporter: base url must include a host")
	}
	return &Reporter{baseURL: parsed, token: token, client: client}, nil
}

// EnrollRequest registers a new node using a one-time enrollment token and the
// endpoints the node already serves.
type EnrollRequest struct {
	Name         string           `json:"name"`
	Host         string           `json:"host"`
	AgentVersion string           `json:"agent_version,omitempty"`
	XrayVersion  string           `json:"xray_version,omitempty"`
	Endpoints    []EnrollEndpoint `json:"endpoints"`
}

// EnrollEndpointParams mirrors the panel's VLESS + REALITY parameters.
type EnrollEndpointParams struct {
	SNI         string `json:"sni"`
	PublicKey   string `json:"public_key"`
	ShortID     string `json:"short_id"`
	Fingerprint string `json:"fingerprint"`
	Flow        string `json:"flow"`
	Network     string `json:"network"`
}

// EnrollEndpoint describes one inbound the node adopted or created.
type EnrollEndpoint struct {
	Name     string               `json:"name"`
	Protocol string               `json:"protocol"`
	Port     int                  `json:"port"`
	Params   EnrollEndpointParams `json:"params"`
}

// EnrolledEndpoint is the stored endpoint returned by enrollment.
type EnrolledEndpoint struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
}

// EnrollResponse carries the permanent node credentials and stored endpoints.
type EnrollResponse struct {
	NodeID                   string             `json:"node_id"`
	AgentToken               string             `json:"agent_token"`
	HeartbeatIntervalSeconds int                `json:"heartbeat_interval_seconds"`
	Endpoints                []EnrolledEndpoint `json:"endpoints"`
}

// Enroll registers a new node with a one-time enrollment token and returns the
// permanent agent token and assigned node configuration.
func (r *Reporter) Enroll(ctx context.Context, req *EnrollRequest) (*EnrollResponse, error) {
	if req == nil {
		return nil, errors.New("reporter: enroll request is required")
	}
	result, err := r.do(ctx, http.MethodPost, enrollPath, req, nil)
	if err != nil {
		return nil, fmt.Errorf("enroll node: %w", err)
	}
	if err := result.httpError(); err != nil {
		return nil, fmt.Errorf("enroll node: %w", err)
	}

	var body envelope[EnrollResponse]
	if err := json.Unmarshal(result.body, &body); err != nil {
		return nil, fmt.Errorf("enroll node: decode response: %w", err)
	}
	if body.Data == nil {
		return nil, errors.New("enroll node: response missing data")
	}
	return body.Data, nil
}

// Submit posts one report and returns the decoded response data. It returns an
// *HTTPError for non-2xx responses, including 409/413/422/429.
func (r *Reporter) Submit(ctx context.Context, report *Report) (*Response, error) {
	if report == nil {
		return nil, errors.New("reporter: report is required")
	}
	result, err := r.do(ctx, http.MethodPost, reportPath, report, nil)
	if err != nil {
		return nil, fmt.Errorf("submit report: %w", err)
	}
	if err := result.httpError(); err != nil {
		return nil, fmt.Errorf("submit report: %w", err)
	}

	var body envelope[Response]
	if err := json.Unmarshal(result.body, &body); err != nil {
		return nil, fmt.Errorf("submit report: decode response: %w", err)
	}
	if body.Data == nil {
		return nil, errors.New("submit report: response missing data")
	}
	return body.Data, nil
}

// FetchUsers returns the node's active user set. notModified is true on HTTP 304,
// meaning the caller's ETag still identifies the current users_ver.
func (r *Reporter) FetchUsers(ctx context.Context, etag string) (users *UsersResponse, notModified bool, err error) {
	var headers http.Header
	if etag != "" {
		headers = http.Header{"If-None-Match": []string{etag}}
	}
	result, err := r.do(ctx, http.MethodGet, usersPath, nil, headers)
	if err != nil {
		return nil, false, fmt.Errorf("fetch users: %w", err)
	}
	if result.StatusCode == http.StatusNotModified {
		return nil, true, nil
	}
	if err := result.httpError(); err != nil {
		return nil, false, fmt.Errorf("fetch users: %w", err)
	}

	var body envelope[UsersResponse]
	if err := json.Unmarshal(result.body, &body); err != nil {
		return nil, false, fmt.Errorf("fetch users: decode response: %w", err)
	}
	if body.Data == nil {
		return nil, false, errors.New("fetch users: response missing data")
	}
	return body.Data, false, nil
}

// NotifyUninstall notifies the control plane that this node is uninstalling.
func (r *Reporter) NotifyUninstall(ctx context.Context, reason string) error {
	if reason == "" {
		reason = UninstallReasonNodeCLI
	}
	result, err := r.do(ctx, http.MethodPost, uninstallPath, &uninstallRequest{Reason: reason}, nil)
	if err != nil {
		return fmt.Errorf("notify uninstall: %w", err)
	}
	if err := result.httpError(); err != nil {
		return fmt.Errorf("notify uninstall: %w", err)
	}
	return nil
}

// FetchConfig returns the node's desired static configuration definition.
// hasConfig is false on HTTP 204 No Content, meaning the node is already at the
// desired version or no configuration has been published.
func (r *Reporter) FetchConfig(ctx context.Context) (cfg *AgentConfig, hasConfig bool, err error) {
	result, err := r.do(ctx, http.MethodGet, configPath, nil, nil)
	if err != nil {
		return nil, false, fmt.Errorf("fetch config: %w", err)
	}
	if result.StatusCode == http.StatusNoContent {
		return nil, false, nil
	}
	if err := result.httpError(); err != nil {
		return nil, false, fmt.Errorf("fetch config: %w", err)
	}

	var body envelope[AgentConfig]
	if err := json.Unmarshal(result.body, &body); err != nil {
		return nil, false, fmt.Errorf("fetch config: decode response: %w", err)
	}
	if body.Data == nil {
		return nil, false, errors.New("fetch config: response missing data")
	}
	return body.Data, true, nil
}

// ReportConfigResult posts the outcome of applying a configuration version.
func (r *Reporter) ReportConfigResult(ctx context.Context, configResult *ConfigResult) error {
	if configResult == nil {
		return errors.New("reporter: config result is required")
	}
	result, err := r.do(ctx, http.MethodPost, configResultPath, configResult, nil)
	if err != nil {
		return fmt.Errorf("report config result: %w", err)
	}
	if err := result.httpError(); err != nil {
		return fmt.Errorf("report config result: %w", err)
	}
	return nil
}

// ReportUpdateResult posts the outcome of an agent self-update attempt.
func (r *Reporter) ReportUpdateResult(ctx context.Context, updateResult *UpdateResult) error {
	if updateResult == nil {
		return errors.New("reporter: update result is required")
	}
	result, err := r.do(ctx, http.MethodPost, updateResultPath, updateResult, nil)
	if err != nil {
		return fmt.Errorf("report update result: %w", err)
	}
	if err := result.httpError(); err != nil {
		return fmt.Errorf("report update result: %w", err)
	}
	return nil
}

type httpResult struct {
	StatusCode int
	Header     http.Header
	body       []byte
}

func (r *Reporter) do(ctx context.Context, method, path string, payload any, headers http.Header) (*httpResult, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("encode request body: %w", err)
		}
		body = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, method, r.baseURL.JoinPath(path).String(), body)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+r.token)
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, values := range headers {
		request.Header[name] = values
	}

	response, err := r.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer response.Body.Close()

	limited := io.LimitReader(response.Body, maxResponseSize+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("%s %s: read response: %w", method, path, err)
	}
	if len(data) > maxResponseSize {
		return nil, fmt.Errorf("%s %s: response exceeds %d bytes", method, path, maxResponseSize)
	}
	return &httpResult{StatusCode: response.StatusCode, Header: response.Header.Clone(), body: data}, nil
}

func (r *httpResult) httpError() error {
	if r.StatusCode >= 200 && r.StatusCode < 300 {
		return nil
	}

	var decoded struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"request_id"`
		} `json:"error"`
	}
	// A non-JSON error body is still represented by the HTTP status alone.
	_ = json.Unmarshal(r.body, &decoded)

	return &HTTPError{
		StatusCode: r.StatusCode,
		Code:       decoded.Error.Code,
		Message:    decoded.Error.Message,
		RequestID:  decoded.Error.RequestID,
		RetryAfter: parseRetryAfter(r.Header.Get("Retry-After")),
	}
}

// parseRetryAfter accepts both delta-seconds and HTTP-date forms. Invalid values
// return zero so the caller's own backoff remains authoritative.
func parseRetryAfter(value string) time.Duration {
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		if delay := time.Until(at); delay > 0 {
			return delay
		}
	}
	return 0
}
