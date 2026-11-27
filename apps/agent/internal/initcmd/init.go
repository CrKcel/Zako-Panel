// Package initcmd implements `zako-agent init` for node enrollment.
//
// Enrollment adopts the node's existing Xray configuration: the document is
// inspected for inbounds the panel can manage, each becomes a panel endpoint with
// the parameters of its own protocol, and a node without any configuration receives
// the default template. The derived REALITY public keys are reported with the node
// name, and the permanent agent token plus YAML configuration are written
// atomically.
package initcmd

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/zako-panel/zako-agent/internal/atomicfile"
	"github.com/zako-panel/zako-agent/internal/config"
	"github.com/zako-panel/zako-agent/internal/reporter"
	"github.com/zako-panel/zako-agent/internal/xrayconfig"
	"github.com/zako-panel/zako-agent/internal/xraycore"
)

// maxEnrollEndpoints mirrors the panel's per-enrollment endpoint limit, which its
// request schema enforces before the service sees the payload.
const maxEnrollEndpoints = 16

// Options configures a single enrollment run.
type Options struct {
	PanelURL       string
	Token          string
	NodeName       string
	Host           string
	ConfigPath     string
	TokenFile      string
	RealityKeyPath string
	XrayConfigPath string
	XrayBinaryPath string
	AgentVersion   string
	XrayVersion    string
}

// Output is printed as JSON to stdout after enrollment succeeds; it never
// contains the enrollment token or the permanent agent token.
type Output struct {
	NodeID         string           `json:"node_id"`
	Host           string           `json:"host"`
	XrayConfigPath string           `json:"xray_config_path"`
	CreatedConfig  bool             `json:"created_config"`
	EndpointCount  int              `json:"endpoint_count"`
	Endpoints      []OutputEndpoint `json:"endpoints"`
}

// OutputEndpoint describes one endpoint stored by the panel.
type OutputEndpoint struct {
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
}

// Run parses CLI flags for `zako-agent init` and executes enrollment.
func Run(ctx context.Context, args []string, agentVersion string, stdout io.Writer) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	var opts Options
	opts.AgentVersion = agentVersion

	fs.StringVar(&opts.PanelURL, "panel", "", "control plane HTTPS URL")
	fs.StringVar(&opts.Token, "token", "", "reusable panel enrollment token")
	fs.StringVar(&opts.NodeName, "name", "", "node name (defaults to hostname)")
	fs.StringVar(&opts.Host, "host", "", "public IP or domain for the node endpoints")
	fs.StringVar(&opts.ConfigPath, "config", "/etc/zako-agent/config.yaml", "path to write agent config.yaml")
	fs.StringVar(&opts.TokenFile, "token-file", "/etc/zako-agent/token", "path to write permanent agent token")
	fs.StringVar(&opts.RealityKeyPath, "reality-key", "/etc/xray/reality.key", "path to local REALITY private key")
	fs.StringVar(&opts.XrayConfigPath, "xray-config", "/etc/xray/config.json", "path to the Xray config.json to adopt or create")
	fs.StringVar(&opts.XrayBinaryPath, "xray-bin", "/usr/local/bin/xray", "path to Xray binary")
	fs.StringVar(&opts.XrayVersion, "xray-version", "", "installed Xray version")

	if err := fs.Parse(args); err != nil {
		return err
	}

	client := &http.Client{Timeout: 20 * time.Second}
	out, err := Execute(ctx, opts, client)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return fmt.Errorf("marshal init output: %w", err)
	}
	_, err = fmt.Fprintln(stdout, string(encoded))
	return err
}

// Execute performs enrollment using the provided HTTP client so tests can inject
// an httptest.Server without touching the network.
func Execute(ctx context.Context, opts Options, client *http.Client) (*Output, error) {
	panelURL := strings.TrimRight(strings.TrimSpace(opts.PanelURL), "/")
	if panelURL == "" {
		return nil, errors.New("init: --panel is required")
	}
	if strings.TrimSpace(opts.Token) == "" {
		return nil, errors.New("init: --token is required")
	}
	if strings.TrimSpace(opts.Host) == "" {
		return nil, errors.New("init: --host is required")
	}
	if strings.TrimSpace(opts.XrayConfigPath) == "" {
		return nil, errors.New("init: --xray-config is required")
	}

	nodeName := strings.TrimSpace(opts.NodeName)
	if nodeName == "" {
		hostname, err := os.Hostname()
		if err != nil || strings.TrimSpace(hostname) == "" {
			return nil, errors.New("init: --name is required when hostname is unavailable")
		}
		nodeName = hostname
	}

	privateKey, err := readRealityPrivateKey(opts.RealityKeyPath)
	if err != nil {
		return nil, err
	}
	shortID, err := randomShortID()
	if err != nil {
		return nil, err
	}
	existing, err := readExistingConfig(opts.XrayConfigPath)
	if err != nil {
		return nil, err
	}

	prepared, err := xrayconfig.PrepareDocument(existing, privateKey, shortID)
	if err != nil {
		return nil, err
	}
	if len(prepared.Endpoints) == 0 {
		return nil, errors.New("init: no endpoint could be adopted from the Xray configuration")
	}

	rep, err := reporter.New(panelURL, opts.Token, client)
	if err != nil {
		return nil, err
	}

	endpoints, dropped := enrollEndpoints(prepared.Endpoints)
	if dropped > 0 {
		// The panel validates each protocol payload and rejects the whole enrollment
		// when one is not expressible, so an adopted inbound the panel cannot describe
		// is reported and left unmanaged instead of aborting the install.
		fmt.Fprintf(os.Stderr, "init: %d adopted inbound(s) cannot be described by the panel and stay unmanaged\n", dropped)
	}
	if len(endpoints) > maxEnrollEndpoints {
		// The panel accepts a bounded endpoint list; reporting more fails the whole
		// enrollment with a payload the node can never make acceptable.
		fmt.Fprintf(os.Stderr, "init: reporting the first %d of %d adopted inbound(s)\n", maxEnrollEndpoints, len(endpoints))
		endpoints = endpoints[:maxEnrollEndpoints]
	}
	resp, err := rep.Enroll(ctx, &reporter.EnrollRequest{
		Name:         nodeName,
		Host:         strings.TrimSpace(opts.Host),
		AgentVersion: opts.AgentVersion,
		XrayVersion:  strings.TrimSpace(opts.XrayVersion),
		Endpoints:    endpoints,
	})
	if err != nil {
		return nil, err
	}

	if err := atomicfile.Write(opts.TokenFile, []byte(resp.AgentToken+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("write agent token: %w", err)
	}

	hbInterval := time.Duration(resp.HeartbeatIntervalSeconds) * time.Second
	if hbInterval == 0 {
		hbInterval = 5 * time.Minute
	}
	inboundTag := prepared.Endpoints[0].Tag
	if inboundTag == "" {
		inboundTag = "vless-reality"
	}
	apiAddress := prepared.APIAddress
	if apiAddress == "" {
		apiAddress = "127.0.0.1:10085"
	}
	cfg := config.Config{
		ControlPlaneURL:       panelURL,
		NodeID:                resp.NodeID,
		AgentTokenFile:        opts.TokenFile,
		StatePath:             "/var/lib/zako-agent/state.db",
		UsersPath:             "/var/lib/zako-agent/users.json",
		XrayConfigPath:        opts.XrayConfigPath,
		XrayBinaryPath:        opts.XrayBinaryPath,
		RealityPrivateKeyPath: opts.RealityKeyPath,
		XrayAPIAddress:        apiAddress,
		XrayInboundTag:        inboundTag,
		HeartbeatInterval:     config.Duration(hbInterval),
		Collector: config.CollectorConfig{
			SampleInterval: config.Duration(30 * time.Second),
			ReportInterval: config.Duration(15 * time.Minute),
		},
	}
	cfgBytes, err := yaml.Marshal(&cfg)
	if err != nil {
		return nil, fmt.Errorf("marshal config: %w", err)
	}
	if err := atomicfile.Write(opts.ConfigPath, cfgBytes, 0o640); err != nil {
		return nil, fmt.Errorf("write config: %w", err)
	}

	// The document is written after enrollment so a rejected enrollment leaves
	// the node's existing Xray configuration untouched.
	store, err := xrayconfig.NewConfigStore(opts.XrayConfigPath)
	if err != nil {
		return nil, err
	}
	if err := store.Write(prepared.Document); err != nil {
		return nil, err
	}

	out := &Output{
		NodeID:         resp.NodeID,
		Host:           strings.TrimSpace(opts.Host),
		XrayConfigPath: opts.XrayConfigPath,
		CreatedConfig:  prepared.Created,
		EndpointCount:  len(prepared.Endpoints),
	}
	for _, endpoint := range prepared.Endpoints {
		out.Endpoints = append(out.Endpoints, OutputEndpoint{
			Name:     endpoint.Name,
			Protocol: string(endpoint.Protocol),
			Port:     endpoint.Port,
		})
	}
	return out, nil
}

// enrollEndpoints maps adopted endpoints onto the enrollment payload and reports how
// many were left out because the panel has no payload for their protocol. The
// panel rejects the whole enrollment on one unknown protocol, so dropping the entry
// keeps the node's other inbounds manageable.
func enrollEndpoints(endpoints []xrayconfig.ManagedEndpoint) ([]reporter.EnrollEndpoint, int) {
	result := make([]reporter.EnrollEndpoint, 0, len(endpoints))
	for _, endpoint := range endpoints {
		params, ok := enrollParams(endpoint)
		if !ok {
			continue
		}
		result = append(result, reporter.EnrollEndpoint{
			Name:     endpoint.Name,
			Protocol: string(endpoint.Protocol),
			Port:     endpoint.Port,
			Params:   params,
		})
	}
	return result, len(endpoints) - len(result)
}

// enrollParams maps an adopted endpoint onto the panel's payload for its protocol.
// The panel validates the payload per protocol, so an unknown protocol is an error
// instead of a generic parameter object.
func enrollParams(endpoint xrayconfig.ManagedEndpoint) (reporter.EnrollEndpointParams, bool) {
	switch endpoint.Protocol {
	case xraycore.ProtocolVlessReality:
		return reporter.VlessRealityParams{
			SNI:         endpoint.Params.SNI,
			PublicKey:   endpoint.Params.PublicKey,
			ShortID:     endpoint.Params.ShortID,
			Fingerprint: endpoint.Params.Fingerprint,
			Flow:        endpoint.Params.Flow,
			Network:     endpoint.Params.Network,
		}, true
	case xraycore.ProtocolVmess:
		return reporter.VmessParams{
			Security: endpoint.Params.Security,
			SNI:      endpoint.Params.SNI,
			Network:  endpoint.Params.Network,
			Path:     endpoint.Params.Path,
			Host:     endpoint.Params.Host,
		}, true
	case xraycore.ProtocolTrojan:
		return reporter.TrojanParams{
			SNI:     endpoint.Params.SNI,
			Network: endpoint.Params.Network,
			Path:    endpoint.Params.Path,
			Host:    endpoint.Params.Host,
		}, true
	case xraycore.ProtocolShadowsocks:
		return reporter.ShadowsocksParams{Method: endpoint.Params.Method}, true
	default:
		return nil, false
	}
}

func readExistingConfig(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		return data, nil
	case errors.Is(err, fs.ErrNotExist):
		return nil, nil
	default:
		return nil, fmt.Errorf("read xray config %s: %w", path, err)
	}
}

func readRealityPrivateKey(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read reality key %s: %w", path, err)
	}
	key := strings.TrimSpace(string(data))
	if key == "" {
		return "", fmt.Errorf("reality key %s is empty", path)
	}
	return key, nil
}

func randomShortID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("generate short id: %w", err)
	}
	return hex.EncodeToString(buf[:]), nil
}
