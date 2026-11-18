package xray

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
)

// configFileMode keeps the config readable by the root-owned Xray process while
// hiding client UUIDs from unprivileged users.
const configFileMode = 0o640

// ConfigFile is the on-disk Xray config the agent keeps in sync with the applied
// user set. The file stays the node's single source of truth after a restart:
// Xray reloads it and does not know about users that only existed in memory.
type ConfigFile struct {
	Path string
	// RealityPrivateKeyPath is the local node key. The key never leaves the node,
	// so it is merged into the rendered config instead of arriving from the Worker.
	RealityPrivateKeyPath string
}

// Exists reports whether the config file is present. The agent never invents a
// static config: without the API inbound, stats and user management cannot work.
func (f ConfigFile) Exists() (bool, error) {
	if f.Path == "" {
		return false, errors.New("xray: config path is required")
	}
	_, err := os.Stat(f.Path)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	default:
		return false, fmt.Errorf("xray: stat config %s: %w", f.Path, err)
	}
}

// Static returns the current config document used as the render template.
func (f ConfigFile) Static() ([]byte, error) {
	if f.Path == "" {
		return nil, errors.New("xray: config path is required")
	}
	data, err := os.ReadFile(f.Path)
	if err != nil {
		return nil, fmt.Errorf("xray: read config %s: %w", f.Path, err)
	}
	return data, nil
}

// Render replaces the VLESS clients and fills in the REALITY private key. See
// RenderConfig.
func (f ConfigFile) Render(static []byte, users []User) ([]byte, error) {
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
	return WriteConfig(f.Path, config)
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
func RenderConfig(static []byte, users []User, privateKey string) ([]byte, error) {
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
func renderClients(users []User) []any {
	sorted := make([]User, len(users))
	copy(sorted, users)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Email < sorted[j].Email })

	clients := make([]any, 0, len(sorted))
	for _, user := range sorted {
		flow := user.Flow
		if flow == "" {
			flow = FlowVision
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
