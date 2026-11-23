import type { AgentEndpointProtocol, EndpointProtocol } from '@zako/contracts';
import { hysteria2Adapter, HYSTERIA2_PROTOCOL } from './hysteria2';
import { shadowsocksAdapter, SHADOWSOCKS_PROTOCOL } from './shadowsocks';
import { trojanAdapter, TROJAN_PROTOCOL } from './trojan';
import type { ProtocolAdapter } from './types';
import { vlessRealityAdapter, VLESS_REALITY_PROTOCOL } from './vless-reality';
import { vmessAdapter, VMESS_PROTOCOL } from './vmess';

/** Every protocol an endpoint row may store, in admin display order. */
export const PROTOCOLS = [
	VLESS_REALITY_PROTOCOL,
	VMESS_PROTOCOL,
	TROJAN_PROTOCOL,
	SHADOWSOCKS_PROTOCOL,
	HYSTERIA2_PROTOCOL,
] as const satisfies readonly EndpointProtocol[];

/**
 * Protocols a node agent can adopt and keep in sync. Hysteria2 runs outside
 * Xray, so its endpoints are declared by an operator and never reported by the
 * agent.
 */
export const AGENT_PROTOCOLS = [
	VLESS_REALITY_PROTOCOL,
	VMESS_PROTOCOL,
	TROJAN_PROTOCOL,
	SHADOWSOCKS_PROTOCOL,
] as const satisfies readonly AgentEndpointProtocol[];

const adapters = new Map<string, ProtocolAdapter>(
	[vlessRealityAdapter, vmessAdapter, trojanAdapter, shadowsocksAdapter, hysteria2Adapter].map((adapter) => [adapter.protocol, adapter]),
);

export function getProtocolAdapter(protocol: string): ProtocolAdapter | undefined {
	return adapters.get(protocol);
}

export function requireProtocolAdapter(protocol: string): ProtocolAdapter {
	const adapter = getProtocolAdapter(protocol);
	if (!adapter) throw new Error(`Unsupported protocol: ${protocol}`);
	return adapter;
}

export function isEndpointProtocol(protocol: string): protocol is EndpointProtocol {
	return adapters.has(protocol);
}

export function isAgentProtocol(protocol: string): boolean {
	return (AGENT_PROTOCOLS as readonly string[]).includes(protocol);
}
