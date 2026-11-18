import type { AgentReport } from '@zako/contracts';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { nowSeconds, seedEndpoint, seedMeta, seedNode } from './helpers';

const SECRET = 'u'.repeat(43);

function testRequest(path: string, init?: RequestInit): Promise<Response> {
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

function makeHeartbeat(): AgentReport {
	return {
		sent_at: nowSeconds(),
		agent_version: '0.1.0',
		xray_version: '25.10.1',
		xray_healthy: true,
		stats_healthy: true,
		applied_config_version: 0,
		users_ver: 0,
	};
}

describe('node deletion and uninstall', () => {
	it('deletes a never-seen node immediately on admin DELETE', async () => {
		const nodeId = await seedNode({ name: 'unseen-node', lastSeenAt: null, secret: SECRET });
		await seedEndpoint(nodeId, { name: 'primary' });

		const res = await testRequest(`/api/v1/admin/nodes/${nodeId}`, {
			method: 'DELETE',
		});
		expect(res.status).toBe(204);

		const row = await env.DB.prepare('SELECT id FROM nodes WHERE id = ?').bind(nodeId).first();
		expect(row).toBeNull();
	});

	it('marks an online node uninstalling, emits uninstall directive, blocks users/config, and deletes on ack', async () => {
		await seedMeta('users_ver', '1');
		const nodeId = await seedNode({ name: 'online-uninstall', lastSeenAt: nowSeconds(), secret: SECRET });
		const auth = `Bearer ${nodeId}.${SECRET}`;

		const delRes = await testRequest(`/api/v1/admin/nodes/${nodeId}?remove_xray=true`, {
			method: 'DELETE',
		});
		expect(delRes.status).toBe(202);
		const delBody = (await delRes.json()) as { data: { status: string; uninstall_remove_xray: boolean; enabled: boolean } };
		expect(delBody.data.status).toBe('uninstalling');
		expect(delBody.data.uninstall_remove_xray).toBe(true);
		expect(delBody.data.enabled).toBe(false);

		const usersRes = await testRequest('/api/v1/agent/users', {
			headers: { Authorization: auth },
		});
		expect(usersRes.status).toBe(409);

		const reportRes = await testRequest('/api/v1/agent/report', {
			method: 'POST',
			headers: { Authorization: auth, 'Content-Type': 'application/json' },
			body: JSON.stringify(makeHeartbeat()),
		});
		expect(reportRes.status).toBe(200);
		const reportBody = (await reportRes.json()) as {
			data: { directives: Array<{ type: string; payload?: { remove_xray?: boolean } }> };
		};
		expect(reportBody.data.directives).toEqual([{ type: 'uninstall', payload: { remove_xray: true } }]);

		const ackRes = await testRequest('/api/v1/agent/uninstall', {
			method: 'POST',
			headers: { Authorization: auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ reason: 'panel_directive' }),
		});
		expect(ackRes.status).toBe(204);

		const row = await env.DB.prepare('SELECT id FROM nodes WHERE id = ?').bind(nodeId).first();
		expect(row).toBeNull();

		const audit = await env.DB.prepare('SELECT action FROM audit_events WHERE target_id = ? ORDER BY created_at DESC LIMIT 1')
			.bind(nodeId)
			.first<{ action: string }>();
		expect(audit?.action).toBe('node.uninstall_ack');
	});

	it('force-deletes an uninstalling node immediately when force=true', async () => {
		const nodeId = await seedNode({ name: 'force-delete', lastSeenAt: nowSeconds(), secret: SECRET });

		const reqRes = await testRequest(`/api/v1/admin/nodes/${nodeId}`, { method: 'DELETE' });
		expect(reqRes.status).toBe(202);

		const forceRes = await testRequest(`/api/v1/admin/nodes/${nodeId}?force=true`, { method: 'DELETE' });
		expect(forceRes.status).toBe(204);

		const row = await env.DB.prepare('SELECT id FROM nodes WHERE id = ?').bind(nodeId).first();
		expect(row).toBeNull();
	});

	it('allows node-side self-uninstall via POST /api/v1/agent/uninstall', async () => {
		const nodeId = await seedNode({ name: 'self-uninstall', lastSeenAt: nowSeconds(), secret: SECRET });
		const auth = `Bearer ${nodeId}.${SECRET}`;

		const res = await testRequest('/api/v1/agent/uninstall', {
			method: 'POST',
			headers: { Authorization: auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ reason: 'node_cli' }),
		});
		expect(res.status).toBe(204);

		const row = await env.DB.prepare('SELECT id FROM nodes WHERE id = ?').bind(nodeId).first();
		expect(row).toBeNull();

		const audit = await env.DB.prepare('SELECT action FROM audit_events WHERE target_id = ? ORDER BY created_at DESC LIMIT 1')
			.bind(nodeId)
			.first<{ action: string }>();
		expect(audit?.action).toBe('node.self_uninstall');
	});
});
