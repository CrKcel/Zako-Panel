export interface EnrollmentTokenRow {
	id: string;
	token_hash: string;
	name_prefix: string | null;
	default_sni: string;
	default_port: number;
	default_fingerprint: string;
	heartbeat_interval_seconds: number;
	created_by: string;
	expires_at: number;
	used_at: number | null;
	used_node_id: string | null;
	revoked_at: number | null;
	created_at: number;
}

export interface NewEnrollmentTokenRow {
	id: string;
	token_hash: string;
	name_prefix: string | null;
	default_sni: string;
	default_port: number;
	default_fingerprint: string;
	heartbeat_interval_seconds: number;
	created_by: string;
	expires_at: number;
	created_at: number;
}

const COLUMNS = `id, token_hash, name_prefix, default_sni, default_port, default_fingerprint,
	heartbeat_interval_seconds, created_by, expires_at, used_at, used_node_id, revoked_at, created_at`;

export async function insertEnrollmentToken(db: D1Database, row: NewEnrollmentTokenRow): Promise<void> {
	await db
		.prepare(
			`INSERT INTO node_enrollment_tokens
			 (id, token_hash, name_prefix, default_sni, default_port, default_fingerprint,
			  heartbeat_interval_seconds, created_by, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.token_hash,
			row.name_prefix,
			row.default_sni,
			row.default_port,
			row.default_fingerprint,
			row.heartbeat_interval_seconds,
			row.created_by,
			row.expires_at,
			row.created_at,
		)
		.run();
}

export async function findEnrollmentTokenById(db: D1Database, id: string): Promise<EnrollmentTokenRow | null> {
	const row = await db.prepare(`SELECT ${COLUMNS} FROM node_enrollment_tokens WHERE id = ? LIMIT 1`).bind(id).first<EnrollmentTokenRow>();
	return row ?? null;
}

export async function listEnrollmentTokenRows(db: D1Database, limit: number, cursor?: string): Promise<EnrollmentTokenRow[]> {
	if (cursor) {
		return (
			await db
				.prepare(`SELECT ${COLUMNS} FROM node_enrollment_tokens WHERE id < ? ORDER BY id DESC LIMIT ?`)
				.bind(cursor, limit)
				.all<EnrollmentTokenRow>()
		).results;
	}
	return (await db.prepare(`SELECT ${COLUMNS} FROM node_enrollment_tokens ORDER BY id DESC LIMIT ?`).bind(limit).all<EnrollmentTokenRow>())
		.results;
}

/**
 * Atomically marks an active enrollment token as consumed. Returns true only if
 * this call won the single-use race.
 */
export async function consumeEnrollmentToken(db: D1Database, id: string, now: number): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE node_enrollment_tokens
			 SET used_at = ?
			 WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
		)
		.bind(now, id, now)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export function linkEnrollmentTokenNodeStatement(db: D1Database, tokenId: string, nodeId: string): D1PreparedStatement {
	return db.prepare('UPDATE node_enrollment_tokens SET used_node_id = ? WHERE id = ?').bind(nodeId, tokenId);
}

export async function revokeEnrollmentTokenRow(db: D1Database, id: string, now: number): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE node_enrollment_tokens
			 SET revoked_at = ?
			 WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
		)
		.bind(now, id)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function findNodeByName(db: D1Database, name: string): Promise<{ id: string } | null> {
	const row = await db.prepare('SELECT id FROM nodes WHERE name = ? LIMIT 1').bind(name).first<{ id: string }>();
	return row ?? null;
}
