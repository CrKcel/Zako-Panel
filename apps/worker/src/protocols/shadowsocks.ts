import { z } from 'zod';
import { base64UrlEncode } from '../lib/base64';
import { AppError } from '../lib/errors';
import { uriHost } from './transport';
import type { ProtocolAdapter, ProxyCredential, ProxyEndpoint } from './types';

/** ShadowSocks-2022 methods are excluded: their keys are fixed-length base64 values. */
export const shadowsocksMethodSchema = z.enum(['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305']);

export const shadowsocksParamsSchema = z.object({
	method: shadowsocksMethodSchema,
});

export type ShadowsocksParams = z.infer<typeof shadowsocksParamsSchema>;

function paramsOf(endpoint: ProxyEndpoint): ShadowsocksParams {
	const parsed = shadowsocksParamsSchema.safeParse(endpoint.params);
	if (!parsed.success) {
		throw new AppError('INTERNAL_ERROR', 'Stored endpoint parameters are invalid', 500);
	}
	return parsed.data;
}

export const SHADOWSOCKS_PROTOCOL = 'shadowsocks' as const;

export const shadowsocksAdapter: ProtocolAdapter = {
	protocol: SHADOWSOCKS_PROTOCOL,
	paramsSchema: shadowsocksParamsSchema,
	toClash(endpoint: ProxyEndpoint, credential: ProxyCredential): Record<string, unknown> {
		const params = paramsOf(endpoint);
		return {
			name: endpoint.name,
			type: 'ss',
			server: endpoint.host,
			port: endpoint.port,
			cipher: params.method,
			password: credential.secret,
			udp: true,
		};
	},
	toUri(endpoint: ProxyEndpoint, credential: ProxyCredential): string {
		const params = paramsOf(endpoint);
		const userInfo = base64UrlEncode(new TextEncoder().encode(`${params.method}:${credential.secret}`));
		return `ss://${userInfo}@${uriHost(endpoint.host)}:${endpoint.port}#${encodeURIComponent(endpoint.name)}`;
	},
};
