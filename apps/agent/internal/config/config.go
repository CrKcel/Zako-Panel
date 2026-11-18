// Package config loads the agent's node-local YAML configuration.
//
// Validation mirrors the deployment contract in docs/agent.md §2:
// intervals are bounded by the Worker and D1 budgets, and the control plane must
// be an absolute HTTPS origin because Agent auth is bearer-token only.
package config

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	defaultHeartbeatInterval = 5 * time.Minute
	defaultSampleInterval    = 30 * time.Second
	defaultReportInterval    = 15 * time.Minute
	// defaultXrayAPIAddress is Xray's loopback StatsService/HandlerService
	// listener configured by the installation guide.
	defaultXrayAPIAddress = "127.0.0.1:10085"
	// defaultXrayInboundTag matches the VLESS inbound tag in the shipped Xray
	// template. HandlerService addresses the inbound by tag, so a renamed inbound
	// must be reflected here or hot updates fail and fall back to a restart.
	defaultXrayInboundTag = "vless-reality"

	minHeartbeatInterval = 60 * time.Second
	maxHeartbeatInterval = 900 * time.Second
	minReportInterval    = 300 * time.Second
	maxReportInterval    = 3600 * time.Second
)

// Duration is a time.Duration that YAML encodes as a Go duration string such as
// "30s" or "5m".
type Duration time.Duration

// Duration returns the value as time.Duration.
func (d Duration) Duration() time.Duration {
	return time.Duration(d)
}

func (d Duration) String() string {
	return time.Duration(d).String()
}

// UnmarshalYAML accepts only string forms; a bare number would make the unit
// ambiguous (seconds versus nanoseconds).
func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	var raw string
	if err := node.Decode(&raw); err != nil {
		return fmt.Errorf("duration must be a string such as \"5m\": %w", err)
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", raw, err)
	}
	*d = Duration(parsed)
	return nil
}

func (d Duration) MarshalYAML() (any, error) {
	return time.Duration(d).String(), nil
}

// Config is the full /etc/zako-agent/config.yaml document.
type Config struct {
	ControlPlaneURL       string          `yaml:"control_plane_url"`
	NodeID                string          `yaml:"node_id"`
	AgentTokenFile        string          `yaml:"agent_token_file"`
	StatePath             string          `yaml:"state_path"`
	UsersPath             string          `yaml:"users_path"`
	XrayConfigPath        string          `yaml:"xray_config_path"`
	XrayBinaryPath        string          `yaml:"xray_binary_path"`
	RealityPrivateKeyPath string          `yaml:"reality_private_key_path"`
	XrayAPIAddress        string          `yaml:"xray_api_address"`
	XrayInboundTag        string          `yaml:"xray_inbound_tag"`
	HeartbeatInterval     Duration        `yaml:"heartbeat_interval"`
	Collector             CollectorConfig `yaml:"collector"`
}

// CollectorConfig holds the sampling cadence. The report interval is sent to the
// Worker only as a default; the Worker response overrides it at runtime.
type CollectorConfig struct {
	SampleInterval Duration `yaml:"sample_interval"`
	ReportInterval Duration `yaml:"report_interval"`
}

// FieldError identifies one invalid configuration field.
type FieldError struct {
	Field   string
	Problem string
}

func (e *FieldError) Error() string {
	return e.Field + ": " + e.Problem
}

// Load reads path as a single YAML document. Unknown fields are rejected so a
// typo in a security-relevant setting cannot be silently ignored. A missing file
// is an error; defaults are applied only after a successful decode.
func Load(path string) (*Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open config %s: %w", path, err)
	}
	defer file.Close()

	cfg, err := decode(file)
	if err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	return cfg, nil
}

func decode(r io.Reader) (*Config, error) {
	var cfg Config
	decoder := yaml.NewDecoder(r)
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil {
		return nil, err
	}

	cfg.applyDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) applyDefaults() {
	if c.HeartbeatInterval == 0 {
		c.HeartbeatInterval = Duration(defaultHeartbeatInterval)
	}
	if c.Collector.SampleInterval == 0 {
		c.Collector.SampleInterval = Duration(defaultSampleInterval)
	}
	if c.Collector.ReportInterval == 0 {
		c.Collector.ReportInterval = Duration(defaultReportInterval)
	}
	if strings.TrimSpace(c.XrayAPIAddress) == "" {
		c.XrayAPIAddress = defaultXrayAPIAddress
	}
	if strings.TrimSpace(c.XrayInboundTag) == "" {
		c.XrayInboundTag = defaultXrayInboundTag
	}
}

// validate aggregates every field problem so operators can fix one file in one
// pass. Bounds are inclusive, matching the D1 CHECK constraints.
func (c *Config) validate() error {
	var problems []error
	add := func(field, format string, args ...any) {
		problems = append(problems, &FieldError{Field: field, Problem: fmt.Sprintf(format, args...)})
	}

	if err := validateControlPlaneURL(c.ControlPlaneURL); err != nil {
		add("control_plane_url", "%v", err)
	}
	if strings.TrimSpace(c.NodeID) == "" {
		add("node_id", "must not be empty")
	}

	for _, required := range []struct {
		field string
		value string
	}{
		{"agent_token_file", c.AgentTokenFile},
		{"state_path", c.StatePath},
		{"users_path", c.UsersPath},
		{"xray_config_path", c.XrayConfigPath},
		{"xray_binary_path", c.XrayBinaryPath},
		{"reality_private_key_path", c.RealityPrivateKeyPath},
	} {
		if strings.TrimSpace(required.value) == "" {
			add(required.field, "must not be empty")
		}
	}

	heartbeat := c.HeartbeatInterval.Duration()
	if heartbeat < minHeartbeatInterval || heartbeat > maxHeartbeatInterval {
		add("heartbeat_interval", "must be between %s and %s, got %s",
			minHeartbeatInterval, maxHeartbeatInterval, heartbeat)
	}

	sample := c.Collector.SampleInterval.Duration()
	if sample <= 0 {
		add("collector.sample_interval", "must be greater than zero, got %s", sample)
	}

	report := c.Collector.ReportInterval.Duration()
	if report < minReportInterval || report > maxReportInterval {
		add("collector.report_interval", "must be between %s and %s, got %s",
			minReportInterval, maxReportInterval, report)
	}

	if err := validateHostPort(c.XrayAPIAddress); err != nil {
		add("xray_api_address", "%v", err)
	}

	return errors.Join(problems...)
}

// validateHostPort rejects a bare host, a bare port and non-numeric ports. The
// gRPC dialer would otherwise block until the context deadline with a confusing
// DNS error instead of failing at startup.
func validateHostPort(raw string) error {
	host, port, err := net.SplitHostPort(raw)
	if err != nil {
		return fmt.Errorf("must be host:port: %w", err)
	}
	if strings.TrimSpace(host) == "" {
		return errors.New("must include a host")
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return fmt.Errorf("must include a port between 1 and 65535, got %q", port)
	}
	return nil
}

func validateControlPlaneURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("must be a valid URL: %w", err)
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("must use the https scheme, got %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return errors.New("must include a host")
	}
	return nil
}
