import type { CreateSubscriberRequest, Subscriber, SubscriberDetail, UpdateSubscriberRequest } from '@zako/contracts';
import { initialUsageCycle } from '../lib/cycle';
import { AppError } from '../lib/errors';
import { newId, newXrayEmail } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import { deriveSubscriberStatus } from '../lib/subscriber-status';
import { incrementMetaStatement, META_KEYS } from '../repositories/meta';
import { findNodesByIds } from '../repositories/nodes';
import {
	countNodeClientsBySubscribers,
	enabledNodeClientsStatement,
	findNodeClientsBySubscriber,
	findSubscriberById,
	findUsageBySubscribers,
	insertNodeClientStatement,
	insertSubscriberStatement,
	listSubscriberRows,
	setNodeClientEnabledStatement,
	updateSubscriberStatement,
	usageStatement,
	type SubscriberRow,
	type SubscriberUpdateInput,
	type SubscriberUsageRow,
} from '../repositories/subscribers';
import type { Paginated } from '../types';
import type { ListQuery } from './node-service';

function subscriberNotFound(): AppError {
	return new AppError('NOT_FOUND', 'Subscriber not found', 404);
}

function nodeNotFound(): AppError {
	return new AppError('NOT_FOUND', 'Node not found', 404);
}

function isUniqueConstraintError(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
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

function toSubscriber(row: SubscriberRow, usage: SubscriberUsageRow | null, nodeCount: number): Subscriber {
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		status: row.status,
		traffic_limit_bytes: row.traffic_limit_bytes,
		expires_at: row.expires_at,
		usage_cycle_start: row.usage_cycle_start,
		usage_cycle_end: row.usage_cycle_end,
		node_count: nodeCount,
		usage: toUsage(usage, row.usage_cycle_start),
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function toSubscriberDetail(row: SubscriberRow, usage: SubscriberUsageRow | null, nodeIds: string[]): SubscriberDetail {
	return { ...toSubscriber(row, usage, nodeIds.length), node_ids: nodeIds };
}

async function loadEnabledNodeIds(db: D1Database, subscriberId: string): Promise<string[]> {
	const rows = await db
		.prepare('SELECT node_id FROM node_clients WHERE subscriber_id = ? AND enabled = 1 ORDER BY node_id ASC')
		.bind(subscriberId)
		.all<{ node_id: string }>();
	return rows.results.map((row) => row.node_id);
}

export async function listSubscribers(db: D1Database, query: ListQuery): Promise<Paginated<Subscriber>> {
	const rows = await listSubscriberRows(db, query.limit + 1, query.cursor);
	const hasMore = rows.length > query.limit;
	const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
	const usageRows = await findUsageBySubscribers(
		db,
		pageRows.map((row) => row.id),
	);
	const countRows = await countNodeClientsBySubscribers(
		db,
		pageRows.map((row) => row.id),
	);
	const usageById = new Map(usageRows.map((row) => [row.subscriber_id, row]));
	const countById = new Map(countRows.map((row) => [row.subscriber_id, row.node_count]));
	const items = pageRows.map((row) => toSubscriber(row, usageById.get(row.id) ?? null, countById.get(row.id) ?? 0));
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

	try {
		await insertSubscriberStatement(db, {
			id: subscriberId,
			name: input.name,
			email: normalizeEmail(input.email),
			status,
			traffic_limit_bytes: trafficLimit,
			expires_at: expiresAt,
			usage_cycle_start: cycle.start,
			usage_cycle_end: cycle.end,
			now,
		}).run();
	} catch (error) {
		if (isUniqueConstraintError(error)) throw emailConflict();
		throw error;
	}

	const row = await findSubscriberById(db, subscriberId);
	if (!row) throw new AppError('INTERNAL_ERROR', 'Subscriber was not persisted', 500);
	return toSubscriber(row, null, 0);
}

export async function getSubscriber(db: D1Database, subscriberId: string): Promise<SubscriberDetail> {
	const row = await findSubscriberById(db, subscriberId);
	if (!row) throw subscriberNotFound();

	const [clientsResult, usageResult] = await db.batch([enabledNodeClientsStatement(db, subscriberId), usageStatement(db, subscriberId)]);
	const nodeIds = ((clientsResult?.results as { node_id: string }[] | undefined) ?? []).map((client) => client.node_id);
	const usage = (usageResult?.results as SubscriberUsageRow[] | undefined)?.[0] ?? null;
	return toSubscriberDetail(row, usage, nodeIds);
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
	if (input.name !== undefined) update.name = input.name;
	if (input.email !== undefined) update.email = normalizeEmail(input.email);
	if (input.traffic_limit_bytes !== undefined) update.traffic_limit_bytes = input.traffic_limit_bytes;
	if (input.expires_at !== undefined) update.expires_at = input.expires_at;

	const statements = [updateSubscriberStatement(db, subscriberId, update, now)];
	if (status !== existing.status) statements.push(incrementMetaStatement(db, META_KEYS.usersVersion));

	try {
		await db.batch(statements);
	} catch (error) {
		if (isUniqueConstraintError(error)) throw emailConflict();
		throw error;
	}

	const updated = await findSubscriberById(db, subscriberId);
	if (!updated) throw subscriberNotFound();
	const nodeIds = await loadEnabledNodeIds(db, subscriberId);
	return toSubscriber(updated, usage ?? null, nodeIds.length);
}

/**
 * Replaces the node grants of one subscriber. Existing credentials are kept for
 * nodes that stay granted, re-enabled for nodes that were revoked earlier, and
 * disabled (not deleted) for nodes that leave the set so historical traffic
 * attribution survives.
 */
export async function replaceSubscriberNodes(db: D1Database, subscriberId: string, nodeIds: string[]): Promise<SubscriberDetail> {
	const subscriber = await findSubscriberById(db, subscriberId);
	if (!subscriber) throw subscriberNotFound();

	const desired = [...new Set(nodeIds)];
	if (desired.length > 0) {
		const nodes = await findNodesByIds(db, desired);
		const found = new Set(nodes.map((node) => node.id));
		const missing = desired.find((nodeId) => !found.has(nodeId));
		if (missing) throw nodeNotFound();
	}

	const now = nowSeconds();
	const existing = await findNodeClientsBySubscriber(db, subscriberId);
	const existingByNode = new Map(existing.map((client) => [client.node_id, client]));
	const statements: D1PreparedStatement[] = [];

	for (const nodeId of desired) {
		const client = existingByNode.get(nodeId);
		if (!client) {
			statements.push(
				insertNodeClientStatement(db, {
					id: newId(),
					node_id: nodeId,
					subscriber_id: subscriberId,
					xray_email: newXrayEmail(),
					vless_uuid: crypto.randomUUID(),
					now,
				}),
			);
		} else if (client.enabled !== 1) {
			statements.push(setNodeClientEnabledStatement(db, client.id, true, now));
		}
	}

	const desiredSet = new Set(desired);
	for (const client of existing) {
		if (client.enabled === 1 && !desiredSet.has(client.node_id)) {
			statements.push(setNodeClientEnabledStatement(db, client.id, false, now));
		}
	}

	if (statements.length > 0) {
		statements.push(incrementMetaStatement(db, META_KEYS.usersVersion));
		await db.batch(statements);
	}

	const [usage] = await findUsageBySubscribers(db, [subscriberId]);
	const nodeIdsAfter = await loadEnabledNodeIds(db, subscriberId);
	return toSubscriberDetail(subscriber, usage ?? null, nodeIdsAfter);
}
