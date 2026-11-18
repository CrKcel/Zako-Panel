import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runScheduledJob } from '../src/services/cron-service';
import { subscribersNeedingReconcileStatement } from '../src/repositories/subscribers';
import { reconcileSubscriberCycles } from '../src/services/subscriber-cycle-service';
import { nowSeconds, readMeta, seedSubscriber, seedSubscriberUsage } from './helpers';

const DAY = 86_400;

async function readSubscriber(subscriberId: string): Promise<{
	status: string;
	usage_cycle_start: number;
	usage_cycle_end: number;
}> {
	const row = await env.DB.prepare('SELECT status, usage_cycle_start, usage_cycle_end FROM subscribers WHERE id = ?')
		.bind(subscriberId)
		.first<{ status: string; usage_cycle_start: number; usage_cycle_end: number }>();
	if (!row) throw new Error('subscriber missing');
	return row;
}

async function readUsage(subscriberId: string): Promise<{ cycle_start: number; uplink_bytes: number; downlink_bytes: number }> {
	const row = await env.DB.prepare('SELECT cycle_start, uplink_bytes, downlink_bytes FROM subscriber_usage WHERE subscriber_id = ?')
		.bind(subscriberId)
		.first<{ cycle_start: number; uplink_bytes: number; downlink_bytes: number }>();
	if (!row) throw new Error('usage missing');
	return row;
}

describe('subscriber cycle reconciliation', () => {
	it('advances an elapsed cycle, resets usage and reactivates a quota-limited subscriber', async () => {
		const now = nowSeconds();
		const oldStart = now - 40 * DAY;
		const oldEnd = now - 10 * DAY;
		const subscriberId = await seedSubscriber({
			name: 'Rolled',
			status: 'limited',
			trafficLimitBytes: 100,
			usageCycleStart: oldStart,
			usageCycleEnd: oldEnd,
		});
		await seedSubscriberUsage(subscriberId, oldStart, 100, 0);
		await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('users_ver', '5')").run();

		const result = await reconcileSubscriberCycles(env.DB, now);
		expect(result).toEqual({ advanced: 1, status_changed: 1 });

		const subscriber = await readSubscriber(subscriberId);
		expect(subscriber.status).toBe('active');
		expect(subscriber.usage_cycle_start).toBe(oldEnd);
		expect(subscriber.usage_cycle_end).toBeGreaterThan(now);
		expect(await readUsage(subscriberId)).toEqual({ cycle_start: oldEnd, uplink_bytes: 0, downlink_bytes: 0 });
		expect(await readMeta('users_ver')).toBe('6');
	});

	it('advances across every missed cycle while keeping the cycle in the future', async () => {
		const now = nowSeconds();
		const oldStart = now - 120 * DAY;
		const oldEnd = now - 90 * DAY;
		const subscriberId = await seedSubscriber({ usageCycleStart: oldStart, usageCycleEnd: oldEnd });

		await reconcileSubscriberCycles(env.DB, now);

		const subscriber = await readSubscriber(subscriberId);
		expect(subscriber.usage_cycle_start).toBeGreaterThan(oldEnd);
		expect(subscriber.usage_cycle_end).toBeGreaterThan(now);
		expect(subscriber.usage_cycle_end - now).toBeLessThanOrEqual(31 * DAY);
	});

	it('materialises expired and limited statuses without moving the cycle', async () => {
		const now = nowSeconds();
		const expiredId = await seedSubscriber({ name: 'Expired', expiresAt: now - 1 });
		const limitedId = await seedSubscriber({ name: 'Limited', trafficLimitBytes: 100 });
		const limitedRow = await readSubscriber(limitedId);
		await seedSubscriberUsage(limitedId, limitedRow.usage_cycle_start, 60, 40);
		const disabledId = await seedSubscriber({ name: 'Disabled', status: 'disabled', expiresAt: now - 1 });
		// Usage left over from an earlier cycle must not keep a subscriber limited.
		const staleId = await seedSubscriber({ name: 'Stale usage', status: 'limited', trafficLimitBytes: 100 });
		const staleRow = await readSubscriber(staleId);
		await seedSubscriberUsage(staleId, staleRow.usage_cycle_start - 30 * DAY, 100, 0);

		const result = await reconcileSubscriberCycles(env.DB, now);
		expect(result).toEqual({ advanced: 0, status_changed: 3 });

		expect((await readSubscriber(expiredId)).status).toBe('expired');
		expect((await readSubscriber(limitedId)).status).toBe('limited');
		expect((await readSubscriber(disabledId)).status).toBe('disabled');
		expect((await readSubscriber(staleId)).status).toBe('active');
		expect(await readMeta('users_ver')).toBe('1');

		// The cycle columns stay untouched when only the status changed.
		expect((await readSubscriber(limitedId)).usage_cycle_end).toBe(limitedRow.usage_cycle_end);
	});

	it('does not advance the users version when every status already matches', async () => {
		const now = nowSeconds();
		await seedSubscriber({ name: 'Active' });
		await seedSubscriber({ name: 'Expired already', status: 'expired', expiresAt: now - 1 });

		const result = await reconcileSubscriberCycles(env.DB, now);
		expect(result).toEqual({ advanced: 0, status_changed: 0 });
		expect(await readMeta('users_ver')).toBeNull();
	});

	it('reads only rows that can still be stale', async () => {
		const now = nowSeconds();
		const stable = await seedSubscriber({ name: 'Stable', trafficLimitBytes: 100 });
		const stableRow = await readSubscriber(stable);
		await seedSubscriberUsage(stable, stableRow.usage_cycle_start, 10, 10);
		// Mark the row as already consistent so it must not be selected again.
		await env.DB.prepare("UPDATE subscribers SET status = 'active' WHERE id = ?").bind(stable).run();

		const candidates = await subscribersNeedingReconcileStatement(env.DB, now, 10).all<{ id: string }>();
		expect(candidates.results).toEqual([]);
	});

	it('runs on the quarter-hour trigger and leaves retention cleanup to the daily trigger', async () => {
		const now = nowSeconds();
		const subscriberId = await seedSubscriber({ name: 'Cron expired', expiresAt: now - 1 });

		await runScheduledJob(env, '*/15 * * * *', now);
		expect((await readSubscriber(subscriberId)).status).toBe('expired');

		const reports = await env.DB.prepare('SELECT COUNT(*) AS count FROM traffic_reports').first<{ count: number }>();
		expect(reports?.count).toBe(0);
	});
});
