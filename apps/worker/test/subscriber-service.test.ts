import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSubscriber, getSubscriber, listSubscribers, updateSubscriber } from '../src/services/subscriber-service';
import type { Subscriber } from '@zako/contracts';
import { getSubscriberCredential, nowSeconds, readMeta, seedSubscriberUsage } from './helpers';

describe('subscriber management', () => {
	it('creates a subscriber on the current UTC calendar month cycle with unique credentials', async () => {
		const subscriber = await createSubscriber(env.DB, {
			name: 'Alice',
			email: ' Alice@Example.COM ',
			traffic_limit_bytes: 1_000,
			expires_at: null,
		});

		expect(subscriber.email).toBe('alice@example.com');
		expect(subscriber.status).toBe('active');
		expect(subscriber.usage).toEqual({ cycle_start: subscriber.usage_cycle_start, uplink_bytes: 0, downlink_bytes: 0 });
		expect(new Date(subscriber.usage_cycle_start * 1000).getUTCDate()).toBe(1);
		expect(new Date(subscriber.usage_cycle_end * 1000).getUTCDate()).toBe(1);
		const start = new Date(subscriber.usage_cycle_start * 1000);
		expect(subscriber.usage_cycle_end).toBe(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) / 1000);

		const credential = await getSubscriberCredential(subscriber.id);
		expect(credential.xrayEmail).toMatch(/^u_[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(credential.uuid).toMatch(/^[0-9a-f-]{36}$/);
		expect(await readMeta('users_ver')).toBe('1');
	});

	it('stores a newly created subscriber in its derived state without bumping users_ver when inactive', async () => {
		const expired = await createSubscriber(env.DB, { name: 'Born expired', expires_at: nowSeconds() - 10 });
		expect(expired.status).toBe('expired');

		const emptyQuota = await createSubscriber(env.DB, { name: 'No quota', traffic_limit_bytes: 0 });
		expect(emptyQuota.status).toBe('limited');
		expect(await readMeta('users_ver')).toBeNull();
	});

	it('rejects a duplicate email', async () => {
		await createSubscriber(env.DB, { name: 'Alice', email: 'alice@example.com' });
		await expect(createSubscriber(env.DB, { name: 'Alice 2', email: 'ALICE@example.com' })).rejects.toMatchObject({
			status: 409,
		});
	});

	it('pages subscribers by id and reports the current cycle usage', async () => {
		const created = [
			await createSubscriber(env.DB, { name: 'User A' }),
			await createSubscriber(env.DB, { name: 'User B' }),
			await createSubscriber(env.DB, { name: 'User C' }),
		];
		// ULIDs created in the same millisecond are not ordered by creation time, so
		// every expectation is derived from the identifiers themselves.
		const ordered = created.map((subscriber) => subscriber.id).sort();
		const target = created[0] as Subscriber;
		const cycle = target.usage_cycle_start;
		await seedSubscriberUsage(target.id, cycle, 300, 700);

		const page = await listSubscribers(env.DB, { limit: 2 });
		expect(page.items.map((item) => item.id)).toEqual(ordered.slice(0, 2));
		expect(page.next_cursor).toBe(ordered[1]);

		const rest = await listSubscribers(env.DB, { limit: 2, cursor: page.next_cursor ?? undefined });
		expect(rest.items.map((item) => item.id)).toEqual(ordered.slice(2));
		expect(rest.next_cursor).toBeNull();

		const listed = [...page.items, ...rest.items].find((item) => item.id === target.id);
		expect(listed?.usage).toEqual({ cycle_start: cycle, uplink_bytes: 300, downlink_bytes: 700 });
	});

	it('derives the materialised status from expiry, quota and explicit suspension', async () => {
		const limited = await createSubscriber(env.DB, { name: 'Limited', traffic_limit_bytes: 100 });
		expect(await readMeta('users_ver')).toBe('1');
		const cycle = (await getSubscriber(env.DB, limited.id)).usage_cycle_start;
		await seedSubscriberUsage(limited.id, cycle, 60, 40);
		const afterQuota = await updateSubscriber(env.DB, limited.id, { name: 'Limited renamed' });
		expect(afterQuota.status).toBe('limited');
		expect(await readMeta('users_ver')).toBe('2');

		const expired = await createSubscriber(env.DB, { name: 'Expired', expires_at: nowSeconds() - 10 });
		expect((await updateSubscriber(env.DB, expired.id, { name: 'Expired renamed' })).status).toBe('expired');

		const suspended = await updateSubscriber(env.DB, limited.id, { status: 'disabled' });
		expect(suspended.status).toBe('disabled');
		// A quota or expiry change must not silently lift an administrator suspension.
		expect((await updateSubscriber(env.DB, limited.id, { traffic_limit_bytes: 10_000 })).status).toBe('disabled');

		const reactivated = await updateSubscriber(env.DB, limited.id, { status: 'active', traffic_limit_bytes: null });
		expect(reactivated.status).toBe('active');
	});

	it('does not advance the users version when the status is unchanged', async () => {
		const subscriber = await createSubscriber(env.DB, { name: 'Stable' });
		const versionAfterCreate = await readMeta('users_ver');
		await updateSubscriber(env.DB, subscriber.id, { name: 'Stable renamed' });
		expect(await readMeta('users_ver')).toBe(versionAfterCreate);
	});
});
