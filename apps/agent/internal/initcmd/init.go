// Package initcmd implements `zako-agent init` for one-time node enrollment.
//
// It derives the REALITY public key from the local private key, registers the
// node with the control plane using a one-time enrollment token, and writes
// the permanent agent token and YAML configuration atomically.
package initcmd

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/zako-panel/zako-agent/internal/atomicfile"
	"github.com/zako-panel/zako-agent/internal/config"
	"github.com/zako-panel/zako-agent/internal/reporter"
)

// Options configures a single enrollment run.
type Options struct {
	PanelURL       string
	Token          string
	NodeName       string
	Host           string
	Port           int
	SNI            string
	ShortID        string
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
	NodeID    string `json:"node_id"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	SNI       string `json:"sni"`
	ShortID   string `json:"short_id"`
	PublicKey string `json:"public_key"`
}

// Run parses CLI flags for `zako-agent init` and executes enrollment.
func Run(ctx context.Context, args []string, agentVersion string, stdout io.Writer) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	var opts Options
	opts.AgentVersion = agentVersion

	fs.StringVar(&opts.PanelURL, "panel", "", "control plane HTTPS URL")
	fs.StringVar(&opts.Token, "token", "", "one-time enrollment token from the panel")
	fs.StringVar(&opts.NodeName, "name", "", "node name (defaults to hostname)")
	fs.StringVar(&opts.Host, "host", "", "public IP or domain for the node endpoint")
	fs.IntVar(&opts.Port, "port", 0, "optional VLESS endpoint port override")
	fs.StringVar(&opts.SNI, "sni", "", "optional REALITY SNI override")
	fs.StringVar(&opts.ShortID, "short-id", "", "REALITY short id hex string (generated if omitted)")
	fs.StringVar(&opts.ConfigPath, "config", "/etc/zako-agent/config.yaml", "path to write agent config.yaml")
	fs.StringVar(&opts.TokenFile, "token-file", "/etc/zako-agent/token", "path to write permanent agent token")
	fs.StringVar(&opts.RealityKeyPath, "reality-key", "/etc/xray/reality.key", "path to local REALITY private key")
	fs.StringVar(&opts.XrayConfigPath, "xray-config", "/etc/xray/config.json", "path to Xray config.json")
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

	nodeName := strings.TrimSpace(opts.NodeName)
	if nodeName == "" {
		hostname, err := os.Hostname()
		if err != nil || strings.TrimSpace(hostname) == "" {
			return nil, errors.New("init: --name is required when hostname is unavailable")
		}
		nodeName = hostname
	}

	publicKey, err := deriveRealityPublicKey(opts.RealityKeyPath)
	if err != nil {
		return nil, err
	}

	shortID := strings.TrimSpace(opts.ShortID)
	if shortID == "" {
		shortID, err = randomShortID()
		if err != nil {
			return nil, err
		}
	}

	rep, err := reporter.New(panelURL, opts.Token, client)
	if err != nil {
		return nil, err
	}

	resp, err := rep.Enroll(ctx, &reporter.EnrollRequest{
		Name:             nodeName,
		Host:             strings.TrimSpace(opts.Host),
		Port:             opts.Port,
		SNI:              strings.TrimSpace(opts.SNI),
		RealityPublicKey: publicKey,
		RealityShortID:   shortID,
		AgentVersion:     opts.AgentVersion,
		XrayVersion:      strings.TrimSpace(opts.XrayVersion),
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
	cfg := config.Config{
		ControlPlaneURL:       panelURL,
		NodeID:                resp.NodeID,
		AgentTokenFile:        opts.TokenFile,
		StatePath:             "/var/lib/zako-agent/state.db",
		UsersPath:             "/var/lib/zako-agent/users.json",
		XrayConfigPath:        opts.XrayConfigPath,
		XrayBinaryPath:        opts.XrayBinaryPath,
		RealityPrivateKeyPath: opts.RealityKeyPath,
		XrayAPIAddress:        "127.0.0.1:10085",
		XrayInboundTag:        "vless-reality",
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

	return &Output{
		NodeID:    resp.NodeID,
		Host:      resp.Endpoint.Host,
		Port:      resp.Endpoint.Port,
		SNI:       resp.Endpoint.SNI,
		ShortID:   resp.Endpoint.ShortID,
		PublicKey: publicKey,
	}, nil
}

// deriveRealityPublicKey decodes the base64url raw X25519 private key written by
// `xray x25519` and computes the matching base64url raw public key.
func deriveRealityPublicKey(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read reality key %s: %w", path, err)
	}
	trimmed := strings.TrimSpace(string(raw))
	keyBytes, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil {
		keyBytes, err = base64.URLEncoding.DecodeString(trimmed)
		if err != nil {
			return "", fmt.Errorf("decode reality key %s: %w", path, err)
		}
	}
	priv, err := ecdh.X25519().NewPrivateKey(keyBytes)
	if err != nil {
		return "", fmt.Errorf("invalid reality x25519 private key: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()), nil
}

func randomShortID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("generate short id: %w", err)
	}
	return hex.EncodeToString(buf[:]), nil
}
