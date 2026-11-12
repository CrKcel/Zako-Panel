import { chunk } from '../lib/sql';

export interface TrafficReportRow {
	node_id: string;
	report_id: string;
	payload_hash: string;
	period_start: number;
	period_end: number;
	item_count: number;
	has_counter_gap: number;
	received_at: number;
}

export interface NodeTrafficHourlyRow {
	node_id: string;
	bucket_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}

export interface SiteTrafficHourlyRow {
	bucket_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}

export interface UserTrafficHourlyRow {
	subscriber_id: string;
	node_id: string;
	bucket_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}

export interface TrafficTotalRow {
	uplink_bytes: number;
	downlink_bytes: number;
}

export interface TrafficGroupRow extends TrafficTotalRow {
	key: string;
	label: string | null;
}

export interface NewTrafficReportRow {
	node_id: string;
	report_id: string;
	payload_hash: string;
	period_start: number;
	period_end: number;
	item_count: number;
	has_counter_gap: boolean;
	received_at: number;
}

export interface UserBucketInput {
	subscriber_id: string;
	node_id: string;
	bucket_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}

export interface UsageInput {
	subscriber_id: string;
	cycle_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}

export async function findReportHash(db: D1Database, nodeId: string, reportId: string): Promise<string | null> {
	const row = await db
		.prepare('SELECT payload_hash FROM traffic_reports WHERE node_id = ? AND report_id = ? LIMIT 1')
		.bind(nodeId, reportId)
		.first<{ payload_hash: string }>();
	return row?.payload_hash ?? null;
}

export function insertTrafficReportStatement(db: D1Database, report: NewTrafficReportRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO traffic_reports
			 (node_id, report_id, payload_hash, period_start, period_end, item_count, has_counter_gap, received_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			report.node_id,
			report.report_id,
			report.payload_hash,
			report.period_start,
			report.period_end,
			report.item_count,
			report.has_counter_gap ? 1 : 0,
			report.received_at,
		);
}

export function upsertNodeBucketStatement(
	db: D1Database,
	nodeId: string,
	bucketStart: number,
	uplinkBytes: number,
	downlinkBytes: number,
	now: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO node_traffic_hourly (node_id, bucket_start, uplink_bytes, downlink_bytes, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(node_id, bucket_start) DO UPDATE SET
			   uplink_bytes = node_traffic_hourly.uplink_bytes + excluded.uplink_bytes,
			   downlink_bytes = node_traffic_hourly.downlink_bytes + excluded.downlink_bytes,
			   updated_at = excluded.updated_at`,
		)
		.bind(nodeId, bucketStart, uplinkBytes, downlinkBytes, now);
}

export function upsertSiteBucketStatement(
	db: D1Database,
	bucketStart: number,
	uplinkBytes: number,
	downlinkBytes: number,
	now: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO site_traffic_hourly (bucket_start, uplink_bytes, downlink_bytes, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(bucket_start) DO UPDATE SET
			   uplink_bytes = site_traffic_hourly.uplink_bytes + excluded.uplink_bytes,
			   downlink_bytes = site_traffic_hourly.downlink_bytes + excluded.downlink_bytes,
			   updated_at = excluded.updated_at`,
		)
		.bind(bucketStart, uplinkBytes, downlinkBytes, now);
}

/** Six bound values per row; 16 rows per statement stays under D1's 100-parameter limit. */
export function upsertUserBucketsStatements(db: D1Database, rows: UserBucketInput[]): D1PreparedStatement[] {
	const statements: D1PreparedStatement[] = [];
	for (const group of chunk(rows, 16)) {
		const values = group.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
		const bindings = group.flatMap((row) => [
			row.subscriber_id,
			row.node_id,
			row.bucket_start,
			row.uplink_bytes,
			row.downlink_bytes,
			row.updated_at,
		]);
		statements.push(
			db
				.prepare(
					`INSERT INTO user_traffic_hourly
					 (subscriber_id, node_id, bucket_start, uplink_bytes, downlink_bytes, updated_at)
					 VALUES ${values}
					 ON CONFLICT(subscriber_id, node_id, bucket_start) DO UPDATE SET
					   uplink_bytes = user_traffic_hourly.uplink_bytes + excluded.uplink_bytes,
					   downlink_bytes = user_traffic_hourly.downlink_bytes + excluded.downlink_bytes,
					   updated_at = excluded.updated_at`,
				)
				.bind(...bindings),
		);
	}
	return statements;
}

/**
 * Five bound values per row; 20 rows per statement. A rolled cycle resets the
 * accumulated values instead of adding to the previous cycle.
 */
export function upsertSubscriberUsageStatements(db: D1Database, rows: UsageInput[]): D1PreparedStatement[] {
	const statements: D1PreparedStatement[] = [];
	for (const group of chunk(rows, 20)) {
		const values = group.map(() => '(?, ?, ?, ?, ?)').join(', ');
		const bindings = group.flatMap((row) => [row.subscriber_id, row.cycle_start, row.uplink_bytes, row.downlink_bytes, row.updated_at]);
		statements.push(
			db
				.prepare(
					`INSERT INTO subscriber_usage (subscriber_id, cycle_start, uplink_bytes, downlink_bytes, updated_at)
					 VALUES ${values}
					 ON CONFLICT(subscriber_id) DO UPDATE SET
					   uplink_bytes = CASE
					     WHEN subscriber_usage.cycle_start = excluded.cycle_start
					     THEN subscriber_usage.uplink_bytes + excluded.uplink_bytes
					     ELSE excluded.uplink_bytes END,
					   downlink_bytes = CASE
					     WHEN subscriber_usage.cycle_start = excluded.cycle_start
					     THEN subscriber_usage.downlink_bytes + excluded.downlink_bytes
					     ELSE excluded.downlink_bytes END,
					   cycle_start = excluded.cycle_start,
					   updated_at = excluded.updated_at`,
				)
				.bind(...bindings),
		);
	}
	return statements;
}

export async function sumSiteTraffic(db: D1Database, from: number, to: number): Promise<TrafficTotalRow> {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(uplink_bytes), 0) AS uplink_bytes, COALESCE(SUM(downlink_bytes), 0) AS downlink_bytes
			 FROM site_traffic_hourly WHERE bucket_start >= ? AND bucket_start < ?`,
		)
		.bind(from, to)
		.first<TrafficTotalRow>();
	return row ?? { uplink_bytes: 0, downlink_bytes: 0 };
}

export async function sumNodeTraffic(db: D1Database, from: number, to: number, nodeId?: string): Promise<TrafficGroupRow[]> {
	const filter = nodeId ? 'AND t.node_id = ?' : '';
	const bindings = nodeId ? [from, to, nodeId] : [from, to];
	const rows = await db
		.prepare(
			`SELECT t.node_id AS key, n.name AS label,
			        SUM(t.uplink_bytes) AS uplink_bytes, SUM(t.downlink_bytes) AS downlink_bytes
			 FROM node_traffic_hourly t
			 JOIN nodes n ON n.id = t.node_id
			 WHERE t.bucket_start >= ? AND t.bucket_start < ? ${filter}
			 GROUP BY t.node_id, n.name
			 ORDER BY (SUM(t.uplink_bytes) + SUM(t.downlink_bytes)) DESC, t.node_id ASC`,
		)
		.bind(...bindings)
		.all<TrafficGroupRow>();
	return rows.results;
}

export async function sumSubscriberTraffic(
	db: D1Database,
	from: number,
	to: number,
	options: { subscriberId?: string; nodeId?: string },
): Promise<TrafficGroupRow[]> {
	const filters: string[] = [];
	const bindings: unknown[] = [from, to];
	if (options.subscriberId) {
		filters.push('t.subscriber_id = ?');
		bindings.push(options.subscriberId);
	}
	if (options.nodeId) {
		filters.push('t.node_id = ?');
		bindings.push(options.nodeId);
	}
	const filter = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
	const rows = await db
		.prepare(
			`SELECT t.subscriber_id AS key, s.name AS label,
			        SUM(t.uplink_bytes) AS uplink_bytes, SUM(t.downlink_bytes) AS downlink_bytes
			 FROM user_traffic_hourly t
			 JOIN subscribers s ON s.id = t.subscriber_id
			 WHERE t.bucket_start >= ? AND t.bucket_start < ? ${filter}
			 GROUP BY t.subscriber_id, s.name
			 ORDER BY (SUM(t.uplink_bytes) + SUM(t.downlink_bytes)) DESC, t.subscriber_id ASC`,
		)
		.bind(...bindings)
		.all<TrafficGroupRow>();
	return rows.results;
}

export async function sumUserNodeTraffic(
	db: D1Database,
	from: number,
	to: number,
	options: { subscriberId?: string; nodeId?: string },
): Promise<TrafficGroupRow[]> {
	const filters: string[] = [];
	const bindings: unknown[] = [from, to];
	if (options.subscriberId) {
		filters.push('t.subscriber_id = ?');
		bindings.push(options.subscriberId);
	}
	if (options.nodeId) {
		filters.push('t.node_id = ?');
		bindings.push(options.nodeId);
	}
	const filter = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
	const rows = await db
		.prepare(
			`SELECT t.node_id AS key, n.name AS label,
			        SUM(t.uplink_bytes) AS uplink_bytes, SUM(t.downlink_bytes) AS downlink_bytes
			 FROM user_traffic_hourly t
			 JOIN nodes n ON n.id = t.node_id
			 WHERE t.bucket_start >= ? AND t.bucket_start < ? ${filter}
			 GROUP BY t.node_id, n.name
			 ORDER BY (SUM(t.uplink_bytes) + SUM(t.downlink_bytes)) DESC, t.node_id ASC`,
		)
		.bind(...bindings)
		.all<TrafficGroupRow>();
	return rows.results;
}

export async function sumUserTraffic(
	db: D1Database,
	from: number,
	to: number,
	options: { subscriberId?: string; nodeId?: string },
): Promise<TrafficTotalRow> {
	const filters: string[] = [];
	const bindings: unknown[] = [from, to];
	if (options.subscriberId) {
		filters.push('subscriber_id = ?');
		bindings.push(options.subscriberId);
	}
	if (options.nodeId) {
		filters.push('node_id = ?');
		bindings.push(options.nodeId);
	}
	const filter = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(uplink_bytes), 0) AS uplink_bytes, COALESCE(SUM(downlink_bytes), 0) AS downlink_bytes
			 FROM user_traffic_hourly WHERE bucket_start >= ? AND bucket_start < ? ${filter}`,
		)
		.bind(...bindings)
		.first<TrafficTotalRow>();
	return row ?? { uplink_bytes: 0, downlink_bytes: 0 };
}

export async function sumNodeTotal(db: D1Database, from: number, to: number, nodeId: string): Promise<TrafficTotalRow> {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(uplink_bytes), 0) AS uplink_bytes, COALESCE(SUM(downlink_bytes), 0) AS downlink_bytes
			 FROM node_traffic_hourly WHERE bucket_start >= ? AND bucket_start < ? AND node_id = ?`,
		)
		.bind(from, to, nodeId)
		.first<TrafficTotalRow>();
	return row ?? { uplink_bytes: 0, downlink_bytes: 0 };
}

export async function deleteOldNodeBuckets(db: D1Database, cutoff: number, batchSize: number): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM node_traffic_hourly
			 WHERE (node_id, bucket_start) IN (
			   SELECT node_id, bucket_start FROM node_traffic_hourly WHERE bucket_start < ? LIMIT ?
			 )`,
		)
		.bind(cutoff, batchSize)
		.run();
	return result.meta.changes;
}

export async function deleteOldSiteBuckets(db: D1Database, cutoff: number, batchSize: number): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM site_traffic_hourly
			 WHERE bucket_start IN (
			   SELECT bucket_start FROM site_traffic_hourly WHERE bucket_start < ? LIMIT ?
			 )`,
		)
		.bind(cutoff, batchSize)
		.run();
	return result.meta.changes;
}

export async function deleteOldUserBuckets(db: D1Database, cutoff: number, batchSize: number): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM user_traffic_hourly
			 WHERE (subscriber_id, node_id, bucket_start) IN (
			   SELECT subscriber_id, node_id, bucket_start FROM user_traffic_hourly
			   WHERE bucket_start < ? LIMIT ?
			 )`,
		)
		.bind(cutoff, batchSize)
		.run();
	return result.meta.changes;
}

export async function deleteOldReports(db: D1Database, cutoff: number, batchSize: number): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM traffic_reports
			 WHERE (node_id, report_id) IN (
			   SELECT node_id, report_id FROM traffic_reports WHERE received_at < ? LIMIT ?
			 )`,
		)
		.bind(cutoff, batchSize)
		.run();
	return result.meta.changes;
}
