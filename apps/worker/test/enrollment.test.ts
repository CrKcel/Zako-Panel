import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { VlessRealityParams } from '../src/protocols/vless-reality';
import { sha256Hex } from '../src/lib/hash';
import { parseAgentToken } from '../src/lib/token';
import { createEnrollmentToken, enrollNode, listEnrollmentTokens, revokeEnrollmentToken } from '../src/services/enrollment-service';
import { getNode, listNodeClients } from '../src/services/node-service';
import type { AgentEndpointProtocol } from '@zako/contracts';
import { DEFAULT_SHADOWSOCKS_PARAMS, DEFAULT_TROJAN_PARAMS, DEFAULT_VMESS_PARAMS, nowSeconds, seedMeta, seedSubscriber } from './helpers';

function enrollEndpoint(port = 443) {
	return {
		name: 'vless-reality',
		protocol: 'vless-reality' as const,
		port,
		params: {
			sni: 'www.microsoft.com',
			public_key: 'm1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE',
			short_id: 'deadbeef',
			fingerprint: 'chrome' as const,
			flow: 'xtls-rprx-vision' as const,
			network: 'tcp' as const,
		},
	};
}

describe('node enrollment tokens', () => {
	it('enrolls a node once, creates endpoint and default subscriber grant, and rejects reuse', async () => {
		const subscriberId = await seedSubscriber({ name: 'default' });
		await seedMeta('default_subscriber_id', subscriberId);

		const created = await createEnrollmentToken(
			env.DB,
			{
				name_prefix: 'edge',
				heartbeat_interval_seconds: 180,
			},
			'admin@example.com',
		);
		expect(created.enrollment_token.expires_at - created.enrollment_token.created_at).toBe(86_400);

		const parsed = parseAgentToken(created.token);
		expect(parsed?.nodeId).toBe(created.enrollment_token.id);
		const stored = await env.DB.prepare('SELECT token_hash FROM node_enrollment_tokens WHERE id = ?')
			.bind(created.enrollment_token.id)
			.first<{ token_hash: string }>();
		expect(stored?.token_hash).toBe(await sha256Hex(parsed!.secret));

		const enrolled = await enrollNode(env.DB, `Bearer ${created.token}`, {
			name: 'tokyo-01',
			host: '203.0.113.20',
			endpoints: [
				{
					name: 'vless-reality',
					protocol: 'vless-reality',
					port: 8443,
					params: {
						sni: 'www.apple.com',
						public_key: 'm1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE',
						short_id: 'a1b2c3d4',
						fingerprint: 'safari',
						flow: 'xtls-rprx-vision',
						network: 'tcp',
					},
				},
				{
					name: 'vless-reality',
					protocol: 'vless-reality',
					port: 2053,
					params: {
						sni: 'www.apple.com',
						public_key: 'm1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE',
						short_id: 'a1b2c3d4',
						fingerprint: 'chrome',
						flow: 'xtls-rprx-vision',
						network: 'tcp',
					},
				},
			],
		});

		expect(enrolled.heartbeat_interval_seconds).toBe(180);
		expect(enrolled.endpoints).toHaveLength(2);
		expect(enrolled.endpoints[0]?.port).toBe(8443);
		expect(parseAgentToken(enrolled.agent_token)?.nodeId).toBe(enrolled.node_id);

		const detail = await getNode(env.DB, enrolled.node_id);
		expect(detail.node.name).toBe('edge-tokyo-01');
		expect(detail.endpoints).toHaveLength(2);
		// Duplicate inbound tags are disambiguated so the unique (node, name) index holds.
		expect(detail.endpoints.map((endpoint) => endpoint.name).sort()).toEqual(['vless-reality', 'vless-reality-2']);
		expect(detail.endpoints[0]?.host).toBe('203.0.113.20');
		expect(detail.endpoints[0]?.protocol).toBe('vless-reality');
		const params = detail.endpoints[0]?.params as VlessRealityParams;
		expect(params.public_key).toBe('m1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE');

		const clients = await listNodeClients(env.DB, enrolled.node_id);
		expect(clients).toHaveLength(1);
		expect(clients[0]?.subscriber_id).toBe(subscriberId);

		// Token is marked used and cannot be reused.
		const list = await listEnrollmentTokens(env.DB, { limit: 10 });
		const row = list.items.find((item) => item.id === created.enrollment_token.id);
		expect(row?.status).toBe('used');
		expect(row?.used_node_id).toBe(enrolled.node_id);

		await expect(
			enrollNode(env.DB, `Bearer ${created.token}`, {
				name: 'tokyo-02',
				host: '203.0.113.21',
				endpoints: [enrollEndpoint()],
			}),
		).rejects.toMatchObject({ status: 401 });

		// The returned permanent agent_token can authenticate to /api/v1/agent/users.
		const usersRes = await SELF.fetch('https://panel.example.com/api/v1/agent/users', {
			headers: { Authorization: `Bearer ${enrolled.agent_token}` },
		});
		expect(usersRes.status).toBe(200);
	});

	it('rejects expired, revoked, and invalid tokens, and preserves token on node name conflict', async () => {
		const expired = await createEnrollmentToken(env.DB, { ttl_seconds: 300 }, 'admin@example.com');
		await env.DB.prepare('UPDATE node_enrollment_tokens SET expires_at = ? WHERE id = ?')
			.bind(nowSeconds() - 10, expired.enrollment_token.id)
			.run();
		await expect(
			enrollNode(env.DB, `Bearer ${expired.token}`, {
				name: 'expired-node',
				host: '203.0.113.30',
				endpoints: [enrollEndpoint()],
			}),
		).rejects.toMatchObject({ status: 401 });

		const revoked = await createEnrollmentToken(env.DB, {}, 'admin@example.com');
		await revokeEnrollmentToken(env.DB, revoked.enrollment_token.id);
		await expect(
			enrollNode(env.DB, `Bearer ${revoked.token}`, {
				name: 'revoked-node',
				host: '203.0.113.31',
				endpoints: [enrollEndpoint()],
			}),
		).rejects.toMatchObject({ status: 401 });

		// HTTP route test: agent enrolls via POST /api/v1/agent/enroll.
		const httpToken = await createEnrollmentToken(env.DB, {}, 'owner@example.com');

		const enrollRes = await SELF.fetch('https://panel.example.com/api/v1/agent/enroll', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${httpToken.token}`,
			},
			body: JSON.stringify({
				name: 'http-node-01',
				host: '203.0.113.40',
				endpoints: [enrollEndpoint()],
			}),
		});
		expect(enrollRes.status).toBe(201);

		// Name conflict with an active token should return 409 and NOT consume the token.
		const secondToken = await createEnrollmentToken(env.DB, {}, 'owner@example.com');
		const conflictRes = await SELF.fetch('https://panel.example.com/api/v1/agent/enroll', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${secondToken.token}`,
			},
			body: JSON.stringify({
				name: 'http-node-01',
				host: '203.0.113.41',
				endpoints: [enrollEndpoint()],
			}),
		});
		expect(conflictRes.status).toBe(409);

		const retryRes = await SELF.fetch('https://panel.example.com/api/v1/agent/enroll', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${secondToken.token}`,
			},
			body: JSON.stringify({
				name: 'http-node-02',
				host: '203.0.113.41',
				endpoints: [enrollEndpoint()],
			}),
		});
		expect(retryRes.status).toBe(201);
	});
});

describe('multi-protocol enrollment', () => {
	it('stores every reported protocol with its own params', async () => {
		const created = await createEnrollmentToken(env.DB, {}, 'admin@example.com');
		const enrolled = await enrollNode(env.DB, `Bearer ${created.token}`, {
			name: 'mixed',
			host: '203.0.113.30',
			endpoints: [
				enrollEndpoint(443),
				{ name: 'vmess', protocol: 'vmess', port: 8443, params: DEFAULT_VMESS_PARAMS },
				{ name: 'trojan', protocol: 'trojan', port: 9000, params: DEFAULT_TROJAN_PARAMS },
				{ name: 'ss', protocol: 'shadowsocks', port: 9001, params: DEFAULT_SHADOWSOCKS_PARAMS },
			],
		});

		expect(enrolled.endpoints.map((endpoint) => endpoint.protocol).sort()).toEqual(['shadowsocks', 'trojan', 'vless-reality', 'vmess']);

		const detail = await getNode(env.DB, enrolled.node_id);
		const byProtocol = new Map(detail.endpoints.map((endpoint) => [endpoint.protocol, endpoint]));
		expect(byProtocol.get('vmess')?.port).toBe(8443);
		expect(byProtocol.get('vmess')?.params).toEqual(DEFAULT_VMESS_PARAMS);
		expect(byProtocol.get('trojan')?.params).toEqual(DEFAULT_TROJAN_PARAMS);
		expect(byProtocol.get('shadowsocks')?.params).toEqual(DEFAULT_SHADOWSOCKS_PARAMS);
	});

	it('rejects params that do not match the reported protocol', async () => {
		const created = await createEnrollmentToken(env.DB, {}, 'admin@example.com');
		await expect(
			enrollNode(env.DB, `Bearer ${created.token}`, {
				name: 'bad-params',
				host: '203.0.113.31',
				endpoints: [{ name: 'vmess', protocol: 'vmess', port: 443, params: DEFAULT_TROJAN_PARAMS }],
			}),
		).rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });

		// The token survives a rejected payload so the operator can retry the install.
		const tokens = await listEnrollmentTokens(env.DB, { limit: 10 });
		expect(tokens.items.find((item) => item.id === created.enrollment_token.id)?.status).toBe('active');
	});

	it('refuses a protocol the agent cannot manage', async () => {
		const created = await createEnrollmentToken(env.DB, {}, 'admin@example.com');
		await expect(
			enrollNode(env.DB, `Bearer ${created.token}`, {
				name: 'hysteria',
				host: '203.0.113.32',
				endpoints: [
					{
						// Hysteria2 endpoints are operator-declared; the agent schema already
						// rejects the value, and the service repeats the check.
						name: 'hy2',
						protocol: 'hysteria2' as AgentEndpointProtocol,
						port: 443,
						params: { sni: 'www.example.com', obfs: 'none', obfs_password: '' },
					},
				],
			}),
		).rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
	});
});
