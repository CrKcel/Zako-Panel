import { z } from 'zod';
import { base64Encode } from '../lib/base64';
import { AppError } from '../lib/errors';
import { clashTransportOptions, transportNetworkSchema } from './transport';
import type { ProtocolAdapter, ProxyCredential, ProxyEndpoint } from './types';

export const vmessParamsSchema = z
	.object({
		security: z.enum(['tls', 'none']),
		sni: z.string().trim().max(255),
		network: transportNetworkSchema,
		path: z.string().trim().max(255),
		host: z.string().trim().max(255),
	})
	.superRefine((value, ctx) => {
		if (value.security === 'tls' && value.sni === '') {
			ctx.addIssue({ code: 'custom', path: ['sni'], message: 'TLS requires a SNI' });
		}
	});

export type VmessParams = z.infer<typeof vmessParamsSchema>;

function paramsOf(endpoint: ProxyEndpoint): VmessParams {
	const parsed = vmessParamsSchema.safeParse(endpoint.params);
	if (!parsed.success) {
		throw new AppError('INTERNAL_ERROR', 'Stored endpoint parameters are invalid', 500);
	}
	return parsed.data;
}

export const VMESS_PROTOCOL = 'vmess' as const;

export const vmessAdapter: ProtocolAdapter = {
	protocol: VMESS_PROTOCOL,
	paramsSchema: vmessParamsSchema,
	toClash(endpoint: ProxyEndpoint, credential: ProxyCredential): Record<string, unknown> {
		const params = paramsOf(endpoint);
		const proxy: Record<string, unknown> = {
			name: endpoint.name,
			type: 'vmess',
			server: endpoint.host,
			port: endpoint.port,
			uuid: credential.secret,
			alterId: 0,
			cipher: 'auto',
			tls: params.security === 'tls',
			udp: true,
			network: params.network,
			...clashTransportOptions(params),
		};
		if (params.security === 'tls') proxy.servername = params.sni;
		return proxy;
	},
	toUri(endpoint: ProxyEndpoint, credential: ProxyCredential): string {
		const params = paramsOf(endpoint);
		const tls = params.security === 'tls';
		// v2rayN and Clash both import this base64 JSON form; the node name travels
		// inside the payload instead of a URI fragment.
		const payload = {
			v: '2',
			ps: endpoint.name,
			add: endpoint.host,
			port: String(endpoint.port),
			id: credential.secret,
			aid: '0',
			scy: 'auto',
			net: params.network,
			type: 'none',
			host: params.host,
			path: params.path,
			tls: tls ? 'tls' : '',
			sni: tls ? params.sni : '',
			alpn: '',
		};
		return `vmess://${base64Encode(JSON.stringify(payload))}`;
	},
};
