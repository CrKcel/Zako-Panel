import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { nowSeconds, seedNode } from './helpers';
import { runScheduledJob } from '../src/services/cron-service';

const DAY = 86_400;

async function insertOldAndNewRows(nodeId: string): Promise<void> {
	const now = nowSeconds();
	const oldHour = now - 91 * DAY;
	const newHour = now - 1 * DAY;
	const statements = [
		env.DB.prepare(
			'INSERT INTO node_traffic_hourly (node_id, bucket_start, uplink_bytes, downlink_bytes, updated_at) VALUES (?, ?, 1, 1, ?)',
		).bind(nodeId, oldHour, now),
		env.DB.prepare(
			'INSERT INTO node_traffic_hourly (node_id, bucket_start, uplink_bytes, downlink_bytes, updated_at) VALUES (?, ?, 1, 1, ?)',
		).bind(nodeId, newHour, now),
		env.DB.prepare('INSERT INTO site_traffic_hourly (bucket_start, uplink_bytes, downlink_bytes, updated_at) VALUES (?, 1, 1, ?)').bind(
			oldHour,
			now,
		),
		env.DB.prepare('INSERT INTO site_traffic_hourly (bucket_start, uplink_bytes, downlink_bytes, updated_at) VALUES (?, 1, 1, ?)').bind(
			newHour,
			now,
		),
		env.DB.prepare(
			'INSERT INTO traffic_reports (node_id, report_id, payload_hash, period_start, period_end, item_count, has_counter_gap, received_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)',
		).bind(nodeId, 'old-report', 'hash', oldHour, oldHour + 900, now - 31 * DAY),
		env.DB.prepare(
			'INSERT INTO traffic_reports (node_id, report_id, payload_hash, period_start, period_end, item_count, has_counter_gap, received_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)',
		).bind(nodeId, 'new-report', 'hash', newHour, newHour + 900, now - 1 * DAY),
		env.DB.prepare(
			"INSERT INTO audit_events (id, actor_email, action, target_type, target_id, detail_json, created_at) VALUES ('old-audit', NULL, 'old', NULL, NULL, NULL, ?)",
		).bind(now - 181 * DAY),
		env.DB.prepare(
			"INSERT INTO audit_events (id, actor_email, action, target_type, target_id, detail_json, created_at) VALUES ('new-audit', NULL, 'new', NULL, NULL, NULL, ?)",
		).bind(now - 1 * DAY),
	];
	await env.DB.batch(statements);
}

describe('scheduled jobs', () => {
	it('deletes expired hourly buckets, reports and audit events in bounded batches', async () => {
		const nodeId = await seedNode({ name: 'cron-node' });
		await insertOldAndNewRows(nodeId);

		await runScheduledJob(env, '17 3 * * *', nowSeconds());

		const nodeHours = await env.DB.prepare('SELECT bucket_start FROM node_traffic_hourly').all<{ bucket_start: number }>();
		expect(nodeHours.results).toHaveLength(1);
		expect(nodeHours.results[0]?.bucket_start).toBeGreaterThan(nowSeconds() - 2 * DAY);
		const siteHours = await env.DB.prepare('SELECT bucket_start FROM site_traffic_hourly').all<{ bucket_start: number }>();
		expect(siteHours.results).toHaveLength(1);
		const reports = await env.DB.prepare('SELECT report_id FROM traffic_reports').all<{ report_id: string }>();
		expect(reports.results).toEqual([{ report_id: 'new-report' }]);
		const audits = await env.DB.prepare('SELECT id FROM audit_events').all<{ id: string }>();
		expect(audits.results).toEqual([{ id: 'new-audit' }]);
	});

	it('leaves retention data untouched on the quarter-hour trigger', async () => {
		const nodeId = await seedNode({ name: 'cron-node-2' });
		await insertOldAndNewRows(nodeId);
		await runScheduledJob(env, '*/15 * * * *', nowSeconds());
		const reports = await env.DB.prepare('SELECT COUNT(*) AS count FROM traffic_reports').first<{ count: number }>();
		expect(reports?.count).toBe(2);
	});
});
