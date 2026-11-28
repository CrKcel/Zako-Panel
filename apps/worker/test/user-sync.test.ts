import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSubscriber, updateSubscriber } from '../src/services/subscriber-service';
import { getSubscriberCredential, seedMeta, seedNode, seedSubscriber } from './helpers';

const SECRET = 's'.repeat(43);

async function seedAgentNode(name = 'sync-node', secret = SECRET): Promise<{ nodeId: string; token: string }> {
	const nodeId = await seedNode({ name, secret });
	return { nodeId, token: `${nodeId}.${secret}` };
}

function fetchUsers(token: string, ifNoneMatch?: string): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
	return SELF.fetch('https://panel.test/api/v1/agent/users', { headers });
}

describe('node user set', () => {
	it('returns all active subscribers uniformly across all nodes and excludes inactive ones', async () => {
		const { token } = await seedAgentNode('node-a', 'a'.repeat(43));
		const { token: otherToken } = await seedAgentNode('node-b', 'b'.repeat(43));
		const active = await seedSubscriber({ name: 'Active' });
		const activeCred = await getSubscriberCredential(active);
		const suspended = await seedSubscriber({ name: 'Suspended', status: 'disabled' });
		const suspendedCred = await getSubscriberCredential(suspended);
		const expired = await seedSubscriber({ name: 'Expired', status: 'expired' });
		const expiredCred = await getSubscriberCredential(expired);
		const limited = await seedSubscriber({ name: 'Limited', status: 'limited' });
		const limitedCred = await getSubscriberCredential(limited);
		await seedMeta('users_ver', '7');

		for (const nodeToken of [token, otherToken]) {
			const response = await fetchUsers(nodeToken);
			expect(response.status).toBe(200);
			expect(response.headers.get('ETag')).toBe('"7"');
			const body = (await response.json()) as { data: { version: number; users: { xray_email: string; vless_uuid: string }[] } };
			expect(body.data.version).toBe(7);
			expect(body.data.users).toEqual([{ xray_email: activeCred.xrayEmail, vless_uuid: activeCred.uuid }]);

			expect(body.data.users.some((user) => user.xray_email === suspendedCred.xrayEmail)).toBe(false);
			expect(body.data.users.some((user) => user.xray_email === expiredCred.xrayEmail)).toBe(false);
			expect(body.data.users.some((user) => user.xray_email === limitedCred.xrayEmail)).toBe(false);
		}
	});

	it('answers 304 to matching and wildcard validators and 200 to a stale one', async () => {
		const { token } = await seedAgentNode();
		await seedSubscriber();
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
		const { token } = await seedAgentNode();
		await seedSubscriber();
		await seedMeta('users_ver', '1');

		const first = await fetchUsers(token);
		expect(first.headers.get('ETag')).toBe('"1"');
		await seedMeta('users_ver', '2');
		const second = await fetchUsers(token);
		expect(second.status).toBe(200);
		expect(second.headers.get('ETag')).toBe('"2"');
	});

	it('reflects subscriber creation and status changes on every node', async () => {
		const { token } = await seedAgentNode('node-1', '1'.repeat(43));
		const { token: token2 } = await seedAgentNode('node-2', '2'.repeat(43));
		await seedMeta('users_ver', '1');

		const before = (await (await fetchUsers(token)).json()) as { data: { version: number; users: unknown[] } };
		expect(before.data.users).toEqual([]);

		const created = await createSubscriber(env.DB, { name: 'Alice' });
		const credential = await getSubscriberCredential(created.id);
		for (const nodeToken of [token, token2]) {
			const granted = (await (await fetchUsers(nodeToken, '"1"')).json()) as {
				data: { version: number; users: { xray_email: string; vless_uuid: string }[] };
			};
			expect(granted.data.version).toBe(2);
			expect(granted.data.users).toEqual([{ xray_email: credential.xrayEmail, vless_uuid: credential.uuid }]);
		}

		await updateSubscriber(env.DB, created.id, { status: 'disabled' });
		for (const nodeToken of [token, token2]) {
			const suspended = (await (await fetchUsers(nodeToken, '"2"')).json()) as { data: { version: number; users: unknown[] } };
			expect(suspended.data.version).toBe(3);
			expect(suspended.data.users).toEqual([]);
		}
	});

	it('requires a valid agent token', async () => {
		await seedAgentNode();
		const response = await SELF.fetch('https://panel.test/api/v1/agent/users');
		expect(response.status).toBe(401);
	});
});
