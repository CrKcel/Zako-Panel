export const META_KEYS = {
	usersVersion: 'users_ver',
} as const;

export async function getMetaValue(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare('SELECT v FROM meta WHERE k = ? LIMIT 1').bind(key).first<{ v: string }>();
	return row?.v ?? null;
}
