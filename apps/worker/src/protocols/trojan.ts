import { z } from 'zod';
import { AppError } from '../lib/errors';
import { clashTransportOptions, transportNetworkSchema, transportUriQuery, uriHost } from './transport';
import type { ProtocolAdapter, ProxyCredential, ProxyEndpoint } from './types';

export const trojanParamsSchema = z.object({
	sni: z.string().trim().min(1).max(255),
	network: transportNetworkSchema,
	path: z.string().trim().max(255),
	host: z.string().trim().max(255),
});

export type TrojanParams = z.infer<typeof trojanParamsSchema>;

function paramsOf(endpoint: ProxyEndpoint): TrojanParams {
	const parsed = trojanParamsSchema.safeParse(endpoint.params);
	if (!parsed.success) {
		throw new AppError('INTERNAL_ERROR', 'Stored endpoint parameters are invalid', 500);
	}
	return parsed.data;
}

export const TROJAN_PROTOCOL = 'trojan' as const;

export const trojanAdapter: ProtocolAdapter = {
	protocol: TROJAN_PROTOCOL,
	paramsSchema: trojanParamsSchema,
	toClash(endpoint: ProxyEndpoint, credential: ProxyCredential): Record<string, unknown> {
		const params = paramsOf(endpoint);
		return {
			name: endpoint.name,
			type: 'trojan',
			server: endpoint.host,
			port: endpoint.port,
			password: credential.secret,
			sni: params.sni,
			udp: true,
			network: params.network,
			...clashTransportOptions(params),
		};
	},
	toUri(endpoint: ProxyEndpoint, credential: ProxyCredential): string {
		const params = paramsOf(endpoint);
		const query = ['security=tls', `sni=${encodeURIComponent(params.sni)}`, ...transportUriQuery(params)];
		return `trojan://${encodeURIComponent(credential.secret)}@${uriHost(endpoint.host)}:${endpoint.port}?${query.join('&')}#${encodeURIComponent(endpoint.name)}`;
	},
};
