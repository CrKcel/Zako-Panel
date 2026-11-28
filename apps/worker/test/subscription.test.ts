import { env, SELF } from 'cloudflare:test';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { previewProfile } from '../src/services/distribution';
import { deleteProfile, updateProfile } from '../src/services/profile-service';
import {
	createSubscription,
	getClashSubscription,
	listSubscriptions,
	revokeSubscription,
	updateSubscription,
} from '../src/services/subscription-service';
import {
	DEFAULT_PARAMS,
	getSubscriberCredential,
	hourStart,
	nowSeconds,
	seedDistribution,
	seedEndpoint,
	seedNode,
	seedMeta,
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
		const client = await getSubscriberCredential(subscriberId);
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

	it('authorizes nodes through profile node selection rules', async () => {
		const nodeA = await seedNode({ name: 'NodeA' });
		await seedEndpoint(nodeA);
		const nodeB = await seedNode({ name: 'NodeB' });
		await seedEndpoint(nodeB);
		const subscriberId = await seedSubscriber();
		const emptySelected = await seedProfile({ nodeSelection: 'selected', nodeIds: [] });
		const token = testToken('intersect');
		await seedSubscription({ token, subscriberId, profileId: emptySelected });

		expect((await fetchClash(token)).status).toBe(503);

		const onlyA = await seedProfile({ nodeSelection: 'selected', nodeIds: [nodeA] });
		await env.DB.prepare('UPDATE subscriptions SET profile_id = ? WHERE subscriber_id = ?').bind(onlyA, subscriberId).run();
		const documentA = parse(await (await fetchClash(token)).text()) as ClashDocument;
		expect(documentA.proxies.map((proxy) => proxy.name)).toEqual(['NodeA']);

		const allNodes = await seedProfile({ nodeSelection: 'all' });
		await env.DB.prepare('UPDATE subscriptions SET profile_id = ? WHERE subscriber_id = ?').bind(allNodes, subscriberId).run();
		const documentAll = parse(await (await fetchClash(token)).text()) as ClashDocument;
		expect(documentAll.proxies.map((proxy) => proxy.name).sort()).toEqual(['NodeA', 'NodeB']);
	});
});

function adminRequest(path: string, init?: RequestInit): Promise<Response> {
	return Promise.resolve(
		worker.fetch(
			new Request(`https://panel.test${path}`, init),
			{
				...env,
				ENVIRONMENT: 'development',
				DEV_ADMIN_EMAIL: 'admin@example.com',
			},
			{} as ExecutionContext,
		),
	);
}

describe('subscription administration', () => {
	it('creates, displays stored tokens, updates rules/metadata, and revokes subscriptions', async () => {
		const nodeId = await seedNode({ name: 'Admin' });
		await seedEndpoint(nodeId);
		const subscriberId = await seedSubscriber();
		const profileId = await seedProfile({ name: 'Rule A', rules: ['DOMAIN-SUFFIX,a.example,PROXY', 'MATCH,PROXY'] });
		const secondProfileId = await seedProfile({ name: 'Rule B', rules: ['DOMAIN-SUFFIX,b.example,PROXY', 'MATCH,PROXY'] });

		const created = await createSubscription(env.DB, {
			subscriber_id: subscriberId,
			profile_id: profileId,
			name: 'primary',
		});
		expect(created.subscription.revoked_at).toBeNull();
		expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(created.subscription.token).toBe(created.token);
		expect(await getClashSubscription(env.DB, created.token)).toMatchObject({ contentType: 'application/yaml' });

		const listed = await listSubscriptions(env.DB, { limit: 50 });
		expect(listed.items).toHaveLength(1);
		expect(listed.items[0]?.token).toBe(created.token);

		const futureExpiry = nowSeconds() + 86_400;
		const patchRes = await adminRequest(`/api/v1/admin/subscriptions/${created.subscription.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				profile_id: secondProfileId,
				name: 'renamed',
				expires_at: futureExpiry,
			}),
		});
		expect(patchRes.status).toBe(200);
		const patchBody = (await patchRes.json()) as {
			data: { name: string; profile_id: string; profile_name: string; expires_at: number; token: string };
		};
		expect(patchBody.data).toMatchObject({
			name: 'renamed',
			profile_id: secondProfileId,
			profile_name: 'Rule B',
			expires_at: futureExpiry,
			token: created.token,
		});

		const updatedDoc = parse(await (await fetchClash(created.token)).text()) as ClashDocument;
		expect(updatedDoc.rules).toEqual(['DOMAIN-SUFFIX,b.example,PROXY', 'MATCH,PROXY']);

		const cleared = await updateSubscription(env.DB, created.subscription.id, { expires_at: null });
		expect(cleared.expires_at).toBeNull();

		// Rotation endpoint has been removed.
		const rotateRes = await adminRequest(`/api/v1/admin/subscriptions/${created.subscription.id}/rotate`, { method: 'POST' });
		expect(rotateRes.status).toBe(404);

		// Rejects soft-deleted or unknown profiles and empty updates.
		const trashedProfile = await seedProfile({ name: 'Trashed' });
		await deleteProfile(env.DB, trashedProfile);
		await expect(updateSubscription(env.DB, created.subscription.id, { profile_id: trashedProfile })).rejects.toMatchObject({
			status: 404,
		});
		await expect(updateSubscription(env.DB, '01J2Z6Q8Y3V9M4K7T1B5C0D2E9', { name: 'missing' })).rejects.toMatchObject({
			status: 404,
		});
		const emptyPatch = await adminRequest(`/api/v1/admin/subscriptions/${created.subscription.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(emptyPatch.status).toBe(400);

		const revoked = await revokeSubscription(env.DB, created.subscription.id);
		expect(revoked.revoked_at).toBeGreaterThan(0);
		await expect(getClashSubscription(env.DB, created.token)).rejects.toMatchObject({ status: 401 });
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

describe('profile preview', () => {
	it('renders the same structure a served subscription returns without the subscriber UUID', async () => {
		const dist = await seedDistribution({ scope: 'preview' });
		const preview = await previewProfile(env.DB, dist.profileId, dist.subscriberId);
		const served = await getClashSubscription(env.DB, dist.token);

		const previewDocument = parse(preview.document) as ClashDocument;
		const servedDocument = parse(served.body) as ClashDocument;
		expect(previewDocument.proxies).toEqual(
			servedDocument.proxies.map((proxy) => ({ ...proxy, uuid: '00000000-0000-0000-0000-000000000000' })),
		);
		expect(previewDocument['proxy-groups']).toEqual(servedDocument['proxy-groups']);
		expect(previewDocument.rules).toEqual(servedDocument.rules);
		expect(preview.document).not.toContain(dist.nodeClient.uuid);

		expect(preview.proxies).toHaveLength(1);
		expect(preview.proxies[0]?.node_id).toBe(dist.nodeId);
		expect(preview.skipped).toEqual([]);
		expect(preview.subscriber.blocked_reason).toBeNull();
	});

	it('reports why a granted node is dropped from distribution', async () => {
		const online = await seedNode({ name: 'Online' });
		await seedEndpoint(online);
		const offline = await seedNode({ name: 'Offline', lastSeenAt: 1 });
		await seedEndpoint(offline);
		const noEndpoint = await seedNode({ name: 'NoEndpoint' });
		const disabled = await seedNode({ name: 'Disabled', enabled: false });
		await seedEndpoint(disabled);
		const unhealthy = await seedNode({ name: 'Unhealthy', xrayHealthy: false });
		await seedEndpoint(unhealthy);
		const notSelected = await seedNode({ name: 'NotSelected' });
		await seedEndpoint(notSelected);

		const subscriberId = await seedSubscriber();
		const profileId = await seedProfile({ nodeSelection: 'selected', nodeIds: [online, offline, noEndpoint, disabled, unhealthy] });

		const preview = await previewProfile(env.DB, profileId, subscriberId);
		expect(preview.proxies.map((proxy) => proxy.node_id)).toEqual([online]);
		expect(
			[...preview.skipped].sort((a, b) => a.node_name.localeCompare(b.node_name)).map((entry) => [entry.node_name, entry.reason]),
		).toEqual([
			['Disabled', 'disabled'],
			['NoEndpoint', 'no_endpoint'],
			['NotSelected', 'not_selected'],
			['Offline', 'offline'],
			['Unhealthy', 'unhealthy'],
		]);
	});

	it('reports the reason a served subscription would be refused', async () => {
		const dist = await seedDistribution({ scope: 'blocked', subscriberStatus: 'disabled' });
		const disabledPreview = await previewProfile(env.DB, dist.profileId, dist.subscriberId);
		expect(disabledPreview.subscriber.blocked_reason).toBe('inactive');

		const expired = await seedDistribution({ scope: 'blockedexpired', subscriberExpiresAt: nowSeconds() - 10 });
		const expiredPreview = await previewProfile(env.DB, expired.profileId, expired.subscriberId);
		expect(expiredPreview.subscriber.blocked_reason).toBe('expired');

		const quota = await seedDistribution({ scope: 'blockedquota', trafficLimitBytes: 100 });
		const usage = await env.DB.prepare('SELECT usage_cycle_start FROM subscribers WHERE id = ?')
			.bind(quota.subscriberId)
			.first<{ usage_cycle_start: number }>();
		await seedSubscriberUsage(quota.subscriberId, usage?.usage_cycle_start ?? 0, 100, 0);
		const quotaPreview = await previewProfile(env.DB, quota.profileId, quota.subscriberId);
		expect(quotaPreview.subscriber.blocked_reason).toBe('over_quota');
		await expect(getClashSubscription(env.DB, quota.token)).rejects.toMatchObject({ status: 403 });
	});

	it('renders an empty document instead of failing when nothing is distributable', async () => {
		const dist = await seedDistribution({ scope: 'emptypreview', onlineOnly: true });
		await env.DB.prepare('UPDATE nodes SET last_seen_at = 1 WHERE id = ?').bind(dist.nodeId).run();

		const preview = await previewProfile(env.DB, dist.profileId, dist.subscriberId);
		expect(preview.proxies).toEqual([]);
		expect(parse(preview.document)).toMatchObject({ proxies: [], rules: ['MATCH,PROXY'] });
		await expect(getClashSubscription(env.DB, dist.token)).rejects.toMatchObject({ status: 503 });
	});

	it('defaults to the default subscriber and rejects unknown profiles or subscribers', async () => {
		const dist = await seedDistribution({ scope: 'previewdefault' });
		await seedMeta('default_subscriber_id', dist.subscriberId);

		const preview = await previewProfile(env.DB, dist.profileId);
		expect(preview.subscriber.id).toBe(dist.subscriberId);

		await expect(previewProfile(env.DB, '01J2Z6Q8Y3V9M4K7T1B5C0D2E9')).rejects.toMatchObject({ status: 404 });
		await expect(previewProfile(env.DB, dist.profileId, '01J2Z6Q8Y3V9M4K7T1B5C0D2E8')).rejects.toMatchObject({
			status: 404,
		});
	});
});

describe('profile preview endpoint', () => {
	it('is mounted under the admin Access middleware', async () => {
		const dist = await seedDistribution({ scope: 'previewauth' });
		const preview = await SELF.fetch(`https://panel.test/api/v1/admin/profiles/${dist.profileId}/preview`);
		expect(preview.status).toBe(401);
		const body = (await preview.json()) as { error: { code: string } };
		expect(body.error.code).toBe('UNAUTHORIZED');

		// The sibling detail path answers the same way, so the 401 above comes from
		// the middleware rather than from preview not being registered.
		const detail = await SELF.fetch(`https://panel.test/api/v1/admin/profiles/${dist.profileId}`);
		expect(detail.status).toBe(401);
	});
});

describe('profile rule authorization', () => {
	it('controls node distribution directly when the profile rule changes', async () => {
		const nodeId = await seedNode({ name: 'Rule node' });
		await seedEndpoint(nodeId);
		const subscriberId = await seedSubscriber();
		const profileId = await seedProfile({ nodeSelection: 'selected', nodeIds: [] });
		const token = testToken('grant');
		await seedSubscription({ token, subscriberId, profileId });

		expect((await fetchClash(token)).status).toBe(503);

		await updateProfile(env.DB, profileId, { node_ids: [nodeId] });
		const response = await fetchClash(token);
		expect(response.status).toBe(200);
		const document = parse(await response.text()) as ClashDocument;
		expect(document.proxies.map((proxy) => proxy.name)).toEqual(['Rule node']);

		await updateProfile(env.DB, profileId, { node_ids: [] });
		expect((await fetchClash(token)).status).toBe(503);
	});
});
