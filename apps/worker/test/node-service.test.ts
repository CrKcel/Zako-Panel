import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { sha256Hex } from '../src/lib/hash';
import { parseAgentToken } from '../src/lib/token';
import {
	createNode,
	disableEndpoint,
	getNodeStatus,
	listEndpoints,
	listNodeClients,
	listNodes,
	rotateAgentToken,
} from '../src/services/node-service';
import { getClashSubscription } from '../src/services/subscription-service';
import {
	DEFAULT_PARAMS,
	nowSeconds,
	readMeta,
	seedEndpoint,
	seedMeta,
	seedNode,
	seedProfile,
	seedSubscriber,
	seedSubscription,
	testToken,
} from './helpers';

const createInput = {
	name: 'Tokyo-01',
	endpoint: { name: 'primary', host: '203.0.113.10', port: 443, params: DEFAULT_PARAMS },
};

describe('node creation', () => {
	it('creates the node, first endpoint and default subscriber client in one batch', async () => {
		const subscriberId = await seedSubscriber({ name: 'default' });
		await seedMeta('default_subscriber_id', subscriberId);

		const result = await createNode(env.DB, createInput);

		expect(result.node.name).toBe('Tokyo-01');
		expect(result.node.status).toBe('offline');
		expect(result.endpoint.node_id).toBe(result.node.id);
		expect(result.endpoint.params).toEqual(DEFAULT_PARAMS);

		const parsed = parseAgentToken(result.agent_token);
		expect(parsed?.nodeId).toBe(result.node.id);
		const stored = await env.DB.prepare('SELECT agent_token_hash FROM nodes WHERE id = ?')
			.bind(result.node.id)
			.first<{ agent_token_hash: string }>();
		expect(stored?.agent_token_hash).toBe(await sha256Hex(parsed?.secret ?? ''));
		expect(stored?.agent_token_hash).not.toContain(parsed?.secret ?? 'x');

		const client = await env.DB.prepare('SELECT subscriber_id, enabled, vless_uuid FROM node_clients WHERE node_id = ?')
			.bind(result.node.id)
			.first<{ subscriber_id: string; enabled: number; vless_uuid: string }>();
		expect(client?.subscriber_id).toBe(subscriberId);
		expect(client?.enabled).toBe(1);
		expect(client?.vless_uuid).toMatch(/^[0-9a-f-]{36}$/);

		expect(await readMeta('users_ver')).toBe('1');
	});

	it('distributes a new node to the default subscription after its first heartbeat', async () => {
		const subscriberId = await seedSubscriber({ name: 'default' });
		await seedMeta('default_subscriber_id', subscriberId);
		const profileId = await seedProfile();
		const token = testToken('bootstrap');
		await seedSubscription({ token, subscriberId, profileId });

		const created = await createNode(env.DB, createInput);
		// A node with no heartbeat yet is offline and not distributable.
		await expect(getClashSubscription(env.DB, token)).rejects.toMatchObject({ status: 503 });

		const now = nowSeconds();
		const response = await SELF.fetch('https://panel.test/api/v1/agent/report', {
			method: 'POST',
			headers: { Authorization: `Bearer ${created.agent_token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				sent_at: now,
				agent_version: '0.1.0',
				xray_version: '25.10.1',
				xray_healthy: true,
				stats_healthy: true,
				applied_config_version: 0,
				users_ver: 0,
			}),
		});
		expect(response.status).toBe(200);

		const rendered = await getClashSubscription(env.DB, token);
		expect(rendered.body).toContain('name: Tokyo-01');
		expect(rendered.body).toContain('type: vless');

		const client = await env.DB.prepare('SELECT vless_uuid FROM node_clients WHERE node_id = ?')
			.bind(created.node.id)
			.first<{ vless_uuid: string }>();
		expect(rendered.body).toContain(`uuid: ${client?.vless_uuid}`);
	});

	it('exposes the credentials a node-local inbound must contain', async () => {
		const subscriberId = await seedSubscriber({ name: 'default' });
		await seedMeta('default_subscriber_id', subscriberId);
		const created = await createNode(env.DB, createInput);

		const clients = await listNodeClients(env.DB, created.node.id);
		expect(clients).toHaveLength(1);
		expect(clients[0]).toMatchObject({
			node_id: created.node.id,
			subscriber_id: subscriberId,
			subscriber_name: 'default',
			enabled: true,
		});
		expect(clients[0]?.xray_email).toMatch(/^u_[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(clients[0]?.vless_uuid).toMatch(/^[0-9a-f-]{36}$/);

		await expect(listNodeClients(env.DB, '01J2Z6Q8Y3V9M4K7T1B5C0D2E9')).rejects.toMatchObject({ status: 404 });
	});

	it('skips the default client when no default subscriber exists', async () => {
		const result = await createNode(env.DB, { ...createInput, name: 'Osaka-01' });
		const clients = await env.DB.prepare('SELECT id FROM node_clients WHERE node_id = ?').bind(result.node.id).all();
		expect(clients.results).toHaveLength(0);
	});

	it('rejects a duplicate node name with 409', async () => {
		await createNode(env.DB, createInput);
		await expect(createNode(env.DB, createInput)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
	});

	it('ignores a default subscriber id that no longer exists', async () => {
		await seedMeta('default_subscriber_id', '01J2Z6Q8Y3V9M4K7T1B5C0D2E6');
		const result = await createNode(env.DB, { ...createInput, name: 'Nagoya-01' });
		const clients = await env.DB.prepare('SELECT id FROM node_clients WHERE node_id = ?').bind(result.node.id).all();
		expect(clients.results).toHaveLength(0);
	});
});

describe('node listing and status', () => {
	it('pages by ascending id with a cursor', async () => {
		const first = await seedNode({ id: '01J2Z6Q8Y3V9M4K7T1B5C0D2E1', name: 'a' });
		const second = await seedNode({ id: '01J2Z6Q8Y3V9M4K7T1B5C0D2E2', name: 'b' });
		const third = await seedNode({ id: '01J2Z6Q8Y3V9M4K7T1B5C0D2E3', name: 'c' });

		const page = await listNodes(env.DB, { limit: 2 });
		expect(page.items.map((node) => node.id)).toEqual([first, second]);
		expect(page.next_cursor).toBe(second);

		const rest = await listNodes(env.DB, { limit: 2, cursor: page.next_cursor ?? undefined });
		expect(rest.items.map((node) => node.id)).toEqual([third]);
		expect(rest.next_cursor).toBeNull();
	});

	it('derives offline, degraded and disabled statuses from stored heartbeats', async () => {
		const stale = await seedNode({ name: 'stale', lastSeenAt: nowSeconds() - 4_000 });
		const degraded = await seedNode({ name: 'degraded', statsHealthy: false });
		const disabled = await seedNode({ name: 'disabled', enabled: false });

		expect((await getNodeStatus(env.DB, stale)).status).toBe('offline');
		expect((await getNodeStatus(env.DB, degraded)).status).toBe('degraded');
		expect((await getNodeStatus(env.DB, disabled)).status).toBe('disabled');
		await expect(getNodeStatus(env.DB, '01J2Z6Q8Y3V9M4K7T1B5C0D2E6')).rejects.toBeInstanceOf(AppError);
	});

	it('rotates the agent token so the previous secret no longer matches', async () => {
		const nodeId = await seedNode({ name: 'rotate', secret: 'old-secret' });
		const rotated = await rotateAgentToken(env.DB, nodeId);
		const parsed = parseAgentToken(rotated.agent_token);
		expect(parsed?.nodeId).toBe(nodeId);
		const stored = await env.DB.prepare('SELECT agent_token_hash FROM nodes WHERE id = ?')
			.bind(nodeId)
			.first<{ agent_token_hash: string }>();
		expect(stored?.agent_token_hash).toBe(await sha256Hex(parsed?.secret ?? ''));
		expect(stored?.agent_token_hash).not.toBe(await sha256Hex('old-secret'));
	});
});

describe('endpoints', () => {
	it('disables an endpoint without deleting the row', async () => {
		const nodeId = await seedNode({ name: 'endpoint-owner' });
		const endpointId = await seedEndpoint(nodeId, { name: 'primary' });
		await disableEndpoint(env.DB, nodeId, endpointId);

		const endpoints = await listEndpoints(env.DB, nodeId);
		expect(endpoints).toHaveLength(1);
		expect(endpoints[0]?.enabled).toBe(false);
	});

	it('returns 404 for an endpoint that does not belong to the node', async () => {
		const nodeId = await seedNode({ name: 'endpoint-owner-2' });
		await expect(disableEndpoint(env.DB, nodeId, '01J2Z6Q8Y3V9M4K7T1B5C0D2E6')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
	});
});
