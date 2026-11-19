import type { AgentReport, AgentReportResponse, Node } from '@zako/contracts';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { nowSeconds, seedMeta, seedNode } from './helpers';

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

function makeHeartbeat(agentVersion: string): AgentReport {
	return {
		sent_at: nowSeconds(),
		agent_version: agentVersion,
		xray_version: '25.10.1',
		xray_healthy: true,
		stats_healthy: true,
		applied_config_version: 0,
		users_ver: 0,
	};
}

describe('node agent self-update', () => {
	it('emits self_update directive when desired_agent_version differs and clears on applied result', async () => {
		await seedMeta('users_ver', '1');
		const nodeId = await seedNode({ name: 'update-node', lastSeenAt: nowSeconds(), secret: SECRET });
		const auth = `Bearer ${nodeId}.${SECRET}`;

		const reqRes = await testRequest(`/api/v1/admin/nodes/${nodeId}/agent-update`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ target_version: 'v0.2.0' }),
		});
		expect(reqRes.status).toBe(202);
		const reqBody = (await reqRes.json()) as { data: Node };
		expect(reqBody.data.desired_agent_version).toBe('0.2.0');

		// Heartbeat with old version receives self_update directive.
		const hb1 = await testRequest('/api/v1/agent/report', {
			method: 'POST',
			headers: { authorization: auth, 'content-type': 'application/json' },
			body: JSON.stringify(makeHeartbeat('0.1.0')),
		});
		expect(hb1.status).toBe(200);
		const hb1Body = (await hb1.json()) as { data: AgentReportResponse };
		expect(hb1Body.data.directives).toEqual([{ type: 'self_update', payload: { target_version: '0.2.0' } }]);

		// Heartbeat already on target version does not receive self_update directive.
		const hb2 = await testRequest('/api/v1/agent/report', {
			method: 'POST',
			headers: { authorization: auth, 'content-type': 'application/json' },
			body: JSON.stringify(makeHeartbeat('0.2.0')),
		});
		expect(hb2.status).toBe(200);
		const hb2Body = (await hb2.json()) as { data: AgentReportResponse };
		expect(hb2Body.data.directives).toEqual([]);

		// Reporting applied result updates agent_version and clears desired_agent_version.
		const ackRes = await testRequest('/api/v1/agent/update/result', {
			method: 'POST',
			headers: { authorization: auth, 'content-type': 'application/json' },
			body: JSON.stringify({
				target_version: '0.2.0',
				status: 'applied',
				reported_at: nowSeconds(),
				error: null,
			}),
		});
		expect(ackRes.status).toBe(200);

		const getRes = await testRequest(`/api/v1/admin/nodes/${nodeId}`);
		const getBody = (await getRes.json()) as { data: { node: Node } };
		expect(getBody.data.node.agent_version).toBe('0.2.0');
		expect(getBody.data.node.desired_agent_version).toBeNull();
		expect(getBody.data.node.last_update_error).toBeNull();
	});

	it('records failure and clears desired_agent_version when agent reports update failed', async () => {
		await seedMeta('users_ver', '1');
		const nodeId = await seedNode({ name: 'update-fail-node', lastSeenAt: nowSeconds(), secret: SECRET });
		const auth = `Bearer ${nodeId}.${SECRET}`;

		const reqRes = await testRequest(`/api/v1/admin/nodes/${nodeId}/agent-update`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ target_version: '0.3.0' }),
		});
		expect(reqRes.status).toBe(202);

		const failRes = await testRequest('/api/v1/agent/update/result', {
			method: 'POST',
			headers: { authorization: auth, 'content-type': 'application/json' },
			body: JSON.stringify({
				target_version: '0.3.0',
				status: 'failed',
				reported_at: nowSeconds(),
				error: { code: 'HASH_MISMATCH', message: 'sha256 mismatch' },
			}),
		});
		expect(failRes.status).toBe(200);

		const getRes = await testRequest(`/api/v1/admin/nodes/${nodeId}`);
		const getBody = (await getRes.json()) as { data: { node: Node } };
		expect(getBody.data.node.desired_agent_version).toBeNull();
		expect(getBody.data.node.last_update_error).toBe('HASH_MISMATCH: sha256 mismatch');
		expect(getBody.data.node.last_update_at).not.toBeNull();
	});
});
