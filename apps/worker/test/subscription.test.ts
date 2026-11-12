import { env, SELF } from 'cloudflare:test';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createSubscription, getClashSubscription, revokeSubscription, rotateSubscription } from '../src/services/subscription-service';
import {
	DEFAULT_PARAMS,
	hourStart,
	nowSeconds,
	seedDistribution,
	seedEndpoint,
	seedNode,
	seedNodeClient,
	seedProfile,
	seedSubscriber,
	seedSubscriberUsage,
	seedSubscription,
	testToken,
} from './helpers';

interface ClashDocument {
	proxies: Record<string, unknown>[];
	'proxy-groups': { name: string; type: string; proxies: string[]; url?: string; interval?: number }[];
	rules: string[];
	[key: string]: unknown;
}

async function fetchClash(token: string): Promise<Response> {
	return SELF.fetch(`https://panel.test/sub/${token}/clash.yaml`);
}

async function nodeName(nodeId: string): Promise<string> {
	const row = await env.DB.prepare('SELECT name FROM nodes WHERE id = ?').bind(nodeId).first<{ name: string }>();
	return row?.name ?? '';
}

describe('Clash subscription rendering', () => {
	it('renders a parseable document with a node, default groups and a default rule', async () => {
		const dist = await seedDistribution({ scope: 'clash' });
		const name = await nodeName(dist.nodeId);
		const response = await fetchClash(dist.token);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/yaml');
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(response.headers.get('profile-update-interval')).toBe('6');
		expect(response.headers.get('subscription-userinfo')).toBe('upload=0; download=0; total=0; expire=0');
		expect(response.headers.get('Content-Disposition')).toContain('zako-clash.yaml');

		const document = parse(await response.text()) as ClashDocument;
		expect(document.proxies).toHaveLength(1);
		expect(document.proxies[0]).toMatchObject({
			name,
			type: 'vless',
			server: '203.0.113.10',
			port: 443,
			uuid: dist.nodeClient.uuid,
			network: 'tcp',
			tls: true,
			udp: true,
			flow: 'xtls-rprx-vision',
			servername: 'www.example.com',
			'client-fingerprint': 'chrome',
			'reality-opts': {
				'public-key': DEFAULT_PARAMS.public_key,
				'short-id': DEFAULT_PARAMS.short_id,
			},
		});
		expect(document['proxy-groups']).toEqual([
			{ name: 'PROXY', type: 'select', proxies: ['AUTO', name] },
			{
				name: 'AUTO',
				type: 'url-test',
				proxies: [name],
				url: 'https://www.gstatic.com/generate_204',
				interval: 300,
			},
		]);
		expect(document.rules).toEqual(['MATCH,PROXY']);
	});

	it('keeps explicit base fields, groups and rules from the profile', async () => {
		const nodeId = await seedNode({ name: 'Custom-01' });
		await seedEndpoint(nodeId);
		const subscriberId = await seedSubscriber();
		await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile({
			clashBase: { 'mixed-port': 7890, mode: 'rule' },
			proxyGroups: [{ name: 'PROXY', type: 'select', proxies: ['Custom-01'] }],
			rules: ['DOMAIN-SUFFIX,example.com,PROXY', 'MATCH,PROXY'],
		});
		const token = testToken('custom');
		await seedSubscription({ token, subscriberId, profileId });

		const document = parse(await (await fetchClash(token)).text()) as ClashDocument;
		expect(document['mixed-port']).toBe(7890);
		expect(document.mode).toBe('rule');
		expect(document['proxy-groups']).toEqual([{ name: 'PROXY', type: 'select', proxies: ['Custom-01'] }]);
		expect(document.rules).toEqual(['DOMAIN-SUFFIX,example.com,PROXY', 'MATCH,PROXY']);
	});

	it('names multiple endpoints by combining the node and endpoint names', async () => {
		const nodeId = await seedNode({ name: 'Multi' });
		await seedEndpoint(nodeId, { name: 'alpha', host: '198.51.100.1' });
		await seedEndpoint(nodeId, { name: 'beta', host: '198.51.100.2' });
		const subscriberId = await seedSubscriber();
		await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();
		const token = testToken('multi');
		await seedSubscription({ token, subscriberId, profileId });

		const document = parse(await (await fetchClash(token)).text()) as ClashDocument;
		expect(document.proxies.map((proxy) => proxy.name).sort()).toEqual(['Multi-alpha', 'Multi-beta']);
	});
});

describe('URI subscription rendering', () => {
	it('encodes IPv6 hosts, omits an empty short id and supports Base64', async () => {
		const nodeId = await seedNode({ name: 'IPv6 Node' });
		await seedEndpoint(nodeId, {
			name: 'v6',
			host: '2001:db8::1',
			params: { ...DEFAULT_PARAMS, short_id: '' },
		});
		const subscriberId = await seedSubscriber();
		const client = await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();
		const token = testToken('uri');
		await seedSubscription({ token, subscriberId, profileId });

		const plainResponse = await SELF.fetch(`https://panel.test/sub/${token}/uri?encoding=plain`);
		expect(plainResponse.status).toBe(200);
		expect(plainResponse.headers.get('Content-Type')).toContain('text/plain');
		expect(plainResponse.headers.get('Content-Disposition')).toContain('zako-uri.txt');
		const plain = await plainResponse.text();

		expect(plain.split('\n')).toHaveLength(1);
		expect(plain.startsWith(`vless://${client.uuid}@[2001:db8::1]:443?`)).toBe(true);
		expect(plain).toContain('encryption=none');
		expect(plain).toContain('flow=xtls-rprx-vision');
		expect(plain).toContain('security=reality');
		expect(plain).toContain('sni=www.example.com');
		expect(plain).toContain(`pbk=${encodeURIComponent(DEFAULT_PARAMS.public_key)}`);
		expect(plain).toContain('type=tcp');
		expect(plain).not.toContain('sid=');
		expect(plain.endsWith(`#${encodeURIComponent('IPv6 Node')}`)).toBe(true);

		const base64Response = await SELF.fetch(`https://panel.test/sub/${token}/uri?encoding=base64`);
		const encoded = await base64Response.text();
		expect(atob(encoded)).toBe(plain);
	});

	it('separates multiple endpoints with newlines in plain mode', async () => {
		const nodeId = await seedNode({ name: 'Multi' });
		await seedEndpoint(nodeId, { name: 'alpha', host: '198.51.100.1' });
		await seedEndpoint(nodeId, { name: 'beta', host: '198.51.100.2' });
		const subscriberId = await seedSubscriber();
		await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();
		const token = testToken('plain');
		await seedSubscription({ token, subscriberId, profileId });

		const plain = await (await SELF.fetch(`https://panel.test/sub/${token}/uri?encoding=plain`)).text();
		const lines = plain.split('\n');
		expect(lines).toHaveLength(2);
		expect(lines.some((line) => line.includes('@198.51.100.1:443'))).toBe(true);
		expect(lines.some((line) => line.includes('@198.51.100.2:443'))).toBe(true);
	});
});

describe('subscription access control', () => {
	it('rejects unknown and revoked tokens with 401', async () => {
		const unknown = await fetchClash(testToken('unknown'));
		expect(unknown.status).toBe(401);
		const unknownBody = (await unknown.json()) as { error: { code: string } };
		expect(unknownBody.error.code).toBe('SUBSCRIPTION_INVALID');

		const dist = await seedDistribution({ scope: 'revoked' });
		await env.DB.prepare('UPDATE subscriptions SET revoked_at = ? WHERE subscriber_id = ?').bind(nowSeconds(), dist.subscriberId).run();
		expect((await fetchClash(dist.token)).status).toBe(401);
	});

	it('rejects disabled, expired and over-quota subscribers with 403', async () => {
		const disabled = await seedDistribution({ scope: 'disabled', subscriberStatus: 'disabled' });
		expect((await fetchClash(disabled.token)).status).toBe(403);

		const expired = await seedDistribution({ scope: 'expired', subscriberExpiresAt: nowSeconds() - 10 });
		expect((await fetchClash(expired.token)).status).toBe(403);

		const quota = await seedDistribution({ scope: 'quota', trafficLimitBytes: 300 });
		const usage = await env.DB.prepare('SELECT usage_cycle_start FROM subscribers WHERE id = ?')
			.bind(quota.subscriberId)
			.first<{ usage_cycle_start: number }>();
		await seedSubscriberUsage(quota.subscriberId, usage?.usage_cycle_start ?? 0, 200, 100);
		expect((await fetchClash(quota.token)).status).toBe(403);

		const expiredSubscription = await seedDistribution({ scope: 'subexp' });
		await env.DB.prepare('UPDATE subscriptions SET expires_at = ? WHERE subscriber_id = ?')
			.bind(nowSeconds() - 10, expiredSubscription.subscriberId)
			.run();
		expect((await fetchClash(expiredSubscription.token)).status).toBe(403);
	});

	it('treats usage from a previous cycle as zero', async () => {
		const dist = await seedDistribution({ scope: 'rolled', trafficLimitBytes: 300 });
		const usage = await env.DB.prepare('SELECT usage_cycle_start FROM subscribers WHERE id = ?')
			.bind(dist.subscriberId)
			.first<{ usage_cycle_start: number }>();
		await seedSubscriberUsage(dist.subscriberId, (usage?.usage_cycle_start ?? 0) - 86_400, 10_000, 10_000);
		expect((await fetchClash(dist.token)).status).toBe(200);
	});

	it('returns 503 when no node can be distributed', async () => {
		const offline = await seedDistribution({ scope: 'offline', onlineOnly: true });
		await env.DB.prepare('UPDATE nodes SET last_seen_at = 1 WHERE id = ?').bind(offline.nodeId).run();
		expect((await fetchClash(offline.token)).status).toBe(503);

		const gone = await seedDistribution({ scope: 'gone' });
		await env.DB.prepare('UPDATE endpoints SET enabled = 0 WHERE node_id = ?').bind(gone.nodeId).run();
		expect((await fetchClash(gone.token)).status).toBe(503);
	});

	it('distributes an offline node when online_only is disabled', async () => {
		const dist = await seedDistribution({ scope: 'allowoffline', onlineOnly: false });
		await env.DB.prepare('UPDATE nodes SET last_seen_at = 1 WHERE id = ?').bind(dist.nodeId).run();
		expect((await fetchClash(dist.token)).status).toBe(200);
	});

	it('keeps a node with a broken stats API distributable', async () => {
		const dist = await seedDistribution({ scope: 'statsbroken' });
		await env.DB.prepare('UPDATE nodes SET stats_healthy = 0 WHERE id = ?').bind(dist.nodeId).run();
		expect((await fetchClash(dist.token)).status).toBe(200);
	});

	it('intersects profile selection with subscriber node grants', async () => {
		const granted = await seedNode({ name: 'Granted' });
		await seedEndpoint(granted);
		const selectedOnly = await seedNode({ name: 'SelectedOnly' });
		await seedEndpoint(selectedOnly);
		const subscriberId = await seedSubscriber();
		await seedNodeClient(granted, subscriberId);
		const profileId = await seedProfile({ nodeSelection: 'selected', nodeIds: [selectedOnly] });
		const token = testToken('intersect');
		await seedSubscription({ token, subscriberId, profileId });

		expect((await fetchClash(token)).status).toBe(503);

		const both = await seedProfile({ nodeSelection: 'selected', nodeIds: [granted, selectedOnly] });
		await env.DB.prepare('UPDATE subscriptions SET profile_id = ? WHERE subscriber_id = ?').bind(both, subscriberId).run();
		const document = parse(await (await fetchClash(token)).text()) as ClashDocument;
		expect(document.proxies.map((proxy) => proxy.name)).toEqual(['Granted']);
	});
});

describe('subscription administration', () => {
	it('creates, rotates and revokes tokens', async () => {
		const nodeId = await seedNode({ name: 'Admin' });
		await seedEndpoint(nodeId);
		const subscriberId = await seedSubscriber();
		await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();

		const created = await createSubscription(env.DB, {
			subscriber_id: subscriberId,
			profile_id: profileId,
			name: 'primary',
		});
		expect(created.subscription.revoked_at).toBeNull();
		expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await getClashSubscription(env.DB, created.token)).toMatchObject({ contentType: 'application/yaml' });

		const rotated = await rotateSubscription(env.DB, created.subscription.id);
		expect(rotated.token).not.toBe(created.token);
		await expect(getClashSubscription(env.DB, created.token)).rejects.toMatchObject({ status: 401 });
		expect(await getClashSubscription(env.DB, rotated.token)).toMatchObject({ contentType: 'application/yaml' });

		const revoked = await revokeSubscription(env.DB, created.subscription.id);
		expect(revoked.revoked_at).toBeGreaterThan(0);
		await expect(getClashSubscription(env.DB, rotated.token)).rejects.toMatchObject({ status: 401 });
	});

	it('reports usage in the subscription-userinfo header', async () => {
		const dist = await seedDistribution({ scope: 'userinfo', trafficLimitBytes: 10_000 });
		await env.DB.prepare('UPDATE subscribers SET expires_at = ? WHERE id = ?')
			.bind(hourStart(nowSeconds()) + 86_400, dist.subscriberId)
			.run();
		const usage = await env.DB.prepare('SELECT usage_cycle_start FROM subscribers WHERE id = ?')
			.bind(dist.subscriberId)
			.first<{ usage_cycle_start: number }>();
		await seedSubscriberUsage(dist.subscriberId, usage?.usage_cycle_start ?? 0, 1_500, 2_500);

		const response = await fetchClash(dist.token);
		expect(response.headers.get('subscription-userinfo')).toBe(
			`upload=1500; download=2500; total=10000; expire=${hourStart(nowSeconds()) + 86_400}`,
		);
	});
});
