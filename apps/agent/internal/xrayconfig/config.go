// Package xrayconfig owns the node's Xray configuration document: it renders the
// user set into the static template and it is the only writer of the file on disk.
//
// Every path that replaces config.json (hot update, restart fallback, rollback)
// goes through ConfigStore.Write, so the atomic replacement, the file mode and the
// directory mode are defined once. The renderer itself stays a pure function over
// bytes and users; it never reads or writes the host.
//
// The credential type is shared with xraycore, which is the bottom layer of the
// agent's Xray support. This package depends on xraycore and never the reverse.
package xrayconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/zako-panel/zako-agent/internal/atomicfile"
	"github.com/zako-panel/zako-agent/internal/xraycore"
)

const (
	// configFileMode keeps the config readable by the root-owned Xray process while
	// hiding client UUIDs from unprivileged users.
	configFileMode = 0o640
	// configDirMode is used whenever the agent has to create the config directory.
	// The installer normally owns /etc/xray with 0770; a directory the agent creates
	// itself stays private to the agent user (atomicfile.Write uses the same mode).
	configDirMode = 0o700
)

// ConfigStore is the single writer of the Xray config file. It performs the atomic
// replacement and the directory preparation shared by every caller, so no caller
// invents its own temporary-file protocol.
type ConfigStore struct {
	path string
}

// NewConfigStore validates the config path.
func NewConfigStore(path string) (ConfigStore, error) {
	if strings.TrimSpace(path) == "" {
		return ConfigStore{}, errors.New("xray: config path is required")
	}
	return ConfigStore{path: path}, nil
}

// Exists reports whether the config file is present.
func (s ConfigStore) Exists() (bool, error) {
	if s.path == "" {
		return false, errors.New("xray: config path is required")
	}
	_, err := os.Stat(s.path)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	default:
		return false, fmt.Errorf("xray: stat config %s: %w", s.path, err)
	}
}

// Read returns the current document. A missing file is reported as fs.ErrNotExist
// so the apply path can distinguish "no previous config" from a read failure.
func (s ConfigStore) Read() ([]byte, error) {
	if s.path == "" {
		return nil, errors.New("xray: config path is required")
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return nil, fmt.Errorf("xray: read config %s: %w", s.path, err)
	}
	return data, nil
}

// prepareDirectory creates the config directory when it is missing. The install
// normally creates /etc/xray (0770 root:zako-agent); a directory the agent has to
// create stays private to the agent, matching atomicfile's creation mode.
func prepareDirectory(path string) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, configDirMode); err != nil {
		return fmt.Errorf("xray: prepare config directory %s: %w", directory, err)
	}
	return nil
}

// Write replaces the document atomically with the mode Xray expects.
func (s ConfigStore) Write(config []byte) error {
	if s.path == "" {
		return errors.New("xray: config path is required")
	}
	if err := prepareDirectory(s.path); err != nil {
		return err
	}
	if err := atomicfile.Write(s.path, config, configFileMode); err != nil {
		return fmt.Errorf("xray: write config %s: %w", s.path, err)
	}
	return nil
}

// Remove deletes the document. A missing file is not an error: the rollback path
// removes a config that was written to a node which had none.
func (s ConfigStore) Remove() error {
	if s.path == "" {
		return errors.New("xray: config path is required")
	}
	if err := os.Remove(s.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("xray: remove config %s: %w", s.path, err)
	}
	return nil
}

// WriteProbe writes data to a uniquely named file next to the config and returns
// its path plus the cleanup. `xray run -test -config` needs a real file, and a
// probe in the config directory proves the directory is writable with the same
// permissions the replacement file will have. CreateTemp only reserves the unique
// name; the content goes through atomicfile like a real replacement.
func (s ConfigStore) WriteProbe(data []byte) (string, func(), error) {
	if s.path == "" {
		return "", nil, errors.New("xray: config path is required")
	}
	if err := prepareDirectory(s.path); err != nil {
		return "", nil, err
	}
	directory := filepath.Dir(s.path)
	probe, err := os.CreateTemp(directory, ".zako-agent-config-test-*.json")
	if err != nil {
		return "", nil, fmt.Errorf("xray: create config probe: %w", err)
	}
	name := probe.Name()
	if err := probe.Close(); err != nil {
		_ = os.Remove(name)
		return "", nil, fmt.Errorf("xray: close config probe: %w", err)
	}
	cleanup := func() { _ = os.Remove(name) }
	if err := atomicfile.Write(name, data, configFileMode); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("xray: write config probe: %w", err)
	}
	return name, cleanup, nil
}

// ConfigFile is the on-disk Xray config the agent keeps in sync with the applied
// user set. The file stays the node's single source of truth after a restart:
// Xray reloads it and does not know about users that only existed in memory.
type ConfigFile struct {
	Path string
	// RealityPrivateKeyPath is the local node key. The key never leaves the node,
	// so it is merged into the rendered config instead of arriving from the Worker.
	RealityPrivateKeyPath string
}

func (f ConfigFile) store() (ConfigStore, error) {
	return NewConfigStore(f.Path)
}

// Exists reports whether the config file is present. The agent never invents a
// static config: without the API inbound, stats and user management cannot work.
func (f ConfigFile) Exists() (bool, error) {
	store, err := f.store()
	if err != nil {
		return false, err
	}
	return store.Exists()
}

// Static returns the current config document used as the render template.
func (f ConfigFile) Static() ([]byte, error) {
	store, err := f.store()
	if err != nil {
		return nil, err
	}
	return store.Read()
}

// Render replaces the VLESS clients and fills in the REALITY private key. See
// RenderConfig.
func (f ConfigFile) Render(static []byte, users []xraycore.User) ([]byte, error) {
	privateKey := ""
	if f.RealityPrivateKeyPath != "" {
		data, err := os.ReadFile(f.RealityPrivateKeyPath)
		switch {
		case err == nil:
			privateKey = strings.TrimSpace(string(data))
		case errors.Is(err, fs.ErrNotExist):
			// The template may already carry the key; RenderConfig only fails when
			// a realitySettings block actually needs one.
		default:
			return nil, fmt.Errorf("xray: read REALITY private key %s: %w", f.RealityPrivateKeyPath, err)
		}
	}
	return RenderConfig(static, users, privateKey)
}

// Write replaces the config atomically with the mode Xray expects.
func (f ConfigFile) Write(config []byte) error {
	store, err := f.store()
	if err != nil {
		return err
	}
	return store.Write(config)
}

// RenderConfig returns the complete config document for users.
//
// Only the clients of the single VLESS inbound are replaced: every other field,
// including the API inbound, routing, policy and the REALITY parameters, is
// preserved so the panel keeps owning the static definition. Unknown fields are
// carried through because the document is decoded as generic JSON rather than
// into a struct.
//
// privateKey is merged into each realitySettings block that lacks one. A config
// that already carries a key keeps it, which lets an operator pin a key that is
// not stored in reality_private_key_path.
func RenderConfig(static []byte, users []xraycore.User, privateKey string) ([]byte, error) {
	var document map[string]any
	if err := json.Unmarshal(static, &document); err != nil {
		return nil, fmt.Errorf("xray: decode config: %w", err)
	}

	inbounds, ok := document["inbounds"].([]any)
	if !ok {
		return nil, errors.New("xray: config has no inbounds array")
	}

	vlessInbounds := 0
	for index, raw := range inbounds {
		inbound, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if protocol, _ := inbound["protocol"].(string); protocol != "vless" {
			continue
		}
		vlessInbounds++
		if vlessInbounds > 1 {
			return nil, errors.New("xray: config has more than one vless inbound; the user set would be ambiguous")
		}

		settings, ok := inbound["settings"].(map[string]any)
		if !ok {
			return nil, errors.New("xray: vless inbound has no settings object")
		}
		settings["clients"] = renderClients(users)
		if err := mergeRealityPrivateKey(inbound, privateKey); err != nil {
			return nil, err
		}
		inbounds[index] = inbound
	}
	if vlessInbounds == 0 {
		return nil, errors.New("xray: config has no vless inbound")
	}
	document["inbounds"] = inbounds

	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("xray: encode config: %w", err)
	}
	return append(encoded, '\n'), nil
}

// renderClients emits the client list in email order so two renders of the same
// set produce identical bytes and cannot look like a spurious config change.
func renderClients(users []xraycore.User) []any {
	sorted := make([]xraycore.User, len(users))
	copy(sorted, users)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Email < sorted[j].Email })

	clients := make([]any, 0, len(sorted))
	for _, user := range sorted {
		flow := user.Flow
		if flow == "" {
			flow = xraycore.FlowVision
		}
		clients = append(clients, map[string]any{
			"id":    user.UUID,
			"flow":  flow,
			"email": user.Email,
			"level": 0,
		})
	}
	return clients
}

func mergeRealityPrivateKey(inbound map[string]any, privateKey string) error {
	stream, ok := inbound["streamSettings"].(map[string]any)
	if !ok {
		return nil
	}
	reality, ok := stream["realitySettings"].(map[string]any)
	if !ok {
		return nil
	}
	if existing, _ := reality["privateKey"].(string); existing != "" {
		return nil
	}
	if privateKey == "" {
		return errors.New("xray: realitySettings has no privateKey and no local REALITY key was provided")
	}
	reality["privateKey"] = privateKey
	return nil
}
