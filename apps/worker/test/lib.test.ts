import type { AgentTraffic } from '@zako/contracts';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/lib/canonical-json';
import { AppError } from '../src/lib/errors';
import { deriveNodeStatus, isHeartbeatFresh } from '../src/lib/node-status';
import { parseAgentToken } from '../src/lib/token';
import { assertReportWindow, assertUniqueXrayEmails, trafficPayloadHash } from '../src/lib/traffic';

const BASE_NODE = {
	enabled: true,
	last_seen_at: 1_000,
	heartbeat_interval_seconds: 300,
	xray_healthy: true,
	stats_healthy: true,
};

describe('node status derivation', () => {
	it('treats exactly three heartbeat intervals as fresh and one second later as offline', () => {
		expect(isHeartbeatFresh(1_000, 300, 1_900)).toBe(true);
		expect(isHeartbeatFresh(1_000, 300, 1_901)).toBe(false);
		expect(deriveNodeStatus(BASE_NODE, 1_900)).toBe('online');
		expect(deriveNodeStatus(BASE_NODE, 1_901)).toBe('offline');
	});

	it('derives disabled before stale heartbeat and degraded while fresh', () => {
		expect(deriveNodeStatus({ ...BASE_NODE, enabled: false }, 10_000)).toBe('disabled');
		expect(deriveNodeStatus({ ...BASE_NODE, xray_healthy: false }, 1_100)).toBe('degraded');
		expect(deriveNodeStatus({ ...BASE_NODE, stats_healthy: false }, 1_100)).toBe('degraded');
	});
});

describe('agent token parsing', () => {
	it('accepts the node id and secret form only', () => {
		const nodeId = '01J2Z6Q8Y3V9M4K7T1B5C0D2E6';
		const secret = 'a'.repeat(43);
		expect(parseAgentToken(`${nodeId}.${secret}`)).toEqual({ nodeId, secret });
		expect(parseAgentToken(`${nodeId}.${secret}.extra`)).toBeNull();
		expect(parseAgentToken(`not-an-id.${secret}`)).toBeNull();
		expect(parseAgentToken(`${nodeId}.short`)).toBeNull();
	});
});

describe('canonical traffic payloads', () => {
	it('sorts nested keys so key order does not change the hash', async () => {
		const base: Omit<AgentTraffic, 'node' | 'report_id'> = {
			period_start: 1_699_999_200,
			period_end: 1_699_999_500,
			has_counter_gap: false,
			users: [],
		};
		const first: AgentTraffic = {
			...base,
			report_id: '01J2Z6Q8Y3V9M4K7T1B5C0D2E6',
			node: { downlink_bytes: 2, uplink_bytes: 1 },
		};
		const second: AgentTraffic = {
			...base,
			node: { uplink_bytes: 1, downlink_bytes: 2 },
			report_id: '01J2Z6Q8Y3V9M4K7T1B5C0D2E6',
		};
		expect(canonicalJson(first)).toBe(canonicalJson(second));
		expect(await trafficPayloadHash(first)).toBe(await trafficPayloadHash(second));
	});

	it('rejects reports crossing an hour boundary', () => {
		const hourStart = 1_699_999_200;
		const now = hourStart + 7_200;
		expect(() => assertReportWindow(hourStart, hourStart + 900, now)).not.toThrow();
		expect(() => assertReportWindow(hourStart + 3_000, hourStart + 4_000, now)).toThrow(AppError);
	});

	it('rejects duplicate emails in one report', () => {
		expect(() =>
			assertUniqueXrayEmails([
				{ xray_email: 'u_1', uplink_bytes: 1, downlink_bytes: 1 },
				{ xray_email: 'u_1', uplink_bytes: 2, downlink_bytes: 2 },
			]),
		).toThrow(AppError);
	});
});
