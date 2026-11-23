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

	"github.com/zako-panel/zako-agent/internal/xraycore"
)

// The panel manages the proxy protocols whose parameters can be expressed from an
// inbound: VLESS over REALITY on TCP, VMess, Trojan and Shadowsocks. Every other
// inbound keeps its configuration when the agent rewrites the document, so a node
// that already serves other protocols keeps doing so.
const (
	DefaultSNI         = "www.microsoft.com"
	DefaultPort        = 443
	DefaultFingerprint = "chrome"
	DefaultFlow        = "xtls-rprx-vision"
	DefaultNetwork     = "tcp"

	xrayProtocolVless       = "vless"
	xrayProtocolVmess       = "vmess"
	xrayProtocolTrojan      = "trojan"
	xrayProtocolShadowsocks = "shadowsocks"
)

// supportedShadowsocksMethods are the ciphers whose key is the node-client secret.
// ShadowSocks-2022 methods need a fixed-length base64 key, so an inbound using one
// stays unmanaged.
var supportedShadowsocksMethods = map[string]bool{
	"aes-128-gcm":            true,
	"aes-256-gcm":            true,
	"chacha20-ietf-poly1305": true,
}

//go:embed default-template.json
var defaultTemplate []byte

// ManagedEndpoint is one inbound the panel can render into subscriptions. Name
// comes from the inbound tag so endpoints adopted from an existing config stay
// recognisable in the panel.
type ManagedEndpoint struct {
	Name     string
	Tag      string
	Protocol xraycore.Protocol
	Port     int
	Params   ManagedParams
}

// ManagedParams carries the panel parameters of an endpoint. The protocol decides
// which fields are set; the panel validates the set per protocol, so fields of
// other protocols stay empty.
type ManagedParams struct {
	// vless-reality, vmess (only when its security is tls) and trojan.
	SNI string
	// vless-reality.
	PublicKey   string
	ShortID     string
	Fingerprint string
	Flow        string
	// vless-reality, vmess and trojan.
	Network string
	// vmess: tls or none.
	Security string
	// vmess and trojan: ws path or gRPC service name, and ws Host or gRPC authority.
	Path string
	Host string
	// shadowsocks.
	Method string
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
		if err := mergeManagedRealityKey(inbound, privateKey); err != nil {
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

// ManagedInboundTargets returns the inbounds HandlerService must mutate, each with
// the protocol that selects its account encoding. Inbounds without a tag are
// skipped: the panel cannot address them.
func ManagedInboundTargets(document []byte) ([]xraycore.InboundTarget, error) {
	var root map[string]any
	if err := json.Unmarshal(document, &root); err != nil {
		return nil, fmt.Errorf("xray: decode config: %w", err)
	}
	var targets []xraycore.InboundTarget
	for _, inbound := range managedInbounds(root) {
		tag, _ := inbound["tag"].(string)
		if tag == "" {
			continue
		}
		target := xraycore.InboundTarget{Tag: tag, Protocol: protocolOf(inbound)}
		if target.Protocol == xraycore.ProtocolShadowsocks {
			target.Method = shadowsocksMethod(inbound)
		}
		targets = append(targets, target)
	}
	return targets, nil
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
	if err := mergeManagedRealityKey(inbound, privateKey); err != nil {
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
	inbound["tag"] = uniqueTag(root, defaultTag(xraycore.ProtocolVlessReality, port))
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
		inbound["tag"] = uniqueTag(root, defaultTag(protocolOf(inbound), port))
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

// isManagedInbound is the single definition of what the panel owns. An inbound is
// managed only when the panel can express its parameters; everything else in the
// document is untouched by every render and apply path.
func isManagedInbound(inbound map[string]any) bool {
	switch protocol, _ := inbound["protocol"].(string); protocol {
	case xrayProtocolVless:
		// The panel renders VLESS over REALITY on TCP only; a TLS or other
		// transport inbound stays operator-owned.
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
	case xrayProtocolVmess:
		return isManagedTransport(inbound) && vmessSecuritySupported(inbound)
	case xrayProtocolTrojan:
		return isManagedTransport(inbound) && trojanSecuritySupported(inbound)
	case xrayProtocolShadowsocks:
		return shadowsocksMethod(inbound) != ""
	default:
		return false
	}
}

// isManagedTransport reports whether the inbound runs on a transport the panel can
// render. An absent streamSettings means TCP.
func isManagedTransport(inbound map[string]any) bool {
	switch network := streamNetwork(inbound); network {
	case "", DefaultNetwork, "ws", "grpc":
		return true
	default:
		return false
	}
}

// vmessSecuritySupported accepts the modes the panel renders, plaintext and TLS.
// A TLS inbound must name its SNI: the panel requires one and would reject the
// enrollment payload, which would abort the whole install.
func vmessSecuritySupported(inbound map[string]any) bool {
	switch security := streamSecurity(inbound); security {
	case "", "none":
		return true
	case "tls":
		return tlsSNI(streamSettings(inbound)) != ""
	default:
		return false
	}
}

// trojanSecuritySupported accepts an explicitly TLS inbound or one with an unset
// security mode, and requires the SNI the client verifies. The panel always renders
// trojan with TLS, so an inbound without a SNI would be rejected with 422 and abort
// the install.
func trojanSecuritySupported(inbound map[string]any) bool {
	switch streamSecurity(inbound) {
	case "", "tls":
		return tlsSNI(streamSettings(inbound)) != ""
	default:
		return false
	}
}

// protocolOf maps a managed inbound's Xray protocol name onto the panel id.
func protocolOf(inbound map[string]any) xraycore.Protocol {
	switch protocol, _ := inbound["protocol"].(string); protocol {
	case xrayProtocolVless:
		return xraycore.ProtocolVlessReality
	case xrayProtocolVmess:
		return xraycore.ProtocolVmess
	case xrayProtocolTrojan:
		return xraycore.ProtocolTrojan
	case xrayProtocolShadowsocks:
		return xraycore.ProtocolShadowsocks
	default:
		return ""
	}
}

// shadowsocksMethod resolves the supported cipher of an inbound. Older configs put
// the method on each client instead of the inbound settings, so the first client's
// method is the fallback. An unsupported method returns "" and keeps the inbound
// unmanaged.
func shadowsocksMethod(inbound map[string]any) string {
	settings, _ := inbound["settings"].(map[string]any)
	if method, _ := settings["method"].(string); method != "" {
		if supportedShadowsocksMethods[method] {
			return method
		}
		return ""
	}
	clients, _ := settings["clients"].([]any)
	for _, raw := range clients {
		client, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		method, _ := client["method"].(string)
		if method == "" {
			continue
		}
		if supportedShadowsocksMethods[method] {
			return method
		}
		return ""
	}
	return ""
}

func endpointsFromDocument(root map[string]any) ([]ManagedEndpoint, error) {
	var endpoints []ManagedEndpoint
	for _, inbound := range managedInbounds(root) {
		port, ok := intValue(inbound["port"])
		if !ok || port < 1 || port > 65535 {
			return nil, errors.New("xray: managed inbound has no valid port")
		}
		tag, _ := inbound["tag"].(string)
		protocol := protocolOf(inbound)
		endpoint := ManagedEndpoint{
			Name:     endpointName(tag, protocol, port),
			Tag:      tag,
			Protocol: protocol,
			Port:     port,
		}
		switch protocol {
		case xraycore.ProtocolVlessReality:
			params, err := realityParams(inbound)
			if err != nil {
				return nil, err
			}
			endpoint.Params = params
		case xraycore.ProtocolVmess:
			params := transportParams(inbound)
			params.Security = "none"
			if streamSecurity(inbound) == "tls" {
				params.Security = "tls"
			}
			endpoint.Params = params
		case xraycore.ProtocolTrojan:
			endpoint.Params = transportParams(inbound)
		case xraycore.ProtocolShadowsocks:
			endpoint.Params = ManagedParams{Method: shadowsocksMethod(inbound)}
		}
		endpoints = append(endpoints, endpoint)
	}
	return endpoints, nil
}

// realityParams reports the panel's REALITY parameters and derives the public key
// from the local private key, which never leaves the node.
func realityParams(inbound map[string]any) (ManagedParams, error) {
	reality, ok := streamSettings(inbound)["realitySettings"].(map[string]any)
	if !ok {
		return ManagedParams{}, errors.New("xray: managed inbound has no realitySettings")
	}
	sni, err := realitySNI(reality)
	if err != nil {
		return ManagedParams{}, err
	}
	privateKey, _ := reality["privateKey"].(string)
	publicKey, err := PublicKeyFromPrivateKey(privateKey)
	if err != nil {
		return ManagedParams{}, fmt.Errorf("xray: managed inbound privateKey: %w", err)
	}
	fingerprint, _ := reality["fingerprint"].(string)
	if fingerprint == "" {
		fingerprint = DefaultFingerprint
	}
	return ManagedParams{
		SNI:         sni,
		PublicKey:   publicKey,
		ShortID:     firstString(reality["shortIds"]),
		Fingerprint: fingerprint,
		Flow:        DefaultFlow,
		Network:     DefaultNetwork,
	}, nil
}

// transportParams maps the stream settings of a vmess or trojan inbound onto the
// panel's transport fields.
func transportParams(inbound map[string]any) ManagedParams {
	stream := streamSettings(inbound)
	network := streamNetwork(inbound)
	if network == "" {
		network = DefaultNetwork
	}
	params := ManagedParams{Network: network, SNI: tlsSNI(stream)}
	switch network {
	case "ws":
		ws, _ := stream["wsSettings"].(map[string]any)
		params.Path, _ = ws["path"].(string)
		params.Host = headerValue(ws["headers"], "Host")
	case "grpc":
		grpc, _ := stream["grpcSettings"].(map[string]any)
		params.Path, _ = grpc["serviceName"].(string)
		params.Host, _ = grpc["authority"].(string)
	}
	return params
}

// tlsSNI reads the SNI an inbound advertises: the panel's field maps onto the first
// of tlsSettings.serverNames or its single serverName.
func tlsSNI(stream map[string]any) string {
	tls, ok := stream["tlsSettings"].(map[string]any)
	if !ok {
		return ""
	}
	if sni := firstString(tls["serverNames"]); sni != "" {
		return sni
	}
	sni, _ := tls["serverName"].(string)
	return sni
}

// streamSettings returns the inbound's streamSettings object. Missing settings mean
// a plain TCP inbound.
func streamSettings(inbound map[string]any) map[string]any {
	stream, _ := inbound["streamSettings"].(map[string]any)
	return stream
}

func streamNetwork(inbound map[string]any) string {
	network, _ := streamSettings(inbound)["network"].(string)
	return network
}

// streamSecurity returns streamSettings.security, which selects the transport
// security mode; an absent value means none.
func streamSecurity(inbound map[string]any) string {
	security, _ := streamSettings(inbound)["security"].(string)
	return security
}

// headerValue reads one ws header case-insensitively: header names are HTTP tokens,
// so a config may spell "host" instead of "Host".
func headerValue(raw any, name string) string {
	headers, ok := raw.(map[string]any)
	if !ok {
		return ""
	}
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			text, _ := value.(string)
			return text
		}
	}
	return ""
}

// endpointName keeps a panel endpoint name inside the contract limit. Inbound tags
// are not length-limited, but the panel validates endpoint names at 64.
func endpointName(tag string, protocol xraycore.Protocol, port int) string {
	name := strings.TrimSpace(tag)
	if name == "" {
		name = defaultTag(protocol, port)
	}
	runes := []rune(name)
	if len(runes) > 64 {
		name = string(runes[:64])
	}
	return name
}

// defaultTag names an untagged inbound after its protocol and port, so the tag the
// agent generates stays recognisable in the panel.
func defaultTag(protocol xraycore.Protocol, port int) string {
	return fmt.Sprintf("%s-%d", protocol, port)
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
