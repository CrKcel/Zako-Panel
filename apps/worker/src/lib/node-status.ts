import type { NodeStatus } from '@zako/contracts';

export const HEARTBEAT_STALE_MULTIPLIER = 3;

export interface NodeHealthInput {
	enabled: boolean;
	last_seen_at: number | null;
	heartbeat_interval_seconds: number;
	xray_healthy: boolean | null;
	stats_healthy: boolean | null;
}

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export function hourBucket(timestamp: number): number {
	return Math.floor(timestamp / 3600) * 3600;
}

export function isHeartbeatFresh(lastSeenAt: number | null, intervalSeconds: number, now: number): boolean {
	return lastSeenAt !== null && now <= lastSeenAt + HEARTBEAT_STALE_MULTIPLIER * intervalSeconds;
}

/**
 * Node status is derived on read; no `online` column is persisted, so a stale
 * heartbeat becomes offline without a per-node cron.
 */
export function deriveNodeStatus(node: NodeHealthInput, now: number = nowSeconds()): NodeStatus {
	if (!node.enabled) return 'disabled';
	if (!isHeartbeatFresh(node.last_seen_at, node.heartbeat_interval_seconds, now)) return 'offline';
	if (node.xray_healthy === false || node.stats_healthy === false) return 'degraded';
	return 'online';
}
