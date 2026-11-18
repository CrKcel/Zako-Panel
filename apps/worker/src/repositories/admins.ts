import type { AdminRole } from '@zako/contracts';

export interface AdminRow {
	id: string;
	email: string;
	role: AdminRole;
	enabled: number;
	created_at: number;
	updated_at: number;
}

export interface NewAdminRow {
	id: string;
	email: string;
	role: AdminRole;
	now: number;
}

export interface AdminUpdateInput {
	role?: AdminRole;
	enabled?: boolean;
}

const ADMIN_COLUMNS = 'id, email, role, enabled, created_at, updated_at';

export async function findAdminByEmail(db: D1Database, email: string): Promise<AdminRow | null> {
	const normalized = email.trim().toLowerCase();
	const row = await db.prepare(`SELECT ${ADMIN_COLUMNS} FROM admin_users WHERE email = ? LIMIT 1`).bind(normalized).first<AdminRow>();
	return row ?? null;
}

export async function findAdminById(db: D1Database, adminId: string): Promise<AdminRow | null> {
	const row = await db.prepare(`SELECT ${ADMIN_COLUMNS} FROM admin_users WHERE id = ? LIMIT 1`).bind(adminId).first<AdminRow>();
	return row ?? null;
}

export async function listAdminRows(db: D1Database, limit: number, cursor?: string): Promise<AdminRow[]> {
	if (cursor) {
		return (
			await db.prepare(`SELECT ${ADMIN_COLUMNS} FROM admin_users WHERE id > ? ORDER BY id ASC LIMIT ?`).bind(cursor, limit).all<AdminRow>()
		).results;
	}
	return (await db.prepare(`SELECT ${ADMIN_COLUMNS} FROM admin_users ORDER BY id ASC LIMIT ?`).bind(limit).all<AdminRow>()).results;
}

export function insertAdminStatement(db: D1Database, row: NewAdminRow): D1PreparedStatement {
	return db
		.prepare('INSERT INTO admin_users (id, email, role, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
		.bind(row.id, row.email, row.role, row.now, row.now);
}

export function updateAdminStatement(db: D1Database, adminId: string, input: AdminUpdateInput, now: number): D1PreparedStatement {
	const assignments: string[] = ['updated_at = ?'];
	const values: unknown[] = [now];
	if (input.role !== undefined) {
		assignments.push('role = ?');
		values.push(input.role);
	}
	if (input.enabled !== undefined) {
		assignments.push('enabled = ?');
		values.push(input.enabled ? 1 : 0);
	}
	values.push(adminId);
	return db.prepare(`UPDATE admin_users SET ${assignments.join(', ')} WHERE id = ?`).bind(...values);
}

/** Counts enabled owners other than the given row; the last one must stay. */
export async function countOtherEnabledOwners(db: D1Database, adminId: string): Promise<number> {
	const row = await db
		.prepare("SELECT COUNT(*) AS count FROM admin_users WHERE role = 'owner' AND enabled = 1 AND id <> ?")
		.bind(adminId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}
