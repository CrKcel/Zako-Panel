import type { SubscriberStatus } from '@zako/contracts';

export interface UsageSnapshot {
	cycle_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
}

export interface EntitlementInput {
	status: SubscriberStatus;
	expires_at: number | null;
	traffic_limit_bytes: number | null;
	usage_cycle_start: number;
	usage: UsageSnapshot | null;
}

/**
 * Usage only counts for the current cycle. A row left over from a previous cycle
 * is treated as zero until the cron resets it.
 */
export function cycleUsage(usage: UsageSnapshot | null, usageCycleStart: number): { uplink: number; downlink: number; total: number } {
	if (!usage || usage.cycle_start < usageCycleStart) return { uplink: 0, downlink: 0, total: 0 };
	const uplink = usage.uplink_bytes;
	const downlink = usage.downlink_bytes;
	return { uplink, downlink, total: uplink + downlink };
}

/**
 * Materialised status follows the documented priority. `disabled` is sticky
 * because the column also carries an administrator's explicit suspension; the
 * other values are re-derived whenever the cron or a management write runs.
 */
export function deriveSubscriberStatus(input: EntitlementInput, now: number): SubscriberStatus {
	if (input.status === 'disabled') return 'disabled';
	if (input.expires_at !== null && input.expires_at <= now) return 'expired';
	const used = cycleUsage(input.usage, input.usage_cycle_start);
	if (input.traffic_limit_bytes !== null && used.total >= input.traffic_limit_bytes) return 'limited';
	return 'active';
}
