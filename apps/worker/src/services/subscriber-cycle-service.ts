import { advanceUsageCycle, initialUsageCycle } from '../lib/cycle';
import { deriveSubscriberStatus, type UsageSnapshot } from '../lib/subscriber-status';

import {
	findUsageBySubscribers,
	resetUsageStatement,
	subscribersNeedingReconcileStatement,
	updateSubscriberCycleStatement,
	updateSubscriberStatusStatement,
	type SubscriberRow,
	type SubscriberUsageRow,
} from '../repositories/subscribers';
import { bumpUsersVersionStatement } from './users-version';

const MAX_SUBSCRIBERS_PER_RUN = 500;
/** A dormant row may be years behind; the loop stays bounded per row. */
const MAX_CYCLE_ADVANCES = 240;
const STATEMENTS_PER_BATCH = 20;

export interface CycleReconcileResult {
	advanced: number;
	status_changed: number;
}

function usageSnapshot(row: SubscriberUsageRow | null, cycleStart: number): UsageSnapshot | null {
	if (!row || row.cycle_start < cycleStart) return null;
	return { cycle_start: row.cycle_start, uplink_bytes: row.uplink_bytes, downlink_bytes: row.downlink_bytes };
}

/**
 * Quarter-hourly reconciliation of usage cycles and the materialised subscriber
 * status. Only rows whose stored state can no longer be right are read, so a run
 * costs one bounded query when nothing changed.
 *
 * Advancing a cycle resets usage; the status is then re-derived from the new cycle
 * so a subscriber becomes active again without another write path. The global users
 * version advances once per run when any status changed, which makes an agent fetch
 * the new node user set.
 */
export async function reconcileSubscriberCycles(db: D1Database, now: number): Promise<CycleReconcileResult> {
	const candidates = await subscribersNeedingReconcileStatement(db, now, MAX_SUBSCRIBERS_PER_RUN).all<SubscriberRow>();
	if (candidates.results.length === 0) return { advanced: 0, status_changed: 0 };

	const usageRows = await findUsageBySubscribers(
		db,
		candidates.results.map((row) => row.id),
	);
	const usageById = new Map(usageRows.map((row) => [row.subscriber_id, row]));

	const statements: D1PreparedStatement[] = [];
	let advanced = 0;
	let statusChanged = 0;

	for (const row of candidates.results) {
		let cycle = { start: row.usage_cycle_start, end: row.usage_cycle_end };
		let usage = usageById.get(row.id) ?? null;
		let advancedNow = false;
		for (let step = 0; cycle.end <= now && step < MAX_CYCLE_ADVANCES; step += 1) {
			cycle = advanceUsageCycle(cycle);
			advancedNow = true;
		}
		if (cycle.end <= now) {
			// A row far behind the cap starts a fresh cycle instead of looping forever.
			cycle = initialUsageCycle(now);
			advancedNow = true;
		}
		if (advancedNow) {
			usage = null;
			advanced += 1;
			statements.push(resetUsageStatement(db, row.id, cycle.start, now));
		}

		const status = deriveSubscriberStatus(
			{
				status: row.status,
				expires_at: row.expires_at,
				traffic_limit_bytes: row.traffic_limit_bytes,
				usage_cycle_start: cycle.start,
				usage: usageSnapshot(usage, cycle.start),
			},
			now,
		);

		if (advancedNow) {
			statements.push(updateSubscriberCycleStatement(db, row.id, cycle, status, now));
		} else if (status !== row.status) {
			statements.push(updateSubscriberStatusStatement(db, row.id, status, now));
		}
		if (status !== row.status) statusChanged += 1;
	}

	if (statusChanged > 0) statements.push(bumpUsersVersionStatement(db));

	for (let index = 0; index < statements.length; index += STATEMENTS_PER_BATCH) {
		await db.batch(statements.slice(index, index + STATEMENTS_PER_BATCH));
	}

	return { advanced, status_changed: statusChanged };
}
