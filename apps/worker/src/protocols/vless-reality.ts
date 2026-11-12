import { z } from 'zod';
import { AppError } from '../lib/errors';
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

function paramsOf(endpoint: ProxyEndpoint): VlessRealityParams {
	const parsed = vlessRealityParamsSchema.safeParse(endpoint.params);
	if (!parsed.success) {
		throw new AppError('INTERNAL_ERROR', 'Stored endpoint parameters are invalid', 500);
	}
	return parsed.data;
}

/** IPv6 literals must be bracketed inside a URI authority. */
function uriHost(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export const vlessRealityAdapter: ProtocolAdapter = {
	protocol: 'vless-reality',
	paramsSchema: vlessRealityParamsSchema,
	toClash(endpoint: ProxyEndpoint, uuid: string): Record<string, unknown> {
		const params = paramsOf(endpoint);
		const proxy: Record<string, unknown> = {
			name: endpoint.name,
			type: 'vless',
			server: endpoint.host,
			port: endpoint.port,
			uuid,
			network: params.network,
			tls: true,
			udp: true,
			flow: params.flow,
			servername: params.sni,
			'reality-opts': {
				'public-key': params.public_key,
			},
			'client-fingerprint': params.fingerprint,
		};
		if (params.short_id !== '') {
			(proxy['reality-opts'] as Record<string, unknown>)['short-id'] = params.short_id;
		}
		return proxy;
	},
	toUri(endpoint: ProxyEndpoint, uuid: string): string {
		const params = paramsOf(endpoint);
		const query: string[] = [
			'encryption=none',
			`flow=${encodeURIComponent(params.flow)}`,
			'security=reality',
			`sni=${encodeURIComponent(params.sni)}`,
			`fp=${encodeURIComponent(params.fingerprint)}`,
			`pbk=${encodeURIComponent(params.public_key)}`,
		];
		if (params.short_id !== '') query.push(`sid=${encodeURIComponent(params.short_id)}`);
		query.push(`type=${encodeURIComponent(params.network)}`);
		return `vless://${uuid}@${uriHost(endpoint.host)}:${endpoint.port}?${query.join('&')}#${encodeURIComponent(endpoint.name)}`;
	},
	toXrayInbound(endpoint: ProxyEndpoint): Record<string, unknown> {
		const params = paramsOf(endpoint);
		return {
			tag: `vless-reality-${endpoint.id}`,
			listen: '0.0.0.0',
			port: endpoint.port,
			protocol: 'vless',
			settings: {
				clients: [],
				decryption: 'none',
			},
			streamSettings: {
				network: params.network,
				security: 'reality',
				realitySettings: {
					show: false,
					dest: `${params.sni}:443`,
					xver: 0,
					serverNames: [params.sni],
					shortIds: [params.short_id],
					fingerprint: params.fingerprint,
				},
			},
			sniffing: {
				enabled: true,
				destOverride: ['http', 'tls', 'quic'],
			},
		};
	},
};
