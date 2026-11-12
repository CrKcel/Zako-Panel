import { z } from 'zod';
import { notImplemented } from '../lib/errors';
import type { ProtocolAdapter, ProxyEndpoint } from './types';

export const vlessRealityParamsSchema = z.object({
	sni: z.string().trim().min(1).max(255),
	public_key: z.string().trim().min(1).max(255),
	short_id: z.string().trim().max(32),
	fingerprint: z.enum(['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random']),
	flow: z.literal('xtls-rprx-vision'),
	network: z.literal('tcp'),
});

export type VlessRealityParams = z.infer<typeof vlessRealityParamsSchema>;

export const vlessRealityAdapter: ProtocolAdapter = {
	protocol: 'vless-reality',
	paramsSchema: vlessRealityParamsSchema,
	toClash(_endpoint: ProxyEndpoint): Record<string, unknown> {
		throw notImplemented('Clash proxy rendering');
	},
	toUri(_endpoint: ProxyEndpoint, _uuid: string): string {
		throw notImplemented('VLESS URI rendering');
	},
	toXrayInbound(_endpoint: ProxyEndpoint): Record<string, unknown> {
		throw notImplemented('Xray inbound rendering');
	},
};
