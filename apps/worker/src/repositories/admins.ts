import type { AdminRole } from '@zako/contracts';

export interface AdminRow {
	id: string;
	email: string;
	role: AdminRole;
	enabled: number;
}

export async function findAdminByEmail(db: D1Database, email: string): Promise<AdminRow | null> {
	const normalized = email.trim().toLowerCase();
	const row = await db
		.prepare('SELECT id, email, role, enabled FROM admin_users WHERE email = ? LIMIT 1')
		.bind(normalized)
		.first<AdminRow>();
	return row ?? null;
}
