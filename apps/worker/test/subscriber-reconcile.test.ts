import type { SubscriberStatus } from '@zako/contracts';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveSubscriberStatus, type UsageSnapshot } from '../src/lib/subscriber-status';
import { subscribersNeedingReconcileStatement } from '../src/repositories/subscribers';
import { reconcileSubscriberCycles } from '../src/services/subscriber-cycle-service';
import { nowSeconds, seedSubscriber, seedSubscriberUsage } from './helpers';

const DAY = 86_400;

interface StoredSubscriber {
	status: SubscriberStatus;
	expires_at: number | null;
	traffic_limit_bytes: number | null;
	usage_cycle_start: number;
	usage_cycle_end: number;
}

async function readSubscriber(subscriberId: string): Promise<StoredSubscriber> {
	const row = await env.DB.prepare(
		'SELECT status, expires_at, traffic_limit_bytes, usage_cycle_start, usage_cycle_end FROM subscribers WHERE id = ?',
	)
		.bind(subscriberId)
		.first<StoredSubscriber>();
	if (!row) throw new Error('subscriber missing');
	return row;
}

async function readUsage(subscriberId: string): Promise<UsageSnapshot | null> {
	const row = await env.DB.prepare('SELECT cycle_start, uplink_bytes, downlink_bytes FROM subscriber_usage WHERE subscriber_id = ? LIMIT 1')
		.bind(subscriberId)
		.first<UsageSnapshot>();
	return row ?? null;
}

function derive(row: StoredSubscriber, usage: UsageSnapshot | null, now: number): SubscriberStatus {
	return deriveSubscriberStatus(
		{
			status: row.status,
			expires_at: row.expires_at,
			traffic_limit_bytes: row.traffic_limit_bytes,
			usage_cycle_start: row.usage_cycle_start,
			usage,
		},
		now,
	);
}

interface SeedCase {
	name: string;
	status?: SubscriberStatus;
	expiresAt?: number | null;
	trafficLimitBytes?: number | null;
	usageCycleEnd?: number;
	/** Usage row relative to the subscriber's current cycle start. */
	usage?: { cycleOffsetDays: number; uplink: number; downlink: number };
}

/**
 * The cron candidate query and the reconciliation service must agree with the
 * single derivation rule. Each case is generated with varied stored status,
 * expiry, quota and usage so the SQL prefilter cannot silently drop a stale row.
 */
describe('subscriber reconciliation candidate selection', () => {
	it('selects exactly the rows the derivation would change or whose cycle ended', async () => {
		const now = nowSeconds();
		const cycleStart = now - DAY;
		const cases: SeedCase[] = [
			{ name: 'active without limits' },
			{ name: 'active already expired', expiresAt: now - 1 },
			{ name: 'active over quota', trafficLimitBytes: 100, usage: { cycleOffsetDays: 0, uplink: 60, downlink: 40 } },
			{ name: 'active below quota', trafficLimitBytes: 100, usage: { cycleOffsetDays: 0, uplink: 30, downlink: 30 } },
			{
				name: 'active with quota spent last cycle',
				trafficLimitBytes: 100,
				usage: { cycleOffsetDays: -30, uplink: 100, downlink: 0 },
			},
			{ name: 'expired consistent', status: 'expired', expiresAt: now - 1 },
			{ name: 'expired without expiry', status: 'expired', expiresAt: null },
			{ name: 'expired extended', status: 'expired', expiresAt: now + DAY },
			{
				name: 'limited at quota',
				status: 'limited',
				trafficLimitBytes: 100,
				usage: { cycleOffsetDays: 0, uplink: 100, downlink: 0 },
			},
			{ name: 'limited without limit', status: 'limited', trafficLimitBytes: null },
			{
				name: 'limited below quota',
				status: 'limited',
				trafficLimitBytes: 100,
				usage: { cycleOffsetDays: 0, uplink: 10, downlink: 10 },
			},
			{
				name: 'limited with stale usage',
				status: 'limited',
				trafficLimitBytes: 100,
				usage: { cycleOffsetDays: -30, uplink: 100, downlink: 0 },
			},
			{ name: 'disabled and expired', status: 'disabled', expiresAt: now - 1 },
			{ name: 'cycle ended while active', usageCycleEnd: now - 1 },
			{
				name: 'cycle ended while limited',
				status: 'limited',
				trafficLimitBytes: 100,
				usage: { cycleOffsetDays: 0, uplink: 100, downlink: 0 },
				usageCycleEnd: now - 1,
			},
			{ name: 'expires now', expiresAt: now },
		];

		const seeded: { id: string; item: SeedCase; stored: StoredSubscriber; usage: UsageSnapshot | null }[] = [];
		for (const item of cases) {
			const id = await seedSubscriber({
				name: item.name,
				status: item.status,
				expiresAt: item.expiresAt ?? null,
				trafficLimitBytes: item.trafficLimitBytes ?? null,
				usageCycleStart: cycleStart,
				usageCycleEnd: item.usageCycleEnd ?? cycleStart + 30 * DAY,
			});
			if (item.usage) {
				await seedSubscriberUsage(id, cycleStart + item.usage.cycleOffsetDays * DAY, item.usage.uplink, item.usage.downlink);
			}
			seeded.push({ id, item, stored: await readSubscriber(id), usage: await readUsage(id) });
		}

		const candidateRows = await subscribersNeedingReconcileStatement(env.DB, now, 100).all<{ id: string }>();
		const candidates = new Set(candidateRows.results.map((row) => row.id));

		for (const { id, item, stored, usage } of seeded) {
			const cycleEnded = stored.usage_cycle_end <= now;
			const expectedSelected = derive(stored, usage, now) !== stored.status || cycleEnded;
			expect(candidates.has(id), item.name).toBe(expectedSelected);
		}

		await reconcileSubscriberCycles(env.DB, now);

		for (const { id, item, stored, usage } of seeded) {
			// A rolled cycle resets usage before the status is derived again.
			const expected = stored.usage_cycle_end <= now ? derive(stored, null, now) : derive(stored, usage, now);
			expect((await readSubscriber(id)).status, item.name).toBe(expected);
		}
	});
});
