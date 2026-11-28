import type { AgentReport } from '@zako/contracts';
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getSubscriberCredential, hourStart, nowSeconds, seedMeta, seedNode, seedSubscriber } from './helpers';

const SECRET = 's'.repeat(43);

function makeReport(overrides: { reportId?: string; uplink?: number; emails?: string[] } = {}): AgentReport {
	const now = nowSeconds();
	const start = hourStart(now);
	const end = now === start ? start + 1 : now;
	return {
		sent_at: now,
		agent_version: '0.1.0',
		xray_version: '25.10.1',
		xray_healthy: true,
		stats_healthy: true,
		applied_config_version: 0,
		users_ver: 0,
		sys: { cpu: 0.12, mem: 0.41, load: 0.3, uptime: 86_400 },
		traffic: {
			report_id: overrides.reportId ?? '01J2Z6Q8Y3V9M4K7T1B5C0D2E6',
			period_start: start,
			period_end: end,
			has_counter_gap: false,
			node: { uplink_bytes: overrides.uplink ?? 1_024, downlink_bytes: 2_048 },
			users: (overrides.emails ?? []).map((email) => ({
				xray_email: email,
				uplink_bytes: 100,
				downlink_bytes: 200,
			})),
		},
	};
}

async function postReport(token: string, report: AgentReport): Promise<Response> {
	return SELF.fetch('https://panel.test/api/v1/agent/report', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(report),
	});
}

async function seedAgentNode(options: { desiredConfigVersion?: number } = {}): Promise<{ nodeId: string; token: string }> {
	const nodeId = await seedNode({ name: 'agent-node', secret: SECRET, ...options });
	return { nodeId, token: `${nodeId}.${SECRET}` };
}

describe('agent report ingestion', () => {
	it('commits heartbeat and traffic buckets for a new report', async () => {
		const { nodeId, token } = await seedAgentNode();
		const subscriberId = await seedSubscriber();
		const client = await getSubscriberCredential(subscriberId);
		await seedMeta('users_ver', '7');

		const response = await postReport(token, makeReport({ emails: [client.xrayEmail] }));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: Record<string, unknown> };
		expect(body.data.ack_report_id).toBe('01J2Z6Q8Y3V9M4K7T1B5C0D2E6');
		expect(body.data.unknown_users).toBe(0);
		expect(body.data.users_ver).toBe(7);
		expect(body.data.heartbeat_interval_seconds).toBe(300);
		expect(body.data.traffic_interval_seconds).toBe(900);
		expect(body.data.directives).toEqual([]);

		const bucket = hourStart(nowSeconds());
		const nodeRow = await env.DB.prepare(
			'SELECT uplink_bytes, downlink_bytes FROM node_traffic_hourly WHERE node_id = ? AND bucket_start = ?',
		)
			.bind(nodeId, bucket)
			.first<{ uplink_bytes: number; downlink_bytes: number }>();
		expect(nodeRow).toEqual({ uplink_bytes: 1_024, downlink_bytes: 2_048 });
		const siteRow = await env.DB.prepare('SELECT uplink_bytes FROM site_traffic_hourly WHERE bucket_start = ?')
			.bind(bucket)
			.first<{ uplink_bytes: number }>();
		expect(siteRow?.uplink_bytes).toBe(1_024);
		const userRow = await env.DB.prepare(
			'SELECT uplink_bytes, downlink_bytes FROM user_traffic_hourly WHERE subscriber_id = ? AND node_id = ? AND bucket_start = ?',
		)
			.bind(subscriberId, nodeId, bucket)
			.first<{ uplink_bytes: number; downlink_bytes: number }>();
		expect(userRow).toEqual({ uplink_bytes: 100, downlink_bytes: 200 });
		const usage = await env.DB.prepare('SELECT cycle_start, uplink_bytes, downlink_bytes FROM subscriber_usage WHERE subscriber_id = ?')
			.bind(subscriberId)
			.first<{ cycle_start: number; uplink_bytes: number; downlink_bytes: number }>();
		expect(usage).toEqual({ cycle_start: expect.any(Number), uplink_bytes: 100, downlink_bytes: 200 });

		const heartbeat = await env.DB.prepare('SELECT last_seen_at, sys_json FROM nodes WHERE id = ?')
			.bind(nodeId)
			.first<{ last_seen_at: number; sys_json: string }>();
		expect(heartbeat?.last_seen_at).toBeGreaterThan(0);
		expect(JSON.parse(heartbeat?.sys_json ?? '{}')).toMatchObject({ cpu: 0.12, uptime: 86_400 });
	});

	it('treats the same report id and payload as an idempotent ACK', async () => {
		const { nodeId, token } = await seedAgentNode();
		const report = makeReport();
		expect((await postReport(token, report)).status).toBe(200);
		const second = await postReport(token, report);
		expect(second.status).toBe(200);
		const body = (await second.json()) as { data: { ack_report_id: string } };
		expect(body.data.ack_report_id).toBe(report.traffic?.report_id);

		const rows = await env.DB.prepare('SELECT item_count FROM traffic_reports WHERE node_id = ?').bind(nodeId).all();
		expect(rows.results).toHaveLength(1);
		const bucket = await env.DB.prepare('SELECT uplink_bytes FROM node_traffic_hourly WHERE node_id = ? AND bucket_start = ?')
			.bind(nodeId, hourStart(nowSeconds()))
			.first<{ uplink_bytes: number }>();
		expect(bucket?.uplink_bytes).toBe(1_024);
	});

	it('returns 409 for a reused report id with a different payload while keeping the heartbeat', async () => {
		const { nodeId, token } = await seedAgentNode();
		const report = makeReport();
		expect((await postReport(token, report)).status).toBe(200);
		await env.DB.prepare('UPDATE nodes SET last_seen_at = 1 WHERE id = ?').bind(nodeId).run();

		const conflicting = makeReport({ uplink: 9_999 });
		const response = await postReport(token, conflicting);
		expect(response.status).toBe(409);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe('REPORT_CONFLICT');

		const heartbeat = await env.DB.prepare('SELECT last_seen_at FROM nodes WHERE id = ?').bind(nodeId).first<{ last_seen_at: number }>();
		expect(heartbeat?.last_seen_at).toBeGreaterThan(1);
		const bucket = await env.DB.prepare('SELECT uplink_bytes FROM node_traffic_hourly WHERE node_id = ? AND bucket_start = ?')
			.bind(nodeId, hourStart(nowSeconds()))
			.first<{ uplink_bytes: number }>();
		expect(bucket?.uplink_bytes).toBe(1_024);
	});

	it('rejects a report that crosses an hour boundary with 422', async () => {
		const { token } = await seedAgentNode();
		const now = nowSeconds();
		const report = makeReport();
		if (report.traffic) {
			report.traffic.period_start = hourStart(now) - 1;
			report.traffic.period_end = hourStart(now) + 1;
		}
		const response = await postReport(token, report);
		expect(response.status).toBe(422);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe('UNPROCESSABLE_ENTITY');
	});

	it('counts unknown emails without writing user buckets', async () => {
		const { nodeId, token } = await seedAgentNode();
		const report = makeReport({ emails: ['u_unknown'] });
		const response = await postReport(token, report);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { unknown_users: number } };
		expect(body.data.unknown_users).toBe(1);

		const userRows = await env.DB.prepare('SELECT subscriber_id FROM user_traffic_hourly WHERE node_id = ?').bind(nodeId).all();
		expect(userRows.results).toHaveLength(0);
		const bucket = await env.DB.prepare('SELECT uplink_bytes FROM node_traffic_hourly WHERE node_id = ?')
			.bind(nodeId)
			.first<{ uplink_bytes: number }>();
		expect(bucket?.uplink_bytes).toBe(1_024);
	});

	it('never stores an applied config version above the desired version', async () => {
		const { nodeId, token } = await seedAgentNode({ desiredConfigVersion: 2 });
		const report = makeReport();
		report.applied_config_version = 9;
		expect((await postReport(token, report)).status).toBe(200);
		const row = await env.DB.prepare('SELECT applied_config_version FROM nodes WHERE id = ?')
			.bind(nodeId)
			.first<{ applied_config_version: number }>();
		expect(row?.applied_config_version).toBe(2);
	});

	it('handles a heartbeat-only report with a null ack', async () => {
		const { token } = await seedAgentNode();
		const report = makeReport();
		delete report.traffic;
		const response = await postReport(token, report);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { ack_report_id: null } };
		expect(body.data.ack_report_id).toBeNull();
	});
});
