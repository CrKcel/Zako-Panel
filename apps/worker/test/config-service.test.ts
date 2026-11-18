import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/lib/canonical-json';
import { sha256Hex } from '../src/lib/hash';
import {
	getConfig,
	getDesiredConfig,
	listConfigs,
	publishConfig,
	recordConfigResult,
	rollbackConfig,
} from '../src/services/config-service';
import { nowSeconds, seedNode, testToken } from './helpers';

const SAMPLE_CONFIG = {
	log: { loglevel: 'warning' },
	api: { tag: 'api', services: ['StatsService', 'HandlerService'] },
	inbounds: [
		{
			tag: 'api',
			listen: '127.0.0.1',
			port: 10085,
			protocol: 'dokodemo-door',
			settings: { address: '127.0.0.1' },
		},
		{
			tag: 'vless-reality',
			listen: '0.0.0.0',
			port: 443,
			protocol: 'vless',
			settings: { clients: [], decryption: 'none' },
			streamSettings: {
				network: 'tcp',
				security: 'reality',
				realitySettings: {
					show: false,
					dest: 'www.microsoft.com:443',
					xver: 0,
					serverNames: ['www.microsoft.com'],
					shortIds: ['0123456789abcdef'],
					fingerprint: 'chrome',
				},
			},
		},
	],
};

describe('config service', () => {
	it('publishes immutable versions, advances desired_config_version and computes canonical sha256', async () => {
		const nodeId = await seedNode();

		const v1 = await publishConfig(env.DB, nodeId, { definition: SAMPLE_CONFIG }, { email: 'ops@example.com' });

		expect(v1.version).toBe(1);
		expect(v1.created_by).toBe('ops@example.com');
		expect(v1.applied_at).toBeNull();
		expect(v1.last_error).toBeNull();
		expect(v1.definition_sha256).toBe(await sha256Hex(canonicalJson(SAMPLE_CONFIG)));

		const node = await env.DB.prepare('SELECT desired_config_version, applied_config_version FROM nodes WHERE id = ?')
			.bind(nodeId)
			.first<{ desired_config_version: number; applied_config_version: number }>();
		expect(node?.desired_config_version).toBe(1);
		expect(node?.applied_config_version).toBe(0);

		const audit = await env.DB.prepare('SELECT actor_email, action, target_id FROM audit_events WHERE target_id = ?')
			.bind(nodeId)
			.first<{ actor_email: string; action: string; target_id: string }>();
		expect(audit?.actor_email).toBe('ops@example.com');
		expect(audit?.action).toBe('node.config.publish');
	});

	it('rejects definitions containing a REALITY privateKey or missing vless inbound', async () => {
		const nodeId = await seedNode();

		const withPrivateKey = structuredClone(SAMPLE_CONFIG);
		(withPrivateKey.inbounds[1]!.streamSettings!.realitySettings as Record<string, unknown>).privateKey = 'secret-key';

		await expect(publishConfig(env.DB, nodeId, { definition: withPrivateKey })).rejects.toMatchObject({
			status: 422,
			code: 'VALIDATION_ERROR',
		});

		await expect(publishConfig(env.DB, nodeId, { definition: { inbounds: [] } })).rejects.toMatchObject({
			status: 422,
			code: 'VALIDATION_ERROR',
		});
	});

	it('lists versions descending with cursor pagination and rolls back to a new version', async () => {
		const nodeId = await seedNode();
		const v1 = await publishConfig(env.DB, nodeId, { definition: SAMPLE_CONFIG });
		const modified = structuredClone(SAMPLE_CONFIG);
		modified.log.loglevel = 'info';
		const v2 = await publishConfig(env.DB, nodeId, { definition: modified });
		expect(v2.version).toBe(2);

		const v3 = await rollbackConfig(env.DB, nodeId, v1.version);
		expect(v3.version).toBe(3);
		expect(v3.definition_sha256).toBe(v1.definition_sha256);

		const page1 = await listConfigs(env.DB, nodeId, { limit: 2 });
		expect(page1.items.map((item) => item.version)).toEqual([3, 2]);
		expect(page1.next_cursor).toBe('2');

		const page2 = await listConfigs(env.DB, nodeId, { limit: 2, cursor: page1.next_cursor! });
		expect(page2.items.map((item) => item.version)).toEqual([1]);
		expect(page2.next_cursor).toBeNull();

		const fetched = await getConfig(env.DB, nodeId, 2);
		expect((fetched.definition.log as { loglevel: string }).loglevel).toBe('info');
	});

	it('serves desired config to agent, records applied/failed outcomes, and prevents stale failures from overwriting newer versions', async () => {
		const secret = testToken('agent-secret');
		const nodeId = await seedNode({ secret });
		await publishConfig(env.DB, nodeId, { definition: SAMPLE_CONFIG });

		const headers = { Authorization: `Bearer ${nodeId}.${secret}` };

		// Agent fetches v1
		const fetchRes = await SELF.fetch('https://panel.test/api/v1/agent/config', { headers });
		expect(fetchRes.status).toBe(200);
		const fetchBody = (await fetchRes.json()) as { data: { version: number; definition_sha256: string } };
		expect(fetchBody.data.version).toBe(1);

		// Agent reports failure on v1
		const now = nowSeconds();
		const failRes = await SELF.fetch('https://panel.test/api/v1/agent/config/result', {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				version: 1,
				status: 'failed',
				applied_at: now,
				error: { code: 'XRAY_TEST_FAILED', message: 'invalid port' },
			}),
		});
		expect(failRes.status).toBe(200);

		let nodeRow = await env.DB.prepare('SELECT desired_config_version, applied_config_version, last_config_error FROM nodes WHERE id = ?')
			.bind(nodeId)
			.first<{ desired_config_version: number; applied_config_version: number; last_config_error: string | null }>();
		expect(nodeRow?.applied_config_version).toBe(0);
		expect(nodeRow?.last_config_error).toContain('XRAY_TEST_FAILED');

		// Publish v2 (clears node.last_config_error)
		await publishConfig(env.DB, nodeId, { definition: SAMPLE_CONFIG });

		// Late failure for v1 must NOT overwrite node.last_config_error when desired is v2
		await recordConfigResult(env.DB, nodeId, {
			version: 1,
			status: 'failed',
			applied_at: now + 5,
			error: { code: 'STALE', message: 'late report' },
		});
		const staleNodeRow = await env.DB.prepare('SELECT desired_config_version, last_config_error FROM nodes WHERE id = ?')
			.bind(nodeId)
			.first<{ desired_config_version: number; last_config_error: string | null }>();
		expect(staleNodeRow?.desired_config_version).toBe(2);
		expect(staleNodeRow?.last_config_error).toBeNull();

		// Agent applies v2
		const applyRes = await SELF.fetch('https://panel.test/api/v1/agent/config/result', {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				version: 2,
				status: 'applied',
				applied_at: now + 10,
				error: null,
			}),
		});
		expect(applyRes.status).toBe(200);

		// Once applied == desired, GET /api/v1/agent/config returns 204
		const upToDateRes = await SELF.fetch('https://panel.test/api/v1/agent/config', { headers });
		expect(upToDateRes.status).toBe(204);
		expect(await getDesiredConfig(env.DB, nodeId)).toBeNull();
	});
});
