import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getTrafficSummary } from '../src/services/traffic-service';
import { hourStart, nowSeconds, seedNode, seedSubscriber, seedSubscriberUsage } from './helpers';

const HOUR = 3_600;
const DAY = 86_400;

async function insertNodeHour(nodeId: string, bucket: number, uplink: number, downlink: number): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO node_traffic_hourly (node_id, bucket_start, uplink_bytes, downlink_bytes, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(nodeId, bucket, uplink, downlink, nowSeconds())
		.run();
}

async function insertSiteHour(bucket: number, uplink: number, downlink: number): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO site_traffic_hourly (bucket_start, uplink_bytes, downlink_bytes, updated_at)
		 VALUES (?, ?, ?, ?)`,
	)
		.bind(bucket, uplink, downlink, nowSeconds())
		.run();
}

async function insertUserHour(subscriberId: string, nodeId: string, bucket: number, uplink: number, downlink: number): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO user_traffic_hourly (subscriber_id, node_id, bucket_start, uplink_bytes, downlink_bytes, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(subscriberId, nodeId, bucket, uplink, downlink, nowSeconds())
		.run();
}

describe('traffic summary', () => {
	it('aggregates node buckets and labels them with node names', async () => {
		const tokyo = await seedNode({ name: 'Tokyo' });
		const osaka = await seedNode({ name: 'Osaka' });
		const bucket = hourStart(nowSeconds()) - HOUR;
		await insertNodeHour(tokyo, bucket, 100, 200);
		await insertNodeHour(tokyo, bucket + HOUR, 50, 50);
		await insertNodeHour(osaka, bucket, 10, 20);

		const summary = await getTrafficSummary(env.DB, {
			from: bucket,
			to: bucket + 2 * HOUR,
			groupBy: 'node',
		});
		expect(summary.from).toBe(bucket);
		expect(summary.to).toBe(bucket + 2 * HOUR);
		expect(summary.group_by).toBe('node');
		expect(summary.items).toEqual([
			{ key: tokyo, label: 'Tokyo', uplink_bytes: 150, downlink_bytes: 250 },
			{ key: osaka, label: 'Osaka', uplink_bytes: 10, downlink_bytes: 20 },
		]);
	});

	it('filters node aggregation by node id and normalizes the range to hours', async () => {
		const tokyo = await seedNode({ name: 'Tokyo' });
		const osaka = await seedNode({ name: 'Osaka' });
		const bucket = hourStart(nowSeconds()) - HOUR;
		await insertNodeHour(tokyo, bucket, 100, 200);
		await insertNodeHour(osaka, bucket, 10, 20);

		const summary = await getTrafficSummary(env.DB, {
			from: bucket + 120,
			to: bucket + HOUR + 120,
			groupBy: 'node',
			nodeId: tokyo,
		});
		expect(summary.from).toBe(bucket);
		expect(summary.to).toBe(bucket + HOUR);
		expect(summary.items).toEqual([{ key: tokyo, label: 'Tokyo', uplink_bytes: 100, downlink_bytes: 200 }]);
	});

	it('aggregates the site total and subscriber totals', async () => {
		const nodeId = await seedNode({ name: 'Tokyo' });
		const subscriberId = await seedSubscriber({ name: 'Alice' });
		const bucket = hourStart(nowSeconds()) - HOUR;
		await insertSiteHour(bucket, 100, 200);
		await insertSiteHour(bucket + HOUR, 50, 25);
		await insertUserHour(subscriberId, nodeId, bucket, 100, 200);

		const site = await getTrafficSummary(env.DB, { from: bucket, to: bucket + 2 * HOUR, groupBy: 'site' });
		expect(site.items).toEqual([{ key: 'site', label: 'Site', uplink_bytes: 150, downlink_bytes: 225 }]);

		const subscribers = await getTrafficSummary(env.DB, {
			from: bucket,
			to: bucket + 2 * HOUR,
			groupBy: 'subscriber',
		});
		expect(subscribers.items).toEqual([{ key: subscriberId, label: 'Alice', uplink_bytes: 100, downlink_bytes: 200 }]);
	});

	it('rejects unbounded or inverted ranges', async () => {
		const bucket = hourStart(nowSeconds());
		await expect(getTrafficSummary(env.DB, { from: bucket, to: bucket, groupBy: 'site' })).rejects.toMatchObject({
			code: 'VALIDATION_ERROR',
			status: 400,
		});
		await expect(getTrafficSummary(env.DB, { from: bucket, to: bucket + 32 * DAY, groupBy: 'site' })).rejects.toMatchObject({
			code: 'VALIDATION_ERROR',
			status: 400,
		});
	});

	it('keeps usage rows readable for the current cycle', async () => {
		const subscriberId = await seedSubscriber();
		const usage = await env.DB.prepare('SELECT usage_cycle_start FROM subscribers WHERE id = ?')
			.bind(subscriberId)
			.first<{ usage_cycle_start: number }>();
		await seedSubscriberUsage(subscriberId, usage?.usage_cycle_start ?? 0, 7, 11);
		const row = await env.DB.prepare('SELECT uplink_bytes, downlink_bytes FROM subscriber_usage WHERE subscriber_id = ?')
			.bind(subscriberId)
			.first<{ uplink_bytes: number; downlink_bytes: number }>();
		expect(row).toEqual({ uplink_bytes: 7, downlink_bytes: 11 });
	});
});
