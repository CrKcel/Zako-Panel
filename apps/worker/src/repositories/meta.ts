import { sqlPlaceholders } from '../lib/sql';

export const META_KEYS = {
	usersVersion: 'users_ver',
	defaultSubscriberId: 'default_subscriber_id',
} as const;

export async function getMetaValue(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare('SELECT v FROM meta WHERE k = ? LIMIT 1').bind(key).first<{ v: string }>();
	return row?.v ?? null;
}

export async function getMetaValues(db: D1Database, keys: string[]): Promise<Map<string, string>> {
	if (keys.length === 0) return new Map();
	const rows = await db
		.prepare(`SELECT k, v FROM meta WHERE k IN (${sqlPlaceholders(keys.length)})`)
		.bind(...keys)
		.all<{ k: string; v: string }>();
	return new Map(rows.results.map((row) => [row.k, row.v]));
}

export async function getUsersVersion(db: D1Database): Promise<number> {
	const value = await getMetaValue(db, META_KEYS.usersVersion);
	const version = value === null ? 0 : Number(value);
	return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

/** Incrementing in SQL keeps concurrent writers from losing an update. */
export function incrementMetaStatement(db: D1Database, key: string): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO meta (k, v) VALUES (?, '1')
			 ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + 1 AS TEXT)`,
		)
		.bind(key);
}
