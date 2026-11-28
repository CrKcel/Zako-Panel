import type { RecycleBinCounts, RecycleBinList, RecycleBinRestoreResult } from '@zako/contracts';
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { runScheduledJob } from '../src/services/cron-service';
import { deleteProfile, getProfile, listProfiles } from '../src/services/profile-service';
import {
	emptyRecycleBin,
	listRecycleBinItems,
	purgeRecycleBinItem,
	RECYCLE_BIN_RETENTION_DAYS,
	restoreRecycleBinItem,
} from '../src/services/recycle-bin-service';
import { createSubscriber, listSubscribers, replaceSubscriberNodes, updateSubscriber } from '../src/services/subscriber-service';
import {
	createSubscription,
	getClashSubscription,
	listSubscriptions,
	revokeSubscription,
	updateSubscription,
} from '../src/services/subscription-service';
import {
	nowSeconds,
	readMeta,
	seedEndpoint,
	seedMeta,
	seedNode,
	seedNodeClient,
	seedProfile,
	seedSubscriber,
	seedSubscriberUsage,
	seedSubscription,
	testToken,
} from './helpers';

const DAY = 86_400;

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

describe('recycle bin', () => {
	it('moves disabled subscribers, revoked subscriptions, and deleted profiles into the recycle bin', async () => {
		const sub = await createSubscriber(env.DB, { name: 'Alice', email: 'alice@example.com' });
		const activeSub = await createSubscriber(env.DB, { name: 'Bob' });
		const profile = await seedProfile({ name: 'Default Profile' });
		const removableProfile = await seedProfile({ name: 'Old Profile' });
		const createdSubscription = await createSubscription(env.DB, {
			subscriber_id: activeSub.id,
			profile_id: profile,
			name: 'Bob Sub',
		});

		await updateSubscriber(env.DB, sub.id, { status: 'disabled' });
		await revokeSubscription(env.DB, createdSubscription.subscription.id);
		await deleteProfile(env.DB, removableProfile);

		expect((await listSubscribers(env.DB, { limit: 50 })).items.map((item) => item.id)).toEqual([activeSub.id]);
		expect((await listSubscriptions(env.DB, { limit: 50 })).items).toEqual([]);
		expect((await listProfiles(env.DB, { limit: 50 })).items.map((item) => item.id)).toEqual([profile]);

		const bin = await listRecycleBinItems(env.DB);
		expect(bin.retention_days).toBe(RECYCLE_BIN_RETENTION_DAYS);
		expect(bin.counts).toEqual({ subscriber: 1, subscription: 1, profile: 1, total: 3 });
		expect(bin.items.map((item) => ({ type: item.type, id: item.id, name: item.name }))).toEqual(
			expect.arrayContaining([
				{ type: 'subscriber', id: sub.id, name: 'Alice' },
				{ type: 'subscription', id: createdSubscription.subscription.id, name: 'Bob Sub' },
				{ type: 'profile', id: removableProfile, name: 'Old Profile' },
			]),
		);

		const subBinItem = bin.items.find((item) => item.type === 'subscription');
		expect(subBinItem?.detail).toBe('Bob · Default Profile');
		expect(subBinItem?.purge_at).toBe((subBinItem?.deleted_at ?? 0) + RECYCLE_BIN_RETENTION_DAYS * DAY);

		const onlyProfiles = await listRecycleBinItems(env.DB, 'profile');
		expect(onlyProfiles.items).toHaveLength(1);
		expect(onlyProfiles.counts.total).toBe(3);
	});

	it('allows deleting a profile once its subscriptions are revoked, and rejects updating revoked subscriptions', async () => {
		const subscriberId = await seedSubscriber({ name: 'User' });
		const profileId = await seedProfile({ name: 'Profile' });
		const created = await createSubscription(env.DB, { subscriber_id: subscriberId, profile_id: profileId, name: 'Sub' });

		await expect(deleteProfile(env.DB, profileId)).rejects.toMatchObject({ status: 409 });

		await revokeSubscription(env.DB, created.subscription.id);
		await expect(updateSubscription(env.DB, created.subscription.id, { name: 'Updated' })).rejects.toMatchObject({ status: 409 });

		await deleteProfile(env.DB, profileId);
		await expect(getProfile(env.DB, profileId)).rejects.toMatchObject({ status: 404 });
	});

	it('restores disabled subscribers, deleted profiles, and revoked subscriptions in dependency order', async () => {
		const nodeId = await seedNode({ name: 'Node-1' });
		await seedEndpoint(nodeId);
		const subscriber = await createSubscriber(env.DB, { name: 'Restorable' });
		await replaceSubscriberNodes(env.DB, subscriber.id, [nodeId]);
		const profileId = await seedProfile({ name: 'Restorable Profile' });
		const { subscription, token } = await createSubscription(env.DB, {
			subscriber_id: subscriber.id,
			profile_id: profileId,
			name: 'Restorable Sub',
		});

		await updateSubscriber(env.DB, subscriber.id, { status: 'disabled' });
		await revokeSubscription(env.DB, subscription.id);
		await deleteProfile(env.DB, profileId);

		// Subscription cannot be restored while its subscriber or profile is still in the recycle bin.
		await expect(restoreRecycleBinItem(env.DB, 'subscription', subscription.id, 'admin@example.com')).rejects.toMatchObject({
			status: 409,
		});

		const verBefore = Number((await readMeta('users_ver')) ?? '0');
		await restoreRecycleBinItem(env.DB, 'subscriber', subscriber.id, 'admin@example.com');
		expect(Number(await readMeta('users_ver'))).toBe(verBefore + 1);
		expect((await listSubscribers(env.DB, { limit: 50 })).items.map((item) => item.id)).toEqual([subscriber.id]);

		// Still blocked until profile is restored.
		await expect(restoreRecycleBinItem(env.DB, 'subscription', subscription.id, 'admin@example.com')).rejects.toMatchObject({
			status: 409,
		});

		await restoreRecycleBinItem(env.DB, 'profile', profileId, 'admin@example.com');
		await restoreRecycleBinItem(env.DB, 'subscription', subscription.id, 'admin@example.com');

		const served = await getClashSubscription(env.DB, token);
		expect(served.contentType).toBe('application/yaml');
		expect((await listRecycleBinItems(env.DB)).counts.total).toBe(0);
	});

	it('permanently purges individual items including subscriber dependencies while keeping site/node buckets', async () => {
		const nodeId = await seedNode({ name: 'Node-Purge' });
		const subscriberId = await seedSubscriber({ name: 'PurgeMe', status: 'disabled' });
		await seedMeta('default_subscriber_id', subscriberId);
		await seedNodeClient(nodeId, subscriberId);
		await seedSubscriberUsage(subscriberId, nowSeconds() - 100, 10, 20);
		await env.DB.prepare(
			'INSERT INTO user_traffic_hourly (subscriber_id, node_id, bucket_start, uplink_bytes, downlink_bytes, updated_at) VALUES (?, ?, ?, 10, 20, ?)',
		)
			.bind(subscriberId, nodeId, 3600, nowSeconds())
			.run();
		await env.DB.prepare('INSERT INTO site_traffic_hourly (bucket_start, uplink_bytes, downlink_bytes, updated_at) VALUES (?, 10, 20, ?)')
			.bind(3600, nowSeconds())
			.run();
		const profileId = await seedProfile({ name: 'TempProfile' });
		await seedSubscription({ token: testToken('purgeme'), subscriberId, profileId });

		await purgeRecycleBinItem(env.DB, 'subscriber', subscriberId, 'admin@example.com');

		expect(await env.DB.prepare('SELECT id FROM subscribers WHERE id = ?').bind(subscriberId).first()).toBeNull();
		expect(await env.DB.prepare('SELECT id FROM node_clients WHERE subscriber_id = ?').bind(subscriberId).first()).toBeNull();
		expect(
			await env.DB.prepare('SELECT subscriber_id FROM subscriber_usage WHERE subscriber_id = ?').bind(subscriberId).first(),
		).toBeNull();
		expect(
			await env.DB.prepare('SELECT subscriber_id FROM user_traffic_hourly WHERE subscriber_id = ?').bind(subscriberId).first(),
		).toBeNull();
		expect(await env.DB.prepare('SELECT id FROM subscriptions WHERE subscriber_id = ?').bind(subscriberId).first()).toBeNull();
		expect(await readMeta('default_subscriber_id')).toBeNull();
		// Site aggregate traffic survives.
		expect(await env.DB.prepare('SELECT bucket_start FROM site_traffic_hourly WHERE bucket_start = 3600').first()).not.toBeNull();
	});

	it('empties the recycle bin cleanly even when revoked subscriptions reference trashed profiles and subscribers', async () => {
		const subId = await seedSubscriber({ name: 'EmptyUser', status: 'disabled' });
		const profileId = await seedProfile({ name: 'EmptyProfile' });
		const subscriptionId = await seedSubscription({
			token: testToken('empty'),
			subscriberId: subId,
			profileId,
			revokedAt: nowSeconds() - 60,
		});
		await deleteProfile(env.DB, profileId);

		const deleted = await emptyRecycleBin(env.DB, undefined, 'admin@example.com');
		expect(deleted).toEqual({ subscriber: 1, subscription: 1, profile: 1, total: 3 });
		expect(await env.DB.prepare('SELECT id FROM subscriptions WHERE id = ?').bind(subscriptionId).first()).toBeNull();
		expect(await env.DB.prepare('SELECT id FROM subscription_profiles WHERE id = ?').bind(profileId).first()).toBeNull();
		expect(await env.DB.prepare('SELECT id FROM subscribers WHERE id = ?').bind(subId).first()).toBeNull();
	});

	it('automatically purges expired recycle bin items on the daily cron and keeps recent ones', async () => {
		const now = nowSeconds();
		const expiredAt = now - (RECYCLE_BIN_RETENTION_DAYS + 1) * DAY;
		const recentAt = now - 2 * DAY;

		const oldSub = await seedSubscriber({ name: 'OldDisabled', status: 'disabled' });
		await env.DB.prepare('UPDATE subscribers SET disabled_at = ? WHERE id = ?').bind(expiredAt, oldSub).run();

		const freshSub = await seedSubscriber({ name: 'FreshDisabled', status: 'disabled' });
		await env.DB.prepare('UPDATE subscribers SET disabled_at = ? WHERE id = ?').bind(recentAt, freshSub).run();

		const activeSub = await seedSubscriber({ name: 'ActiveUser' });
		const oldProfile = await seedProfile({ name: 'OldDeletedProfile' });
		const freshProfile = await seedProfile({ name: 'FreshDeletedProfile' });
		await env.DB.prepare('UPDATE subscription_profiles SET deleted_at = ? WHERE id = ?').bind(expiredAt, oldProfile).run();
		await env.DB.prepare('UPDATE subscription_profiles SET deleted_at = ? WHERE id = ?').bind(recentAt, freshProfile).run();

		const oldSubscription = await seedSubscription({
			token: testToken('oldsub'),
			subscriberId: activeSub,
			profileId: freshProfile,
			revokedAt: expiredAt,
		});
		const freshSubscription = await seedSubscription({
			token: testToken('freshsub'),
			subscriberId: activeSub,
			profileId: freshProfile,
			revokedAt: recentAt,
		});

		// Quarter-hour cron must not purge recycle bin items.
		await runScheduledJob(env, '*/15 * * * *', now);
		expect((await listRecycleBinItems(env.DB)).counts.total).toBe(6);

		// Daily cron purges only items older than retention window.
		await runScheduledJob(env, '17 3 * * *', now);
		const remaining = await listRecycleBinItems(env.DB);
		expect(remaining.counts).toEqual({ subscriber: 1, subscription: 1, profile: 1, total: 3 });
		expect(remaining.items.map((item) => item.id).sort()).toEqual([freshProfile, freshSub, freshSubscription].sort());
		expect(await env.DB.prepare('SELECT id FROM subscriptions WHERE id = ?').bind(oldSubscription).first()).toBeNull();
		expect(await env.DB.prepare('SELECT id FROM subscription_profiles WHERE id = ?').bind(oldProfile).first()).toBeNull();
		expect(await env.DB.prepare('SELECT id FROM subscribers WHERE id = ?').bind(oldSub).first()).toBeNull();
	});

	it('serves admin recycle-bin HTTP endpoints with Access auth', async () => {
		const unauth = await SELF.fetch('https://panel.test/api/v1/admin/recycle-bin');
		expect(unauth.status).toBe(401);

		const profileId = await seedProfile({ name: 'HttpProfile' });
		await deleteProfile(env.DB, profileId);

		const listRes = await adminRequest('/api/v1/admin/recycle-bin?type=profile');
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as { data: RecycleBinList };
		expect(listBody.data.items.map((item) => item.id)).toEqual([profileId]);

		const restoreRes = await adminRequest(`/api/v1/admin/recycle-bin/profile/${profileId}/restore`, { method: 'POST' });
		expect(restoreRes.status).toBe(200);
		const restoreBody = (await restoreRes.json()) as { data: RecycleBinRestoreResult };
		expect(restoreBody.data).toEqual({ type: 'profile', id: profileId });

		await deleteProfile(env.DB, profileId);
		const purgeRes = await adminRequest(`/api/v1/admin/recycle-bin/profile/${profileId}`, { method: 'DELETE' });
		expect(purgeRes.status).toBe(204);

		const secondProfile = await seedProfile({ name: 'HttpProfile2' });
		await deleteProfile(env.DB, secondProfile);
		const emptyRes = await adminRequest('/api/v1/admin/recycle-bin', { method: 'DELETE' });
		expect(emptyRes.status).toBe(200);
		const emptyBody = (await emptyRes.json()) as { data: { deleted: RecycleBinCounts } };
		expect(emptyBody.data.deleted).toEqual({ subscriber: 0, subscription: 0, profile: 1, total: 1 });
	});
});
