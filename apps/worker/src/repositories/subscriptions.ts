export interface SubscriptionRow {
	id: string;
	subscriber_id: string;
	subscriber_name: string | null;
	profile_id: string;
	profile_name: string | null;
	name: string;
	token: string;
	revoked_at: number | null;
	expires_at: number | null;
	created_at: number;
}

export interface SubscriptionLookupRow {
	id: string;
	subscriber_id: string;
	profile_id: string;
	name: string;
	token: string;
	revoked_at: number | null;
	expires_at: number | null;
	created_at: number;
	subscriber_name: string;
	subscriber_status: 'active' | 'limited' | 'expired' | 'disabled';
	subscriber_traffic_limit_bytes: number | null;
	subscriber_expires_at: number | null;
	subscriber_usage_cycle_start: number;
}

export interface NewSubscriptionRow {
	id: string;
	subscriber_id: string;
	profile_id: string;
	name: string;
	token: string;
	expires_at: number | null;
	now: number;
}

export interface SubscriptionUpdateInput {
	profile_id?: string;
	name?: string;
	expires_at?: number | null;
}

const SUBSCRIPTION_SELECT = `SELECT s.id, s.subscriber_id, sub.name AS subscriber_name, s.profile_id, p.name AS profile_name,
	s.name, s.token, s.revoked_at, s.expires_at, s.created_at
	FROM subscriptions s
	LEFT JOIN subscribers sub ON sub.id = s.subscriber_id
	LEFT JOIN subscription_profiles p ON p.id = s.profile_id`;

export async function listSubscriptionRows(db: D1Database, limit: number, cursor?: string): Promise<SubscriptionRow[]> {
	if (cursor) {
		return (
			await db
				.prepare(`${SUBSCRIPTION_SELECT} WHERE s.revoked_at IS NULL AND s.id > ? ORDER BY s.id ASC LIMIT ?`)
				.bind(cursor, limit)
				.all<SubscriptionRow>()
		).results;
	}
	return (
		await db.prepare(`${SUBSCRIPTION_SELECT} WHERE s.revoked_at IS NULL ORDER BY s.id ASC LIMIT ?`).bind(limit).all<SubscriptionRow>()
	).results;
}

export async function findSubscriptionById(db: D1Database, subscriptionId: string): Promise<SubscriptionRow | null> {
	const row = await db.prepare(`${SUBSCRIPTION_SELECT} WHERE s.id = ? LIMIT 1`).bind(subscriptionId).first<SubscriptionRow>();
	return row ?? null;
}

export async function findSubscriptionByToken(db: D1Database, token: string): Promise<SubscriptionLookupRow | null> {
	const row = await db
		.prepare(
			`SELECT s.id, s.subscriber_id, s.profile_id, s.name, s.token, s.revoked_at, s.expires_at, s.created_at,
			        sub.name AS subscriber_name, sub.status AS subscriber_status,
			        sub.traffic_limit_bytes AS subscriber_traffic_limit_bytes,
			        sub.expires_at AS subscriber_expires_at,
			        sub.usage_cycle_start AS subscriber_usage_cycle_start
			 FROM subscriptions s
			 JOIN subscribers sub ON sub.id = s.subscriber_id
			 WHERE s.token = ?
			 LIMIT 1`,
		)
		.bind(token)
		.first<SubscriptionLookupRow>();
	return row ?? null;
}

export function insertSubscriptionStatement(db: D1Database, subscription: NewSubscriptionRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO subscriptions (id, subscriber_id, profile_id, name, token, revoked_at, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
		)
		.bind(
			subscription.id,
			subscription.subscriber_id,
			subscription.profile_id,
			subscription.name,
			subscription.token,
			subscription.expires_at,
			subscription.now,
		);
}

export async function updateSubscriptionRow(db: D1Database, subscriptionId: string, input: SubscriptionUpdateInput): Promise<void> {
	const assignments: string[] = [];
	const values: unknown[] = [];
	if (input.profile_id !== undefined) {
		assignments.push('profile_id = ?');
		values.push(input.profile_id);
	}
	if (input.name !== undefined) {
		assignments.push('name = ?');
		values.push(input.name);
	}
	if (input.expires_at !== undefined) {
		assignments.push('expires_at = ?');
		values.push(input.expires_at);
	}
	if (assignments.length === 0) return;
	values.push(subscriptionId);
	await db
		.prepare(`UPDATE subscriptions SET ${assignments.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();
}

export async function revokeSubscriptionRow(db: D1Database, subscriptionId: string, now: number): Promise<void> {
	await db.prepare('UPDATE subscriptions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').bind(now, subscriptionId).run();
}
