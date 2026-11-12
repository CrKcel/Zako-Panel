import { vlessRealityAdapter } from './vless-reality';
import type { ProtocolAdapter } from './types';

const adapters = new Map<string, ProtocolAdapter>([[vlessRealityAdapter.protocol, vlessRealityAdapter]]);

export function getProtocolAdapter(protocol: string): ProtocolAdapter | undefined {
	return adapters.get(protocol);
}

export function requireProtocolAdapter(protocol: string): ProtocolAdapter {
	const adapter = getProtocolAdapter(protocol);
	if (!adapter) throw new Error(`Unsupported protocol: ${protocol}`);
	return adapter;
}
