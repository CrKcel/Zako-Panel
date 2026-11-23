import { z } from 'zod';
import { AppError } from '../lib/errors';
import { uriHost } from './transport';
import type { ProtocolAdapter, ProxyCredential, ProxyEndpoint } from './types';

export const hysteria2ParamsSchema = z
	.object({
		sni: z.string().trim().min(1).max(255),
		obfs: z.enum(['none', 'salamander']),
		obfs_password: z.string().trim().max(255),
	})
	.superRefine((value, ctx) => {
		if (value.obfs === 'salamander' && value.obfs_password === '') {
			ctx.addIssue({ code: 'custom', path: ['obfs_password'], message: 'Salamander obfuscation requires a password' });
		}
	});

export type Hysteria2Params = z.infer<typeof hysteria2ParamsSchema>;

function paramsOf(endpoint: ProxyEndpoint): Hysteria2Params {
	const parsed = hysteria2ParamsSchema.safeParse(endpoint.params);
	if (!parsed.success) {
		throw new AppError('INTERNAL_ERROR', 'Stored endpoint parameters are invalid', 500);
	}
	return parsed.data;
}

export const HYSTERIA2_PROTOCOL = 'hysteria2' as const;

export const hysteria2Adapter: ProtocolAdapter = {
	protocol: HYSTERIA2_PROTOCOL,
	paramsSchema: hysteria2ParamsSchema,
	toClash(endpoint: ProxyEndpoint, credential: ProxyCredential): Record<string, unknown> {
		const params = paramsOf(endpoint);
		const proxy: Record<string, unknown> = {
			name: endpoint.name,
			type: 'hysteria2',
			server: endpoint.host,
			port: endpoint.port,
			password: credential.secret,
			sni: params.sni,
			'skip-cert-verify': false,
		};
		if (params.obfs === 'salamander') {
			proxy.obfs = 'salamander';
			proxy['obfs-password'] = params.obfs_password;
		}
		return proxy;
	},
	toUri(endpoint: ProxyEndpoint, credential: ProxyCredential): string {
		const params = paramsOf(endpoint);
		const query = [`sni=${encodeURIComponent(params.sni)}`];
		if (params.obfs === 'salamander') {
			query.push(`obfs=${params.obfs}`, `obfs-password=${encodeURIComponent(params.obfs_password)}`);
		}
		// The trailing slash is part of the scheme's authority form.
		return `hysteria2://${encodeURIComponent(credential.secret)}@${uriHost(endpoint.host)}:${endpoint.port}/?${query.join('&')}#${encodeURIComponent(endpoint.name)}`;
	},
};
