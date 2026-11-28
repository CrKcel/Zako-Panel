import type { CreateSubscriberRequest, Subscriber, UpdateSubscriberRequest } from '@zako/contracts';
import { initialUsageCycle } from '../lib/cycle';
import { isUniqueConstraintError } from '../lib/db-errors';
import { AppError } from '../lib/errors';
import { newId, newXrayEmail } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import { deriveSubscriberStatus } from '../lib/subscriber-status';

import {
	findSubscriberById,
	findUsageBySubscribers,
	insertSubscriberStatement,
	listSubscriberRows,
	updateSubscriberStatement,
	usageStatement,
	type SubscriberRow,
	type SubscriberUpdateInput,
	type SubscriberUsageRow,
} from '../repositories/subscribers';
import type { ListQuery, Paginated } from '../types';
import { bumpUsersVersionStatement } from './users-version';

function subscriberNotFound(): AppError {
	return new AppError('NOT_FOUND', 'Subscriber not found', 404);
}

function emailConflict(): AppError {
	return new AppError('CONFLICT', 'Subscriber email already exists', 409);
}

/** Emails are compared case-insensitively, matching the unique index. */
function normalizeEmail(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	const trimmed = value.trim().toLowerCase();
	return trimmed === '' ? null : trimmed;
}

function toUsage(row: SubscriberUsageRow | null, cycleStart: number): Subscriber['usage'] {
	if (!row || row.cycle_start < cycleStart) return { cycle_start: cycleStart, uplink_bytes: 0, downlink_bytes: 0 };
	return { cycle_start: row.cycle_start, uplink_bytes: row.uplink_bytes, downlink_bytes: row.downlink_bytes };
}

function toSubscriber(row: SubscriberRow, usage: SubscriberUsageRow | null): Subscriber {
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		status: row.status,
		traffic_limit_bytes: row.traffic_limit_bytes,
		expires_at: row.expires_at,
		usage_cycle_start: row.usage_cycle_start,
		usage_cycle_end: row.usage_cycle_end,
		usage: toUsage(usage, row.usage_cycle_start),
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export async function listSubscribers(db: D1Database, query: ListQuery): Promise<Paginated<Subscriber>> {
	const rows = await listSubscriberRows(db, query.limit + 1, query.cursor);
	const hasMore = rows.length > query.limit;
	const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
	const usageRows = await findUsageBySubscribers(
		db,
		pageRows.map((row) => row.id),
	);
	const usageById = new Map(usageRows.map((row) => [row.subscriber_id, row]));
	const items = pageRows.map((row) => toSubscriber(row, usageById.get(row.id) ?? null));
	const last = items[items.length - 1];
	return { items, next_cursor: hasMore && last ? last.id : null };
}

export async function createSubscriber(db: D1Database, input: CreateSubscriberRequest): Promise<Subscriber> {
	const now = nowSeconds();
	const subscriberId = newId();
	const cycle = initialUsageCycle(now);
	const expiresAt = input.expires_at ?? null;
	const trafficLimit = input.traffic_limit_bytes ?? null;
	// A subscriber created with a past expiry or a zero quota is stored in the
	// state the next cron run would derive anyway.
	const status = deriveSubscriberStatus(
		{ status: 'active', expires_at: expiresAt, traffic_limit_bytes: trafficLimit, usage_cycle_start: cycle.start, usage: null },
		now,
	);

	const statements = [
		insertSubscriberStatement(db, {
			id: subscriberId,
			name: input.name,
			email: normalizeEmail(input.email),
			status,
			xray_email: newXrayEmail(),
			vless_uuid: crypto.randomUUID(),
			traffic_limit_bytes: trafficLimit,
			expires_at: expiresAt,
			usage_cycle_start: cycle.start,
			usage_cycle_end: cycle.end,
			now,
		}),
	];
	if (status === 'active') statements.push(bumpUsersVersionStatement(db));

	try {
		await db.batch(statements);
	} catch (error) {
		if (isUniqueConstraintError(error)) throw emailConflict();
		throw error;
	}

	const row = await findSubscriberById(db, subscriberId);
	if (!row) throw new AppError('INTERNAL_ERROR', 'Subscriber was not persisted', 500);
	return toSubscriber(row, null);
}

export async function getSubscriber(db: D1Database, subscriberId: string): Promise<Subscriber> {
	const row = await findSubscriberById(db, subscriberId);
	if (!row) throw subscriberNotFound();

	const usageResult = await usageStatement(db, subscriberId).all<SubscriberUsageRow>();
	const usage = usageResult.results[0] ?? null;
	return toSubscriber(row, usage);
}

/**
 * Writes the materialised status on every update. The cron re-derives it, so an
 * administrator cannot leave an expired or over-quota subscriber active; a
 * `disabled` status remains an explicit suspension.
 */
export async function updateSubscriber(db: D1Database, subscriberId: string, input: UpdateSubscriberRequest): Promise<Subscriber> {
	const existing = await findSubscriberById(db, subscriberId);
	if (!existing) throw subscriberNotFound();

	const now = nowSeconds();
	const [usage] = await findUsageBySubscribers(db, [subscriberId]);
	const status = deriveSubscriberStatus(
		{
			status: input.status ?? existing.status,
			expires_at: input.expires_at === undefined ? existing.expires_at : input.expires_at,
			traffic_limit_bytes: input.traffic_limit_bytes === undefined ? existing.traffic_limit_bytes : input.traffic_limit_bytes,
			usage_cycle_start: existing.usage_cycle_start,
			usage: usage ?? null,
		},
		now,
	);

	const update: SubscriberUpdateInput = { status };
	if (status === 'disabled' && existing.status !== 'disabled') {
		update.disabled_at = now;
	} else if (status !== 'disabled' && existing.status === 'disabled') {
		update.disabled_at = null;
	}
	if (input.name !== undefined) update.name = input.name;
	if (input.email !== undefined) update.email = normalizeEmail(input.email);
	if (input.traffic_limit_bytes !== undefined) update.traffic_limit_bytes = input.traffic_limit_bytes;
	if (input.expires_at !== undefined) update.expires_at = input.expires_at;

	const statements = [updateSubscriberStatement(db, subscriberId, update, now)];
	if (status !== existing.status) statements.push(bumpUsersVersionStatement(db));

	try {
		await db.batch(statements);
	} catch (error) {
		if (isUniqueConstraintError(error)) throw emailConflict();
		throw error;
	}

	const updated = await findSubscriberById(db, subscriberId);
	if (!updated) throw subscriberNotFound();
	return toSubscriber(updated, usage ?? null);
}
