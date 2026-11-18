import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/hash';
import { parseAgentToken } from '../src/lib/token';
import { createEnrollmentToken, enrollNode, listEnrollmentTokens, revokeEnrollmentToken } from '../src/services/enrollment-service';
import { getNode, listNodeClients } from '../src/services/node-service';
import { nowSeconds, seedMeta, seedSubscriber } from './helpers';

describe('node enrollment tokens', () => {
	it('enrolls a node once, creates endpoint and default subscriber grant, and rejects reuse', async () => {
		const subscriberId = await seedSubscriber({ name: 'default' });
		await seedMeta('default_subscriber_id', subscriberId);

		const created = await createEnrollmentToken(
			env.DB,
			{
				name_prefix: 'edge',
				default_sni: 'www.apple.com',
				default_port: 8443,
				default_fingerprint: 'safari',
				heartbeat_interval_seconds: 180,
			},
			'admin@example.com',
		);

		expect(created.enrollment_token.status).toBe('active');
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
			reality_public_key: 'm1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE',
			reality_short_id: 'a1b2c3d4',
		});

		expect(enrolled.heartbeat_interval_seconds).toBe(180);
		expect(enrolled.endpoint.host).toBe('203.0.113.20');
		expect(enrolled.endpoint.port).toBe(8443);
		expect(enrolled.endpoint.sni).toBe('www.apple.com');
		expect(enrolled.endpoint.fingerprint).toBe('safari');
		expect(parseAgentToken(enrolled.agent_token)?.nodeId).toBe(enrolled.node_id);

		const detail = await getNode(env.DB, enrolled.node_id);
		expect(detail.node.name).toBe('edge-tokyo-01');
		expect(detail.endpoints).toHaveLength(1);
		expect(detail.endpoints[0]?.params.public_key).toBe('m1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE');

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
				reality_public_key: 'm1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE',
				reality_short_id: 'a1b2c3d4',
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
				reality_public_key: 'pk',
				reality_short_id: '01',
			}),
		).rejects.toMatchObject({ status: 401 });

		const revoked = await createEnrollmentToken(env.DB, {}, 'admin@example.com');
		await revokeEnrollmentToken(env.DB, revoked.enrollment_token.id);
		await expect(
			enrollNode(env.DB, `Bearer ${revoked.token}`, {
				name: 'revoked-node',
				host: '203.0.113.31',
				reality_public_key: 'pk',
				reality_short_id: '01',
			}),
		).rejects.toMatchObject({ status: 401 });

		// HTTP route test: agent enrolls via POST /api/v1/agent/enroll.
		const httpToken = await createEnrollmentToken(env.DB, { default_sni: 'www.cloudflare.com' }, 'owner@example.com');

		const enrollRes = await SELF.fetch('https://panel.example.com/api/v1/agent/enroll', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${httpToken.token}`,
			},
			body: JSON.stringify({
				name: 'http-node-01',
				host: '203.0.113.40',
				reality_public_key: 'm1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE',
				reality_short_id: 'deadbeef',
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
				reality_public_key: 'm1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE',
				reality_short_id: 'deadbeef',
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
				reality_public_key: 'm1uM4zY2e6b0B9cF1x7vQ5kR3wP8nL2jH4dG6sA0iE',
				reality_short_id: 'deadbeef',
			}),
		});
		expect(retryRes.status).toBe(201);
	});
});
