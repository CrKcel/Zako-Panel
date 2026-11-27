import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AgentEndpointProtocol } from '@zako/contracts';
import worker from '../src/index';
import { sha256Hex } from '../src/lib/hash';
import { isTokenShaped, parseAgentToken } from '../src/lib/token';
import type { VlessRealityParams } from '../src/protocols/vless-reality';
import { META_KEYS } from '../src/repositories/meta';
import { enrollNode, getEnrollmentTokenStatus, rotateEnrollmentToken } from '../src/services/enrollment-service';
import { getNode, listNodeClients } from '../src/services/node-service';
import { DEFAULT_SHADOWSOCKS_PARAMS, DEFAULT_TROJAN_PARAMS, DEFAULT_VMESS_PARAMS, readMeta, seedMeta, seedSubscriber } from './helpers';

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

describe('reusable enrollment token', () => {
	it('starts unconfigured, generates and stores only a SHA-256 hash, and supports multi-node reuse', async () => {
		const initial = await getEnrollmentTokenStatus(env.DB);
		expect(initial).toEqual({ configured: false, rotated_at: null });

		// Unconfigured panel rejects enrollment attempts.
		await expect(
			enrollNode(env.DB, `Bearer ${'a'.repeat(43)}`, {
				name: 'unconfigured-node',
				host: '203.0.113.10',
				endpoints: [enrollEndpoint()],
			}),
		).rejects.toMatchObject({ status: 401 });

		const subscriberId = await seedSubscriber({ name: 'default' });
		await seedMeta('default_subscriber_id', subscriberId);

		const rotated = await rotateEnrollmentToken(env.DB, 'admin@example.com');
		expect(isTokenShaped(rotated.token)).toBe(true);
		expect(rotated.rotated_at).toBeGreaterThan(0);

		const status = await getEnrollmentTokenStatus(env.DB);
		expect(status).toEqual({ configured: true, rotated_at: rotated.rotated_at });

		expect(await readMeta(META_KEYS.enrollmentTokenHash)).toBe(await sha256Hex(rotated.token));
		expect(await readMeta(META_KEYS.enrollmentTokenRotatedAt)).toBe(String(rotated.rotated_at));

		// First node enrolls with the reusable token.
		const first = await enrollNode(env.DB, `Bearer ${rotated.token}`, {
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

		expect(first.heartbeat_interval_seconds).toBe(300);
		expect(first.endpoints).toHaveLength(2);
		expect(first.endpoints[0]?.port).toBe(8443);
		expect(parseAgentToken(first.agent_token)?.nodeId).toBe(first.node_id);

		const detail = await getNode(env.DB, first.node_id);
		expect(detail.node.name).toBe('tokyo-01');
		expect(detail.endpoints).toHaveLength(2);
		// Duplicate inbound tags are disambiguated so the unique (node, name) index holds.
		expect(detail.endpoints.map((endpoint) => endpoint.name).sort()).toEqual(['vless-reality', 'vless-reality-2']);
		expect(detail.endpoints[0]?.host).toBe('203.0.113.20');
		expect(detail.endpoints[0]?.protocol).toBe('vless-reality');
		const params = detail.endpoints[0]?.params as VlessRealityParams;
		expect(params.public_key).toBe('m1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE');

		const clients = await listNodeClients(env.DB, first.node_id);
		expect(clients).toHaveLength(1);
		expect(clients[0]?.subscriber_id).toBe(subscriberId);

		// Second distinct node reuses the exact same enrollment token.
		const second = await enrollNode(env.DB, `Bearer ${rotated.token}`, {
			name: 'tokyo-02',
			host: '203.0.113.21',
			endpoints: [enrollEndpoint()],
		});
		expect(second.node_id).not.toBe(first.node_id);
		expect(second.agent_token).not.toBe(first.agent_token);

		// Both permanent agent tokens can authenticate to /api/v1/agent/users.
		for (const agentToken of [first.agent_token, second.agent_token]) {
			const usersRes = await SELF.fetch('https://panel.example.com/api/v1/agent/users', {
				headers: { Authorization: `Bearer ${agentToken}` },
			});
			expect(usersRes.status).toBe(200);
		}
	});

	it('invalidates the previous enrollment token upon rotation while keeping enrolled nodes functional', async () => {
		const initial = await rotateEnrollmentToken(env.DB, 'admin@example.com');
		const enrolled = await enrollNode(env.DB, `Bearer ${initial.token}`, {
			name: 'osaka-01',
			host: '203.0.113.30',
			endpoints: [enrollEndpoint()],
		});

		const next = await rotateEnrollmentToken(env.DB, 'admin@example.com');
		expect(next.token).not.toBe(initial.token);

		// Old enrollment token is rejected immediately.
		await expect(
			enrollNode(env.DB, `Bearer ${initial.token}`, {
				name: 'osaka-02',
				host: '203.0.113.31',
				endpoints: [enrollEndpoint()],
			}),
		).rejects.toMatchObject({ status: 401 });

		// New enrollment token works.
		const osaka2 = await enrollNode(env.DB, `Bearer ${next.token}`, {
			name: 'osaka-02',
			host: '203.0.113.31',
			endpoints: [enrollEndpoint()],
		});
		expect(osaka2.node_id).not.toBe(enrolled.node_id);

		// Existing node continues authenticating with its own permanent agent_token.
		const usersRes = await SELF.fetch('https://panel.example.com/api/v1/agent/users', {
			headers: { Authorization: `Bearer ${enrolled.agent_token}` },
		});
		expect(usersRes.status).toBe(200);
	});

	it('rejects malformed or wrong tokens, handles name conflicts, and exposes admin HTTP endpoints', async () => {
		const devEnv = { ...env, ENVIRONMENT: 'development', DEV_ADMIN_EMAIL: 'admin@example.com' };
		const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

		const statusRes1 = await worker.fetch(new Request('https://panel.example.com/api/v1/admin/node-enrollment-token'), devEnv, ctx);
		expect(statusRes1.status).toBe(200);
		const statusJson1 = (await statusRes1.json()) as { data: { configured: boolean; rotated_at: number | null } };
		expect(statusJson1.data).toEqual({ configured: false, rotated_at: null });

		const rotateRes = await worker.fetch(
			new Request('https://panel.example.com/api/v1/admin/node-enrollment-token/rotate', { method: 'POST' }),
			devEnv,
			ctx,
		);
		expect(rotateRes.status).toBe(200);
		const rotateJson = (await rotateRes.json()) as { data: { token: string; rotated_at: number } };
		expect(isTokenShaped(rotateJson.data.token)).toBe(true);

		const statusRes2 = await worker.fetch(new Request('https://panel.example.com/api/v1/admin/node-enrollment-token'), devEnv, ctx);
		expect(statusRes2.status).toBe(200);
		const statusJson2 = (await statusRes2.json()) as { data: { configured: boolean; rotated_at: number | null } };
		expect(statusJson2.data).toEqual({ configured: true, rotated_at: rotateJson.data.rotated_at });

		// Audit event recorded for rotation.
		const audit = await env.DB.prepare(
			"SELECT actor_email, action FROM audit_events WHERE action = 'enrollment_token.rotate' LIMIT 1",
		).first<{
			actor_email: string;
			action: string;
		}>();
		expect(audit).toEqual({ actor_email: 'admin@example.com', action: 'enrollment_token.rotate' });

		// Malformed and wrong tokens fail with 401.
		for (const header of [undefined, 'Basic abc', 'Bearer short', `Bearer ${'z'.repeat(43)}`]) {
			const res = await SELF.fetch('https://panel.example.com/api/v1/agent/enroll', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(header ? { Authorization: header } : {}),
				},
				body: JSON.stringify({
					name: 'bad-auth-node',
					host: '203.0.113.39',
					endpoints: [enrollEndpoint()],
				}),
			});
			expect(res.status).toBe(401);
		}

		// Valid enrollment via HTTP route.
		const enrollRes = await SELF.fetch('https://panel.example.com/api/v1/agent/enroll', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${rotateJson.data.token}`,
			},
			body: JSON.stringify({
				name: 'http-node-01',
				host: '203.0.113.40',
				endpoints: [enrollEndpoint()],
			}),
		});
		expect(enrollRes.status).toBe(201);

		// Name conflict returns 409 and does not affect future enrollments with the same token.
		const conflictRes = await SELF.fetch('https://panel.example.com/api/v1/agent/enroll', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${rotateJson.data.token}`,
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
				Authorization: `Bearer ${rotateJson.data.token}`,
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
		const rotated = await rotateEnrollmentToken(env.DB, 'admin@example.com');
		const enrolled = await enrollNode(env.DB, `Bearer ${rotated.token}`, {
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
		const rotated = await rotateEnrollmentToken(env.DB, 'admin@example.com');
		await expect(
			enrollNode(env.DB, `Bearer ${rotated.token}`, {
				name: 'bad-params',
				host: '203.0.113.31',
				endpoints: [{ name: 'vmess', protocol: 'vmess', port: 443, params: DEFAULT_TROJAN_PARAMS }],
			}),
		).rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
	});

	it('refuses a protocol the agent cannot manage', async () => {
		const rotated = await rotateEnrollmentToken(env.DB, 'admin@example.com');
		await expect(
			enrollNode(env.DB, `Bearer ${rotated.token}`, {
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
