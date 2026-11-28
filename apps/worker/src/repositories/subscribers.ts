import { chunk, sqlPlaceholders } from '../lib/sql';

export interface SubscriberRow {
	id: string;
	name: string;
	email: string | null;
	status: 'active' | 'limited' | 'expired' | 'disabled';
	xray_email: string;
	vless_uuid: string;
	traffic_limit_bytes: number | null;
	expires_at: number | null;
	usage_cycle_start: number;
	usage_cycle_end: number;
	disabled_at: number | null;
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

export interface NewSubscriberRow {
	id: string;
	name: string;
	email: string | null;
	status: SubscriberRow['status'];
	xray_email: string;
	vless_uuid: string;
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
	disabled_at?: number | null;
}

const SUBSCRIBER_COLUMNS = `id, name, email, status, xray_email, vless_uuid, traffic_limit_bytes, expires_at,
	usage_cycle_start, usage_cycle_end, disabled_at, created_at, updated_at`;

/** D1 caps one statement at 100 bound parameters. */
const MAX_IN_LIST = 90;

const SUBSCRIBER_COLUMNS_QUALIFIED = `s.id, s.name, s.email, s.status, s.xray_email, s.vless_uuid, s.traffic_limit_bytes, s.expires_at,
	s.usage_cycle_start, s.usage_cycle_end, s.disabled_at, s.created_at, s.updated_at`;

export async function findSubscriberById(db: D1Database, subscriberId: string): Promise<SubscriberRow | null> {
	const row = await db
		.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE id = ? LIMIT 1`)
		.bind(subscriberId)
		.first<SubscriberRow>();
	return row ?? null;
}

export async function findFirstSubscriber(db: D1Database): Promise<SubscriberRow | null> {
	const row = await db
		.prepare(
			`SELECT ${SUBSCRIBER_COLUMNS}
			 FROM subscribers
			 WHERE status != 'disabled'
			 ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at ASC, id ASC
			 LIMIT 1`,
		)
		.first<SubscriberRow>();
	return row ?? null;
}

export async function listSubscriberRows(db: D1Database, limit: number, cursor?: string): Promise<SubscriberRow[]> {
	if (cursor) {
		return (
			await db
				.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE status != 'disabled' AND id > ? ORDER BY id ASC LIMIT ?`)
				.bind(cursor, limit)
				.all<SubscriberRow>()
		).results;
	}
	return (
		await db
			.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE status != 'disabled' ORDER BY id ASC LIMIT ?`)
			.bind(limit)
			.all<SubscriberRow>()
	).results;
}

export function insertSubscriberStatement(db: D1Database, row: NewSubscriberRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO subscribers
			 (id, name, email, status, xray_email, vless_uuid, traffic_limit_bytes, expires_at,
			  usage_cycle_start, usage_cycle_end, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.name,
			row.email,
			row.status,
			row.xray_email,
			row.vless_uuid,
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
	if (input.disabled_at !== undefined) {
		assignments.push('disabled_at = ?');
		values.push(input.disabled_at);
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

export interface SubscriberReportUsageRow {
	subscriber_id: string;
	xray_email: string;
	usage_cycle_start: number;
}

/**
 * Resolves reported xray_email values to their subscriber and usage cycle in
 * one statement.
 */
export function subscriberUsageMapStatement(db: D1Database, emails: string[]): D1PreparedStatement {
	if (emails.length === 0) {
		return db.prepare('SELECT id AS subscriber_id, xray_email, usage_cycle_start FROM subscribers WHERE 0 = 1');
	}
	return db
		.prepare(
			`SELECT id AS subscriber_id, xray_email, usage_cycle_start
			 FROM subscribers
			 WHERE xray_email IN (${sqlPlaceholders(emails.length)})`,
		)
		.bind(...emails);
}

export interface NodeCredentialRow {
	id: string;
	node_id: string;
	subscriber_id: string;
	subscriber_name: string;
	xray_email: string;
	vless_uuid: string;
	enabled: number;
}

/**
 * Subscriber credentials projected onto one node for operator inspection and
 * troubleshooting. Active subscribers are enabled in the node inbound.
 */
export async function listSubscriberCredentialsByNode(db: D1Database, nodeId: string): Promise<NodeCredentialRow[]> {
	return (
		await db
			.prepare(
				`SELECT id, ? AS node_id, id AS subscriber_id, name AS subscriber_name,
				        xray_email, vless_uuid,
				        CASE WHEN status = 'active' THEN 1 ELSE 0 END AS enabled
				 FROM subscribers
				 WHERE status != 'disabled'
				 ORDER BY created_at ASC, id ASC`,
			)
			.bind(nodeId)
			.all<NodeCredentialRow>()
	).results;
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
 * Active subscriber credentials synced to every node. Suspended, expired or
 * over-quota subscribers disappear from the node user set after the cron or
 * admin write materialises their status.
 */
export function activeSubscriberUsersStatement(db: D1Database): D1PreparedStatement {
	return db.prepare(
		`SELECT xray_email, vless_uuid
		 FROM subscribers
		 WHERE status = 'active'
		 ORDER BY created_at ASC, id ASC`,
	);
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
