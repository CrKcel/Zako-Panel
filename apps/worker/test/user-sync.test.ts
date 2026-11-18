import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { replaceSubscriberNodes, updateSubscriber } from '../src/services/subscriber-service';
import { seedMeta, seedNode, seedNodeClient, seedSubscriber } from './helpers';

const SECRET = 's'.repeat(43);

async function seedAgentNode(): Promise<{ nodeId: string; token: string }> {
	const nodeId = await seedNode({ name: 'sync-node', secret: SECRET });
	return { nodeId, token: `${nodeId}.${SECRET}` };
}

function fetchUsers(token: string, ifNoneMatch?: string): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
	return SELF.fetch('https://panel.test/api/v1/agent/users', { headers });
}

describe('node user set', () => {
	it('returns only enabled credentials of active subscribers on this node', async () => {
		const { nodeId, token } = await seedAgentNode();
		const otherNodeId = await seedNode({ name: 'other-node' });
		const active = await seedSubscriber({ name: 'Active' });
		const suspended = await seedSubscriber({ name: 'Suspended', status: 'disabled' });
		const kept = await seedNodeClient(nodeId, active);
		const suspendedClient = await seedNodeClient(nodeId, suspended);
		await seedNodeClient(otherNodeId, active);
		const revoked = await seedSubscriber({ name: 'Revoked' });
		const disabledClient = await seedNodeClient(nodeId, revoked, { enabled: false });
		await seedMeta('users_ver', '7');

		const response = await fetchUsers(token);
		expect(response.status).toBe(200);
		expect(response.headers.get('ETag')).toBe('"7"');
		const body = (await response.json()) as { data: { version: number; users: { xray_email: string; vless_uuid: string }[] } };
		expect(body.data.version).toBe(7);
		expect(body.data.users).toEqual([{ xray_email: kept.xrayEmail, vless_uuid: kept.uuid }]);

		// A credential that is disabled on the node or belongs to a suspended
		// subscriber must not reach the node runtime.
		expect(body.data.users.some((user) => user.xray_email === suspendedClient.xrayEmail)).toBe(false);
		expect(body.data.users.some((user) => user.xray_email === disabledClient.xrayEmail)).toBe(false);
	});

	it('answers 304 to matching and wildcard validators and 200 to a stale one', async () => {
		const { nodeId, token } = await seedAgentNode();
		const subscriberId = await seedSubscriber();
		await seedNodeClient(nodeId, subscriberId);
		await seedMeta('users_ver', '11');

		const fresh = await fetchUsers(token);
		expect(fresh.status).toBe(200);
		expect(fresh.headers.get('ETag')).toBe('"11"');

		const unchanged = await fetchUsers(token, '"11"');
		expect(unchanged.status).toBe(304);
		expect(await unchanged.text()).toBe('');

		const wildcard = await fetchUsers(token, '*');
		expect(wildcard.status).toBe(304);

		const stale = await fetchUsers(token, '"10"');
		expect(stale.status).toBe(200);
	});

	it('changes the entity tag when the users version advances', async () => {
		const { nodeId, token } = await seedAgentNode();
		const subscriberId = await seedSubscriber();
		await seedNodeClient(nodeId, subscriberId);
		await seedMeta('users_ver', '1');

		const first = await fetchUsers(token);
		expect(first.headers.get('ETag')).toBe('"1"');
		await seedMeta('users_ver', '2');
		const second = await fetchUsers(token);
		expect(second.status).toBe(200);
		expect(second.headers.get('ETag')).toBe('"2"');
	});

	it('reflects grant and status changes on the next fetch', async () => {
		const { nodeId, token } = await seedAgentNode();
		const subscriberId = await seedSubscriber();
		await seedMeta('users_ver', '1');

		const before = (await (await fetchUsers(token)).json()) as { data: { version: number; users: unknown[] } };
		expect(before.data.users).toEqual([]);

		await replaceSubscriberNodes(env.DB, subscriberId, [nodeId]);
		const credential = await env.DB.prepare('SELECT xray_email, vless_uuid FROM node_clients WHERE node_id = ? AND subscriber_id = ?')
			.bind(nodeId, subscriberId)
			.first<{ xray_email: string; vless_uuid: string }>();
		const granted = (await (await fetchUsers(token, '"1"')).json()) as {
			data: { version: number; users: { xray_email: string; vless_uuid: string }[] };
		};
		expect(granted.data.version).toBe(2);
		expect(granted.data.users).toEqual([{ xray_email: credential?.xray_email, vless_uuid: credential?.vless_uuid }]);

		await updateSubscriber(env.DB, subscriberId, { status: 'disabled' });
		const suspended = (await (await fetchUsers(token, '"2"')).json()) as { data: { version: number; users: unknown[] } };
		expect(suspended.data.version).toBe(3);
		expect(suspended.data.users).toEqual([]);
	});

	it('requires a valid agent token', async () => {
		await seedAgentNode();
		const response = await SELF.fetch('https://panel.test/api/v1/agent/users');
		expect(response.status).toBe(401);
	});
});
