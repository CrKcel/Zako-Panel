export interface ProfileRow {
	id: string;
	name: string;
	description: string | null;
	node_selection: 'all' | 'selected';
	online_only: number;
	clash_base_json: string;
	proxy_groups_json: string;
	rules_json: string;
	revision: number;
	deleted_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface NewProfileRow {
	id: string;
	name: string;
	description: string | null;
	node_selection: 'all' | 'selected';
	online_only: boolean;
	clash_base_json: string;
	proxy_groups_json: string;
	rules_json: string;
	now: number;
}

export interface ProfileUpdateInput {
	name?: string;
	description?: string | null;
	node_selection?: 'all' | 'selected';
	online_only?: boolean;
	clash_base_json?: string;
	proxy_groups_json?: string;
	rules_json?: string;
}

const PROFILE_COLUMNS = `id, name, description, node_selection, online_only, clash_base_json,
	proxy_groups_json, rules_json, revision, deleted_at, created_at, updated_at`;

export async function listProfileRows(db: D1Database, limit: number, cursor?: string): Promise<ProfileRow[]> {
	if (cursor) {
		return (
			await db
				.prepare(`SELECT ${PROFILE_COLUMNS} FROM subscription_profiles WHERE deleted_at IS NULL AND id > ? ORDER BY id ASC LIMIT ?`)
				.bind(cursor, limit)
				.all<ProfileRow>()
		).results;
	}
	return (
		await db
			.prepare(`SELECT ${PROFILE_COLUMNS} FROM subscription_profiles WHERE deleted_at IS NULL ORDER BY id ASC LIMIT ?`)
			.bind(limit)
			.all<ProfileRow>()
	).results;
}

export function findProfileStatement(db: D1Database, profileId: string): D1PreparedStatement {
	return db.prepare(`SELECT ${PROFILE_COLUMNS} FROM subscription_profiles WHERE id = ? AND deleted_at IS NULL LIMIT 1`).bind(profileId);
}

export async function findProfileById(db: D1Database, profileId: string): Promise<ProfileRow | null> {
	const row = await findProfileStatement(db, profileId).first<ProfileRow>();
	return row ?? null;
}

export async function findProfileByName(db: D1Database, name: string): Promise<ProfileRow | null> {
	const row = await db
		.prepare(`SELECT ${PROFILE_COLUMNS} FROM subscription_profiles WHERE name = ? LIMIT 1`)
		.bind(name)
		.first<ProfileRow>();
	return row ?? null;
}

export function profileNodeIdsStatement(db: D1Database, profileId: string): D1PreparedStatement {
	return db.prepare('SELECT node_id FROM profile_nodes WHERE profile_id = ? ORDER BY node_id ASC').bind(profileId);
}

export async function listProfileNodeIds(db: D1Database, profileId: string): Promise<string[]> {
	const rows = await profileNodeIdsStatement(db, profileId).all<{ node_id: string }>();
	return rows.results.map((row) => row.node_id);
}

export function insertProfileStatement(db: D1Database, profile: NewProfileRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO subscription_profiles
			 (id, name, description, node_selection, online_only, clash_base_json, proxy_groups_json,
			  rules_json, revision, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		)
		.bind(
			profile.id,
			profile.name,
			profile.description,
			profile.node_selection,
			profile.online_only ? 1 : 0,
			profile.clash_base_json,
			profile.proxy_groups_json,
			profile.rules_json,
			profile.now,
			profile.now,
		);
}

export async function updateProfile(db: D1Database, profileId: string, input: ProfileUpdateInput, now: number): Promise<void> {
	const assignments: string[] = ['revision = revision + 1', 'updated_at = ?'];
	const values: unknown[] = [now];
	if (input.name !== undefined) {
		assignments.push('name = ?');
		values.push(input.name);
	}
	if (input.description !== undefined) {
		assignments.push('description = ?');
		values.push(input.description);
	}
	if (input.node_selection !== undefined) {
		assignments.push('node_selection = ?');
		values.push(input.node_selection);
	}
	if (input.online_only !== undefined) {
		assignments.push('online_only = ?');
		values.push(input.online_only ? 1 : 0);
	}
	if (input.clash_base_json !== undefined) {
		assignments.push('clash_base_json = ?');
		values.push(input.clash_base_json);
	}
	if (input.proxy_groups_json !== undefined) {
		assignments.push('proxy_groups_json = ?');
		values.push(input.proxy_groups_json);
	}
	if (input.rules_json !== undefined) {
		assignments.push('rules_json = ?');
		values.push(input.rules_json);
	}
	values.push(profileId);
	await db
		.prepare(`UPDATE subscription_profiles SET ${assignments.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();
}

export function replaceProfileNodesStatements(db: D1Database, profileId: string, nodeIds: string[]): D1PreparedStatement[] {
	const statements = [db.prepare('DELETE FROM profile_nodes WHERE profile_id = ?').bind(profileId)];
	for (const nodeId of nodeIds) {
		statements.push(db.prepare('INSERT INTO profile_nodes (profile_id, node_id) VALUES (?, ?)').bind(profileId, nodeId));
	}
	return statements;
}

export async function hasActiveSubscriptionsForProfile(db: D1Database, profileId: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS found FROM subscriptions WHERE profile_id = ? AND revoked_at IS NULL LIMIT 1')
		.bind(profileId)
		.first<{ found: number }>();
	return row !== null;
}

export async function softDeleteProfileRow(db: D1Database, profileId: string, now: number): Promise<boolean> {
	const result = await db
		.prepare('UPDATE subscription_profiles SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
		.bind(now, now, profileId)
		.run();
	return result.meta.changes > 0;
}

export async function deleteProfileRow(db: D1Database, profileId: string): Promise<boolean> {
	const result = await db.prepare('DELETE FROM subscription_profiles WHERE id = ?').bind(profileId).run();
	return result.meta.changes > 0;
}
