import type { SubscriberBlockReason, SubscriberStatus } from '@zako/contracts';

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

export interface Entitlement {
	status: SubscriberStatus;
	blocked_reason: SubscriberBlockReason | null;
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

const BLOCK_REASON_BY_STATUS: Record<SubscriberStatus, SubscriberBlockReason | null> = {
	active: null,
	limited: 'over_quota',
	expired: 'expired',
	disabled: 'inactive',
};

/**
 * Single decision point for subscriber entitlement. The materialised status
 * (cron and management writes) and the subscription gate (serving and preview)
 * both project this result, so the two cannot disagree on priority.
 *
 * `disabled` is sticky because the column also carries an administrator's
 * explicit suspension; the other values are re-derived on every write.
 */
export function evaluateEntitlement(input: EntitlementInput, now: number): Entitlement {
	let status: SubscriberStatus;
	if (input.status === 'disabled') {
		status = 'disabled';
	} else if (input.expires_at !== null && input.expires_at <= now) {
		status = 'expired';
	} else if (input.traffic_limit_bytes !== null && cycleUsage(input.usage, input.usage_cycle_start).total >= input.traffic_limit_bytes) {
		status = 'limited';
	} else {
		status = 'active';
	}
	return { status, blocked_reason: BLOCK_REASON_BY_STATUS[status] };
}

export function deriveSubscriberStatus(input: EntitlementInput, now: number): SubscriberStatus {
	return evaluateEntitlement(input, now).status;
}

/** Non-null means a subscription request must be refused with 403. */
export function subscriberBlockReason(input: EntitlementInput, now: number): SubscriberBlockReason | null {
	return evaluateEntitlement(input, now).blocked_reason;
}
