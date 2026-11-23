package xrayconfig

import (
	"crypto/ecdh"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
)

// The panel manages exactly one protocol shape on a node: VLESS over REALITY on
// TCP. Every other inbound keeps its configuration when the agent rewrites the
// document, so a node that already serves other protocols keeps doing so.
const (
	DefaultSNI         = "www.microsoft.com"
	DefaultPort        = 443
	DefaultFingerprint = "chrome"
	DefaultFlow        = "xtls-rprx-vision"
	DefaultNetwork     = "tcp"
)

//go:embed default-template.json
var defaultTemplate []byte

// ManagedEndpoint is one inbound the panel can render into subscriptions. Name
// comes from the inbound tag so endpoints adopted from an existing config stay
// recognisable in the panel.
type ManagedEndpoint struct {
	Name        string
	Tag         string
	Port        int
	SNI         string
	PublicKey   string
	ShortID     string
	Fingerprint string
	Flow        string
	Network     string
}

// Prepared is the outcome of inspecting a node's existing Xray document.
type Prepared struct {
	Document  []byte
	Endpoints []ManagedEndpoint
	// Created reports that the document was built from the default template,
	// which only happens when the node had no configuration at all.
	Created bool
	// APIAddress is the loopback gRPC address of the management inbound.
	APIAddress string
}

// PublicKeyFromPrivateKey derives the base64url REALITY public key from the raw
// X25519 private key that `xray x25519` writes. The panel only ever receives the
// public half.
func PublicKeyFromPrivateKey(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("xray: REALITY private key is empty")
	}
	keyBytes, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil {
		keyBytes, err = base64.URLEncoding.DecodeString(trimmed)
		if err != nil {
			return "", fmt.Errorf("xray: decode REALITY private key: %w", err)
		}
	}
	privateKey, err := ecdh.X25519().NewPrivateKey(keyBytes)
	if err != nil {
		return "", fmt.Errorf("xray: invalid REALITY private key: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(privateKey.PublicKey().Bytes()), nil
}

// PrepareDocument inspects an existing Xray configuration and returns the
// document the agent will keep on disk plus the endpoints the panel can manage.
//
// An existing document is preserved: managed inbounds only gain a local
// REALITY private key when they lack one, and when no managed inbound exists a
// single default VLESS + REALITY inbound is appended. A node without any
// configuration receives the default template.
func PrepareDocument(existing []byte, privateKey, shortID string) (Prepared, error) {
	if len(strings.TrimSpace(string(existing))) == 0 {
		document, err := defaultDocument(privateKey, shortID)
		if err != nil {
			return Prepared{}, err
		}
		var root map[string]any
		if err := json.Unmarshal(document, &root); err != nil {
			return Prepared{}, fmt.Errorf("xray: decode default config: %w", err)
		}
		endpoints, err := endpointsFromDocument(root)
		if err != nil {
			return Prepared{}, err
		}
		apiAddress, err := ensureManagement(root)
		if err != nil {
			return Prepared{}, err
		}
		encoded, err := json.MarshalIndent(root, "", "  ")
		if err != nil {
			return Prepared{}, fmt.Errorf("xray: encode default config: %w", err)
		}
		return Prepared{Document: append(encoded, '\n'), Endpoints: endpoints, Created: true, APIAddress: apiAddress}, nil
	}

	var root map[string]any
	if err := json.Unmarshal(existing, &root); err != nil {
		return Prepared{}, fmt.Errorf("xray: decode existing config: %w", err)
	}
	if _, ok := root["inbounds"].([]any); !ok {
		return Prepared{}, errors.New("xray: existing config has no inbounds array")
	}

	ensureManagedTags(root)
	for _, inbound := range managedInbounds(root) {
		if err := mergeRealityPrivateKey(inbound, privateKey); err != nil {
			return Prepared{}, err
		}
	}
	endpoints, err := endpointsFromDocument(root)
	if err != nil {
		return Prepared{}, err
	}
	if len(endpoints) == 0 {
		inbound, appendErr := defaultInbound(root, privateKey, shortID)
		if appendErr != nil {
			return Prepared{}, appendErr
		}
		root["inbounds"] = append(root["inbounds"].([]any), inbound)
		endpoints, err = endpointsFromDocument(root)
		if err != nil {
			return Prepared{}, err
		}
	}

	apiAddress, err := ensureManagement(root)
	if err != nil {
		return Prepared{}, err
	}

	encoded, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return Prepared{}, fmt.Errorf("xray: encode config: %w", err)
	}
	return Prepared{Document: append(encoded, '\n'), Endpoints: endpoints, APIAddress: apiAddress}, nil
}

// ManagedInboundTags returns the tags of the inbounds HandlerService must mutate.
// Inbounds without a tag are skipped: the panel cannot address them.
func ManagedInboundTags(document []byte) ([]string, error) {
	var root map[string]any
	if err := json.Unmarshal(document, &root); err != nil {
		return nil, fmt.Errorf("xray: decode config: %w", err)
	}
	managed := managedInbounds(root)
	tags := make([]string, 0, len(managed))
	for _, inbound := range managed {
		if tag, _ := inbound["tag"].(string); tag != "" {
			tags = append(tags, tag)
		}
	}
	return tags, nil
}

func defaultDocument(privateKey, shortID string) ([]byte, error) {
	var root map[string]any
	if err := json.Unmarshal(defaultTemplate, &root); err != nil {
		return nil, fmt.Errorf("xray: decode default template: %w", err)
	}
	managed := managedInbounds(root)
	if len(managed) != 1 {
		return nil, errors.New("xray: default template must contain exactly one managed inbound")
	}
	inbound := managed[0]
	if err := mergeRealityPrivateKey(inbound, privateKey); err != nil {
		return nil, err
	}
	applyRealityTarget(inbound, DefaultSNI)
	if shortID != "" {
		setRealityShortIDs(inbound, []string{shortID})
	}
	encoded, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("xray: encode default config: %w", err)
	}
	return append(encoded, '\n'), nil
}

// defaultInbound builds an additional managed inbound for a document that has
// no supported inbound. It keeps every existing entry untouched and picks a port
// no other inbound already listens on.
func defaultInbound(root map[string]any, privateKey, shortID string) (map[string]any, error) {
	document, err := defaultDocument(privateKey, shortID)
	if err != nil {
		return nil, err
	}
	var templateRoot map[string]any
	if err := json.Unmarshal(document, &templateRoot); err != nil {
		return nil, fmt.Errorf("xray: decode default config: %w", err)
	}
	managed := managedInbounds(templateRoot)
	if len(managed) != 1 {
		return nil, errors.New("xray: default template must contain exactly one managed inbound")
	}

	port, err := freePort(root)
	if err != nil {
		return nil, err
	}
	inbound := managed[0]
	inbound["port"] = float64(port)
	inbound["tag"] = uniqueTag(root, fmt.Sprintf("vless-reality-%d", port))
	return inbound, nil
}

// ensureManagedTags gives an untagged managed inbound a stable name. HandlerService
// addresses inbounds by tag, so without one the panel could not hot-update it.
func ensureManagedTags(root map[string]any) {
	for _, inbound := range managedInbounds(root) {
		if tag, _ := inbound["tag"].(string); tag != "" {
			continue
		}
		port, _ := intValue(inbound["port"])
		inbound["tag"] = uniqueTag(root, fmt.Sprintf("vless-reality-%d", port))
	}
}

// uniqueTag keeps an appended inbound from colliding with a tag the node already
// uses, which would make the whole document fail validation.
func uniqueTag(root map[string]any, base string) string {
	used := make(map[string]bool)
	for _, inbound := range inboundsOf(root) {
		if tag, _ := inbound["tag"].(string); tag != "" {
			used[tag] = true
		}
	}
	candidate := base
	for suffix := 2; used[candidate]; suffix++ {
		candidate = fmt.Sprintf("%s-%d", base, suffix)
	}
	return candidate
}

func freePort(root map[string]any) (int, error) {
	used := make(map[int]bool)
	for _, inbound := range inboundsOf(root) {
		if port, ok := intValue(inbound["port"]); ok {
			used[port] = true
		}
	}
	for _, candidate := range []int{443, 8443, 2053, 2083, 2087, 2096} {
		if !used[candidate] {
			return candidate, nil
		}
	}
	return 0, errors.New("xray: no free port is available for the default VLESS inbound")
}

func managedInbounds(root map[string]any) []map[string]any {
	var managed []map[string]any
	for _, inbound := range inboundsOf(root) {
		if isManagedInbound(inbound) {
			managed = append(managed, inbound)
		}
	}
	return managed
}

func inboundsOf(root map[string]any) []map[string]any {
	raw, ok := root["inbounds"].([]any)
	if !ok {
		return nil
	}
	inbounds := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		if inbound, ok := entry.(map[string]any); ok {
			inbounds = append(inbounds, inbound)
		}
	}
	return inbounds
}

// isManagedInbound is the single definition of what the panel owns. Everything
// else in the document is untouched by every render and apply path.
func isManagedInbound(inbound map[string]any) bool {
	protocol, _ := inbound["protocol"].(string)
	if protocol != "vless" {
		return false
	}
	stream, ok := inbound["streamSettings"].(map[string]any)
	if !ok {
		return false
	}
	security, _ := stream["security"].(string)
	if security != "reality" {
		return false
	}
	network, _ := stream["network"].(string)
	return network == "" || network == DefaultNetwork
}

func endpointsFromDocument(root map[string]any) ([]ManagedEndpoint, error) {
	var endpoints []ManagedEndpoint
	for _, inbound := range managedInbounds(root) {
		port, ok := intValue(inbound["port"])
		if !ok || port < 1 || port > 65535 {
			return nil, errors.New("xray: managed inbound has no valid port")
		}
		stream, _ := inbound["streamSettings"].(map[string]any)
		reality, ok := stream["realitySettings"].(map[string]any)
		if !ok {
			return nil, errors.New("xray: managed inbound has no realitySettings")
		}
		sni, err := realitySNI(reality)
		if err != nil {
			return nil, err
		}
		privateKey, _ := reality["privateKey"].(string)
		publicKey, err := PublicKeyFromPrivateKey(privateKey)
		if err != nil {
			return nil, fmt.Errorf("xray: managed inbound privateKey: %w", err)
		}
		tag, _ := inbound["tag"].(string)
		name := endpointName(tag, port)
		fingerprint, _ := reality["fingerprint"].(string)
		if fingerprint == "" {
			fingerprint = DefaultFingerprint
		}
		endpoints = append(endpoints, ManagedEndpoint{
			Name:        name,
			Tag:         tag,
			Port:        port,
			SNI:         sni,
			PublicKey:   publicKey,
			ShortID:     firstString(reality["shortIds"]),
			Fingerprint: fingerprint,
			Flow:        DefaultFlow,
			Network:     DefaultNetwork,
		})
	}
	return endpoints, nil
}

// endpointName keeps a panel endpoint name inside the contract limit. Inbound
// tags are not length-limited, but the panel validates endpoint names at 64.
func endpointName(tag string, port int) string {
	name := strings.TrimSpace(tag)
	if name == "" {
		name = fmt.Sprintf("vless-reality-%d", port)
	}
	runes := []rune(name)
	if len(runes) > 64 {
		name = string(runes[:64])
	}
	return name
}

func realitySNI(reality map[string]any) (string, error) {
	if sni := firstString(reality["serverNames"]); sni != "" {
		return sni, nil
	}
	if dest, _ := reality["dest"].(string); dest != "" {
		if host, _, err := net.SplitHostPort(dest); err == nil && host != "" {
			return host, nil
		}
	}
	return "", errors.New("xray: realitySettings has no serverNames or dest")
}

func applyRealityTarget(inbound map[string]any, sni string) {
	stream, ok := inbound["streamSettings"].(map[string]any)
	if !ok {
		return
	}
	reality, ok := stream["realitySettings"].(map[string]any)
	if !ok {
		return
	}
	reality["dest"] = sni + ":443"
	reality["serverNames"] = []any{sni}
}

func setRealityShortIDs(inbound map[string]any, shortIDs []string) {
	stream, ok := inbound["streamSettings"].(map[string]any)
	if !ok {
		return
	}
	reality, ok := stream["realitySettings"].(map[string]any)
	if !ok {
		return
	}
	values := make([]any, 0, len(shortIDs))
	for _, shortID := range shortIDs {
		values = append(values, shortID)
	}
	reality["shortIds"] = values
}

func firstString(value any) string {
	items, ok := value.([]any)
	if !ok {
		return ""
	}
	for _, item := range items {
		if text, ok := item.(string); ok && text != "" {
			return text
		}
	}
	return ""
}

func intValue(value any) (int, bool) {
	switch number := value.(type) {
	case float64:
		return int(number), true
	case json.Number:
		parsed, err := strconv.Atoi(number.String())
		return parsed, err == nil
	case string:
		parsed, err := strconv.Atoi(number)
		return parsed, err == nil
	default:
		return 0, false
	}
}

// ensureManagement keeps an adopted document observable and controllable: the
// agent needs StatsService for traffic, HandlerService for hot user updates and a
// routing rule for the API inbound. Missing pieces are added; existing values and
// every proxy inbound are left untouched.
func ensureManagement(root map[string]any) (string, error) {
	if _, ok := root["stats"]; !ok {
		root["stats"] = map[string]any{}
	}

	policy, ok := objectField(root, "policy")
	if !ok {
		return "", errors.New("xray: existing config policy is not an object")
	}
	levels, ok := objectField(policy, "levels")
	if !ok {
		return "", errors.New("xray: existing config policy.levels is not an object")
	}
	level0, ok := objectField(levels, "0")
	if !ok {
		return "", errors.New("xray: existing config policy.levels.0 is not an object")
	}
	setDefault(level0, "statsUserUplink", true)
	setDefault(level0, "statsUserDownlink", true)

	system, ok := objectField(policy, "system")
	if !ok {
		return "", errors.New("xray: existing config policy.system is not an object")
	}
	setDefault(system, "statsInboundUplink", true)
	setDefault(system, "statsInboundDownlink", true)

	api, ok := objectField(root, "api")
	if !ok {
		return "", errors.New("xray: existing config api is not an object")
	}
	apiTag, _ := api["tag"].(string)
	if apiTag == "" {
		apiTag = "api"
		api["tag"] = apiTag
	}
	services := stringList(api["services"])
	for _, required := range []string{"StatsService", "HandlerService"} {
		if !containsString(services, required) {
			services = append(services, required)
		}
	}
	api["services"] = services

	apiPort := 0
	if inbound := findInboundByTag(root, apiTag); inbound != nil {
		port, ok := intValue(inbound["port"])
		if !ok || port < 1 || port > 65535 {
			return "", errors.New("xray: existing api inbound has no valid port")
		}
		apiPort = port
	}
	if apiPort == 0 {
		port, err := freeAPIPort(root)
		if err != nil {
			return "", err
		}
		apiPort = port
		root["inbounds"] = append(root["inbounds"].([]any), defaultAPIInbound(apiTag, port))
	}

	routing, ok := objectField(root, "routing")
	if !ok {
		return "", errors.New("xray: existing config routing is not an object")
	}
	rules, _ := routing["rules"].([]any)
	hasAPIRule := false
	for _, raw := range rules {
		rule, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if rule["outboundTag"] != apiTag {
			continue
		}
		if containsString(stringList(rule["inboundTag"]), apiTag) {
			hasAPIRule = true
			break
		}
	}
	if !hasAPIRule {
		rules = append(rules, map[string]any{
			"type":        "field",
			"inboundTag":  []any{apiTag},
			"outboundTag": apiTag,
		})
	}
	routing["rules"] = rules

	return fmt.Sprintf("127.0.0.1:%d", apiPort), nil
}

// objectField returns an existing object or creates an empty one.
func objectField(parent map[string]any, key string) (map[string]any, bool) {
	value, exists := parent[key]
	if !exists {
		object := map[string]any{}
		parent[key] = object
		return object, true
	}
	object, ok := value.(map[string]any)
	return object, ok
}

func setDefault(object map[string]any, key string, value any) {
	if _, exists := object[key]; !exists {
		object[key] = value
	}
}

// freeAPIPort keeps the management inbound away from ports the node already uses,
// so adopting a configuration that happens to bind 10085 still validates.
func freeAPIPort(root map[string]any) (int, error) {
	used := make(map[int]bool)
	for _, inbound := range inboundsOf(root) {
		if port, ok := intValue(inbound["port"]); ok {
			used[port] = true
		}
	}
	for port := 10085; port <= 10185; port++ {
		if !used[port] {
			return port, nil
		}
	}
	return 0, errors.New("xray: no free loopback port is available for the management inbound")
}

func defaultAPIInbound(tag string, port int) map[string]any {
	return map[string]any{
		"tag":      tag,
		"listen":   "127.0.0.1",
		"port":     float64(port),
		"protocol": "dokodemo-door",
		"settings": map[string]any{"address": "127.0.0.1"},
	}
}

func findInboundByTag(root map[string]any, tag string) map[string]any {
	for _, inbound := range inboundsOf(root) {
		if current, _ := inbound["tag"].(string); current == tag {
			return inbound
		}
	}
	return nil
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
