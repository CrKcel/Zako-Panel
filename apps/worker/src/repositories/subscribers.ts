import { chunk, sqlPlaceholders } from '../lib/sql';

export interface SubscriberRow {
	id: string;
	name: string;
	email: string | null;
	status: 'active' | 'limited' | 'expired' | 'disabled';
	traffic_limit_bytes: number | null;
	expires_at: number | null;
	usage_cycle_start: number;
	usage_cycle_end: number;
	created_at: number;
	updated_at: number;
}

export interface NodeClientRow {
	id: string;
	node_id: string;
	subscriber_id: string;
	xray_email: string;
	vless_uuid: string;
	enabled: number;
	created_at: number;
	updated_at: number;
}

export interface SubscriberUsageRow {
	subscriber_id: string;
	cycle_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}

export interface NewNodeClientRow {
	id: string;
	node_id: string;
	subscriber_id: string;
	xray_email: string;
	vless_uuid: string;
	now: number;
}

export interface NewSubscriberRow {
	id: string;
	name: string;
	email: string | null;
	status: SubscriberRow['status'];
	traffic_limit_bytes: number | null;
	expires_at: number | null;
	usage_cycle_start: number;
	usage_cycle_end: number;
	now: number;
}

export interface SubscriberUpdateInput {
	name?: string;
	email?: string | null;
	status?: SubscriberRow['status'];
	traffic_limit_bytes?: number | null;
	expires_at?: number | null;
}

const SUBSCRIBER_COLUMNS = `id, name, email, status, traffic_limit_bytes, expires_at,
	usage_cycle_start, usage_cycle_end, created_at, updated_at`;

/** D1 caps one statement at 100 bound parameters. */
const MAX_IN_LIST = 90;

const SUBSCRIBER_COLUMNS_QUALIFIED = `s.id, s.name, s.email, s.status, s.traffic_limit_bytes, s.expires_at,
	s.usage_cycle_start, s.usage_cycle_end, s.created_at, s.updated_at`;

export async function findSubscriberById(db: D1Database, subscriberId: string): Promise<SubscriberRow | null> {
	const row = await db
		.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE id = ? LIMIT 1`)
		.bind(subscriberId)
		.first<SubscriberRow>();
	return row ?? null;
}

export async function listSubscriberRows(db: D1Database, limit: number, cursor?: string): Promise<SubscriberRow[]> {
	if (cursor) {
		return (
			await db
				.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE id > ? ORDER BY id ASC LIMIT ?`)
				.bind(cursor, limit)
				.all<SubscriberRow>()
		).results;
	}
	return (await db.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers ORDER BY id ASC LIMIT ?`).bind(limit).all<SubscriberRow>())
		.results;
}

export function insertSubscriberStatement(db: D1Database, row: NewSubscriberRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO subscribers
			 (id, name, email, status, traffic_limit_bytes, expires_at, usage_cycle_start, usage_cycle_end, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.name,
			row.email,
			row.status,
			row.traffic_limit_bytes,
			row.expires_at,
			row.usage_cycle_start,
			row.usage_cycle_end,
			row.now,
			row.now,
		);
}

export function updateSubscriberStatement(
	db: D1Database,
	subscriberId: string,
	input: SubscriberUpdateInput,
	now: number,
): D1PreparedStatement {
	const assignments: string[] = ['updated_at = ?'];
	const values: unknown[] = [now];
	if (input.name !== undefined) {
		assignments.push('name = ?');
		values.push(input.name);
	}
	if (input.email !== undefined) {
		assignments.push('email = ?');
		values.push(input.email);
	}
	if (input.status !== undefined) {
		assignments.push('status = ?');
		values.push(input.status);
	}
	if (input.traffic_limit_bytes !== undefined) {
		assignments.push('traffic_limit_bytes = ?');
		values.push(input.traffic_limit_bytes);
	}
	if (input.expires_at !== undefined) {
		assignments.push('expires_at = ?');
		values.push(input.expires_at);
	}
	values.push(subscriberId);
	return db.prepare(`UPDATE subscribers SET ${assignments.join(', ')} WHERE id = ?`).bind(...values);
}

/** Advances the cycle and rewrites the materialised status in one row update. */
export function updateSubscriberCycleStatement(
	db: D1Database,
	subscriberId: string,
	cycle: { start: number; end: number },
	status: SubscriberRow['status'],
	now: number,
): D1PreparedStatement {
	return db
		.prepare('UPDATE subscribers SET usage_cycle_start = ?, usage_cycle_end = ?, status = ?, updated_at = ? WHERE id = ?')
		.bind(cycle.start, cycle.end, status, now, subscriberId);
}

export function updateSubscriberStatusStatement(
	db: D1Database,
	subscriberId: string,
	status: SubscriberRow['status'],
	now: number,
): D1PreparedStatement {
	return db.prepare('UPDATE subscribers SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, subscriberId);
}

export async function findNodeClientsBySubscriber(db: D1Database, subscriberId: string): Promise<NodeClientRow[]> {
	return (
		await db
			.prepare(
				`SELECT id, node_id, subscriber_id, xray_email, vless_uuid, enabled, created_at, updated_at
				 FROM node_clients
				 WHERE subscriber_id = ?
				 ORDER BY node_id ASC`,
			)
			.bind(subscriberId)
			.all<NodeClientRow>()
	).results;
}

export function setNodeClientEnabledStatement(db: D1Database, clientId: string, enabled: boolean, now: number): D1PreparedStatement {
	return db.prepare('UPDATE node_clients SET enabled = ?, updated_at = ? WHERE id = ?').bind(enabled ? 1 : 0, now, clientId);
}

export function enabledNodeClientsStatement(db: D1Database, subscriberId: string): D1PreparedStatement {
	return db
		.prepare(
			`SELECT id, node_id, subscriber_id, xray_email, vless_uuid, enabled, created_at, updated_at
			 FROM node_clients
			 WHERE subscriber_id = ? AND enabled = 1`,
		)
		.bind(subscriberId);
}

export interface NodeClientUsageRow {
	subscriber_id: string;
	xray_email: string;
	usage_cycle_start: number;
}

/**
 * Joins credentials with their subscriber in one statement so a report needs no
 * second lookup to learn the current usage cycle.
 */
export function nodeClientUsageMapStatement(db: D1Database, nodeId: string, emails: string[]): D1PreparedStatement {
	if (emails.length === 0) {
		return db
			.prepare(
				`SELECT nc.subscriber_id, nc.xray_email, s.usage_cycle_start
				 FROM node_clients nc JOIN subscribers s ON s.id = nc.subscriber_id
				 WHERE nc.node_id = ? AND 0 = 1`,
			)
			.bind(nodeId);
	}
	return db
		.prepare(
			`SELECT nc.subscriber_id, nc.xray_email, s.usage_cycle_start
			 FROM node_clients nc JOIN subscribers s ON s.id = nc.subscriber_id
			 WHERE nc.node_id = ? AND nc.xray_email IN (${sqlPlaceholders(emails.length)})`,
		)
		.bind(nodeId, ...emails);
}

/**
 * Credentials for one node, joined with the subscriber name so the node-side
 * setup does not need a second request per client.
 */
export async function listNodeClientRowsByNode(db: D1Database, nodeId: string): Promise<NodeClientWithSubscriberRow[]> {
	return (
		await db
			.prepare(
				`SELECT nc.id, nc.node_id, nc.subscriber_id, s.name AS subscriber_name,
				        nc.xray_email, nc.vless_uuid, nc.enabled, nc.created_at, nc.updated_at
				 FROM node_clients nc JOIN subscribers s ON s.id = nc.subscriber_id
				 WHERE nc.node_id = ?
				 ORDER BY nc.created_at ASC, nc.id ASC`,
			)
			.bind(nodeId)
			.all<NodeClientWithSubscriberRow>()
	).results;
}

export interface NodeClientWithSubscriberRow extends NodeClientRow {
	subscriber_name: string;
}

export function insertNodeClientStatement(db: D1Database, client: NewNodeClientRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO node_clients (id, node_id, subscriber_id, xray_email, vless_uuid, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
		)
		.bind(client.id, client.node_id, client.subscriber_id, client.xray_email, client.vless_uuid, client.now, client.now);
}

export function usageStatement(db: D1Database, subscriberId: string): D1PreparedStatement {
	return db
		.prepare(
			`SELECT subscriber_id, cycle_start, uplink_bytes, downlink_bytes, updated_at
			 FROM subscriber_usage WHERE subscriber_id = ? LIMIT 1`,
		)
		.bind(subscriberId);
}

/** Starts a new usage cycle at zero without deleting the row. */
export function resetUsageStatement(db: D1Database, subscriberId: string, cycleStart: number, now: number): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO subscriber_usage (subscriber_id, cycle_start, uplink_bytes, downlink_bytes, updated_at)
			 VALUES (?, ?, 0, 0, ?)
			 ON CONFLICT(subscriber_id) DO UPDATE SET
			   cycle_start = excluded.cycle_start,
			   uplink_bytes = 0,
			   downlink_bytes = 0,
			   updated_at = excluded.updated_at`,
		)
		.bind(subscriberId, cycleStart, now);
}

/** Chunked so a full-page read stays under D1's 100 bound parameters. */
export async function findUsageBySubscribers(db: D1Database, subscriberIds: string[]): Promise<SubscriberUsageRow[]> {
	const rows: SubscriberUsageRow[] = [];
	for (const group of chunk(subscriberIds, MAX_IN_LIST)) {
		const result = await db
			.prepare(
				`SELECT subscriber_id, cycle_start, uplink_bytes, downlink_bytes, updated_at
				 FROM subscriber_usage
				 WHERE subscriber_id IN (${sqlPlaceholders(group.length)})`,
			)
			.bind(...group)
			.all<SubscriberUsageRow>();
		rows.push(...result.results);
	}
	return rows;
}

/**
 * Active credentials for one node. The join on subscribers is what makes a
 * suspended, expired or over-quota subscriber disappear from the node user set
 * after the cron materialises its status.
 */
export function nodeActiveUsersStatement(db: D1Database, nodeId: string): D1PreparedStatement {
	return db
		.prepare(
			`SELECT nc.xray_email, nc.vless_uuid
			 FROM node_clients nc JOIN subscribers s ON s.id = nc.subscriber_id
			 WHERE nc.node_id = ? AND nc.enabled = 1 AND s.status = 'active'
			 ORDER BY nc.created_at ASC, nc.id ASC`,
		)
		.bind(nodeId);
}

export interface SubscriberNodeCountRow {
	subscriber_id: string;
	node_count: number;
}

/** Enabled grant counts for one page of subscribers, avoiding a per-row query. */
export async function countNodeClientsBySubscribers(db: D1Database, subscriberIds: string[]): Promise<SubscriberNodeCountRow[]> {
	const rows: SubscriberNodeCountRow[] = [];
	for (const group of chunk(subscriberIds, MAX_IN_LIST)) {
		const result = await db
			.prepare(
				`SELECT subscriber_id, COUNT(*) AS node_count
				 FROM node_clients
				 WHERE enabled = 1 AND subscriber_id IN (${sqlPlaceholders(group.length)})
				 GROUP BY subscriber_id`,
			)
			.bind(...group)
			.all<SubscriberNodeCountRow>();
		rows.push(...result.results);
	}
	return rows;
}

/**
 * Candidates for the quarter-hourly reconciliation: rows whose cycle ended, or
 * whose stored status could have gone stale since the last run. Each clause asks
 * only "can this stored value still be right", never what the next value is, so
 * the status priority stays in `lib/subscriber-status.ts`. Rows are a superset of
 * the rows that actually change, which keeps the cron from reading every row.
 *
 * `expires_at <= now` and `used_bytes >= traffic_limit_bytes` are NULL when the
 * corresponding column is unset, so a NULL comparison never selects a row.
 */
export function subscribersNeedingReconcileStatement(db: D1Database, now: number, limit: number): D1PreparedStatement {
	return db
		.prepare(
			`SELECT ${SUBSCRIBER_COLUMNS_QUALIFIED} FROM (
			   SELECT s.*, COALESCE(CASE WHEN u.cycle_start = s.usage_cycle_start
			                             THEN u.uplink_bytes + u.downlink_bytes ELSE 0 END, 0) AS used_bytes
			   FROM subscribers s
			   LEFT JOIN subscriber_usage u ON u.subscriber_id = s.id
			 ) s
			 WHERE s.usage_cycle_end <= ?1
			    OR (s.status = 'active' AND (s.expires_at <= ?1 OR s.used_bytes >= s.traffic_limit_bytes))
			    OR (s.status = 'expired' AND (s.expires_at IS NULL OR s.expires_at > ?1))
			    OR (s.status = 'limited' AND (s.traffic_limit_bytes IS NULL OR s.used_bytes < s.traffic_limit_bytes))
			 ORDER BY s.id ASC
			 LIMIT ?2`,
		)
		.bind(now, limit);
}
