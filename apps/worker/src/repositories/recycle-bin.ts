import { chunk, sqlPlaceholders } from '../lib/sql';
import { META_KEYS } from './meta';
import type { ProfileRow } from './profiles';
import type { SubscriberRow } from './subscribers';

const MAX_IN_LIST = 90;

export interface TrashedSubscriberSummary {
	id: string;
	name: string;
	email: string | null;
	deleted_at: number;
}

export interface TrashedSubscriptionSummary {
	id: string;
	name: string;
	subscriber_id: string;
	subscriber_name: string | null;
	profile_id: string;
	profile_name: string | null;
	deleted_at: number;
}

export interface TrashedProfileSummary {
	id: string;
	name: string;
	description: string | null;
	deleted_at: number;
}

export interface TrashedSubscriptionDetail {
	id: string;
	subscriber_id: string;
	profile_id: string;
	revoked_at: number | null;
	subscriber_status: SubscriberRow['status'] | null;
	profile_deleted_at: number | null;
}

export interface RecycleBinCountsRow {
	subscriber: number;
	subscription: number;
	profile: number;
}

export async function listTrashedSubscribers(db: D1Database): Promise<TrashedSubscriberSummary[]> {
	const result = await db
		.prepare(
			`SELECT id, name, email, COALESCE(disabled_at, updated_at) AS deleted_at
			 FROM subscribers
			 WHERE status = 'disabled'
			 ORDER BY COALESCE(disabled_at, updated_at) DESC, id ASC`,
		)
		.all<TrashedSubscriberSummary>();
	return result.results;
}

export async function listTrashedSubscriptions(db: D1Database): Promise<TrashedSubscriptionSummary[]> {
	const result = await db
		.prepare(
			`SELECT s.id, s.name, s.subscriber_id, sub.name AS subscriber_name,
			        s.profile_id, p.name AS profile_name, s.revoked_at AS deleted_at
			 FROM subscriptions s
			 LEFT JOIN subscribers sub ON sub.id = s.subscriber_id
			 LEFT JOIN subscription_profiles p ON p.id = s.profile_id
			 WHERE s.revoked_at IS NOT NULL
			 ORDER BY s.revoked_at DESC, s.id ASC`,
		)
		.all<TrashedSubscriptionSummary>();
	return result.results;
}

export async function listTrashedProfiles(db: D1Database): Promise<TrashedProfileSummary[]> {
	const result = await db
		.prepare(
			`SELECT id, name, description, deleted_at
			 FROM subscription_profiles
			 WHERE deleted_at IS NOT NULL
			 ORDER BY deleted_at DESC, id ASC`,
		)
		.all<TrashedProfileSummary>();
	return result.results;
}

export async function countRecycleBinItems(db: D1Database): Promise<RecycleBinCountsRow> {
	const [subRes, subscriptionRes, profileRes] = await db.batch([
		db.prepare("SELECT COUNT(*) AS count FROM subscribers WHERE status = 'disabled'"),
		db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE revoked_at IS NOT NULL'),
		db.prepare('SELECT COUNT(*) AS count FROM subscription_profiles WHERE deleted_at IS NOT NULL'),
	]);
	const subscriber = (subRes?.results?.[0] as { count: number } | undefined)?.count ?? 0;
	const subscription = (subscriptionRes?.results?.[0] as { count: number } | undefined)?.count ?? 0;
	const profile = (profileRes?.results?.[0] as { count: number } | undefined)?.count ?? 0;
	return { subscriber, subscription, profile };
}

export async function findTrashedSubscriberById(db: D1Database, subscriberId: string): Promise<SubscriberRow | null> {
	const row = await db
		.prepare(
			`SELECT id, name, email, status, traffic_limit_bytes, expires_at,
			        usage_cycle_start, usage_cycle_end, disabled_at, created_at, updated_at
			 FROM subscribers
			 WHERE id = ? AND status = 'disabled'
			 LIMIT 1`,
		)
		.bind(subscriberId)
		.first<SubscriberRow>();
	return row ?? null;
}

export async function findTrashedSubscriptionById(db: D1Database, subscriptionId: string): Promise<TrashedSubscriptionDetail | null> {
	const row = await db
		.prepare(
			`SELECT s.id, s.subscriber_id, s.profile_id, s.revoked_at,
			        sub.status AS subscriber_status,
			        p.deleted_at AS profile_deleted_at
			 FROM subscriptions s
			 LEFT JOIN subscribers sub ON sub.id = s.subscriber_id
			 LEFT JOIN subscription_profiles p ON p.id = s.profile_id
			 WHERE s.id = ? AND s.revoked_at IS NOT NULL
			 LIMIT 1`,
		)
		.bind(subscriptionId)
		.first<TrashedSubscriptionDetail>();
	return row ?? null;
}

export async function findTrashedProfileById(db: D1Database, profileId: string): Promise<ProfileRow | null> {
	const row = await db
		.prepare(
			`SELECT id, name, description, node_selection, online_only, clash_base_json,
			        proxy_groups_json, rules_json, revision, deleted_at, created_at, updated_at
			 FROM subscription_profiles
			 WHERE id = ? AND deleted_at IS NOT NULL
			 LIMIT 1`,
		)
		.bind(profileId)
		.first<ProfileRow>();
	return row ?? null;
}

export function restoreSubscriberStatement(
	db: D1Database,
	subscriberId: string,
	status: SubscriberRow['status'],
	now: number,
): D1PreparedStatement {
	return db
		.prepare("UPDATE subscribers SET status = ?, disabled_at = NULL, updated_at = ? WHERE id = ? AND status = 'disabled'")
		.bind(status, now, subscriberId);
}

export async function restoreSubscriptionRow(db: D1Database, subscriptionId: string): Promise<boolean> {
	const result = await db
		.prepare('UPDATE subscriptions SET revoked_at = NULL WHERE id = ? AND revoked_at IS NOT NULL')
		.bind(subscriptionId)
		.run();
	return result.meta.changes > 0;
}

export async function restoreProfileRow(db: D1Database, profileId: string, now: number): Promise<boolean> {
	const result = await db
		.prepare('UPDATE subscription_profiles SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
		.bind(now, profileId)
		.run();
	return result.meta.changes > 0;
}

function purgeSubscriberGroupStatements(db: D1Database, ids: string[]): D1PreparedStatement[] {
	const placeholders = sqlPlaceholders(ids.length);
	return [
		db.prepare(`DELETE FROM subscriptions WHERE subscriber_id IN (${placeholders})`).bind(...ids),
		db.prepare(`DELETE FROM node_clients WHERE subscriber_id IN (${placeholders})`).bind(...ids),
		db.prepare(`DELETE FROM subscriber_usage WHERE subscriber_id IN (${placeholders})`).bind(...ids),
		db.prepare(`DELETE FROM user_traffic_hourly WHERE subscriber_id IN (${placeholders})`).bind(...ids),
		db.prepare(`DELETE FROM meta WHERE k = ? AND v IN (${placeholders})`).bind(META_KEYS.defaultSubscriberId, ...ids),
		db.prepare(`DELETE FROM subscribers WHERE status = 'disabled' AND id IN (${placeholders})`).bind(...ids),
	];
}

export async function purgeSubscriberById(db: D1Database, subscriberId: string): Promise<boolean> {
	const results = await db.batch(purgeSubscriberGroupStatements(db, [subscriberId]));
	const subscriberDelete = results[results.length - 1];
	return (subscriberDelete?.meta.changes ?? 0) > 0;
}

export async function purgeSubscriptionById(db: D1Database, subscriptionId: string): Promise<boolean> {
	const result = await db.prepare('DELETE FROM subscriptions WHERE id = ? AND revoked_at IS NOT NULL').bind(subscriptionId).run();
	return result.meta.changes > 0;
}

function purgeProfileGroupStatements(db: D1Database, ids: string[]): D1PreparedStatement[] {
	const placeholders = sqlPlaceholders(ids.length);
	return [
		db.prepare(`DELETE FROM subscriptions WHERE revoked_at IS NOT NULL AND profile_id IN (${placeholders})`).bind(...ids),
		db.prepare(`DELETE FROM subscription_profiles WHERE deleted_at IS NOT NULL AND id IN (${placeholders})`).bind(...ids),
	];
}

export async function purgeProfileById(db: D1Database, profileId: string): Promise<boolean> {
	const results = await db.batch(purgeProfileGroupStatements(db, [profileId]));
	const profileDelete = results[results.length - 1];
	return (profileDelete?.meta.changes ?? 0) > 0;
}

export async function purgeExpiredSubscriptions(db: D1Database, cutoff: number, batchSize: number): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM subscriptions
			 WHERE id IN (
			   SELECT id FROM subscriptions WHERE revoked_at IS NOT NULL AND revoked_at < ? LIMIT ?
			 )`,
		)
		.bind(cutoff, batchSize)
		.run();
	return result.meta.changes;
}

export async function purgeExpiredProfiles(db: D1Database, cutoff: number, batchSize: number): Promise<number> {
	const rows = await db
		.prepare(
			`SELECT p.id
			 FROM subscription_profiles p
			 WHERE p.deleted_at IS NOT NULL
			   AND p.deleted_at < ?
			   AND NOT EXISTS (
			     SELECT 1 FROM subscriptions s WHERE s.profile_id = p.id AND s.revoked_at IS NULL
			   )
			 LIMIT ?`,
		)
		.bind(cutoff, batchSize)
		.all<{ id: string }>();
	if (rows.results.length === 0) return 0;

	let removed = 0;
	for (const group of chunk(
		rows.results.map((row) => row.id),
		MAX_IN_LIST,
	)) {
		const results = await db.batch(purgeProfileGroupStatements(db, group));
		removed += results[results.length - 1]?.meta.changes ?? 0;
	}
	return removed;
}

export async function purgeExpiredSubscribers(db: D1Database, cutoff: number, batchSize: number): Promise<number> {
	const rows = await db
		.prepare(
			`SELECT id
			 FROM subscribers
			 WHERE status = 'disabled'
			   AND COALESCE(disabled_at, updated_at) < ?
			 LIMIT ?`,
		)
		.bind(cutoff, batchSize)
		.all<{ id: string }>();
	if (rows.results.length === 0) return 0;

	let removed = 0;
	for (const group of chunk(
		rows.results.map((row) => row.id),
		MAX_IN_LIST,
	)) {
		const results = await db.batch(purgeSubscriberGroupStatements(db, group));
		removed += results[results.length - 1]?.meta.changes ?? 0;
	}
	return removed;
}

export async function emptyTrashedSubscriptions(db: D1Database): Promise<number> {
	const result = await db.prepare('DELETE FROM subscriptions WHERE revoked_at IS NOT NULL').run();
	return result.meta.changes;
}

export async function emptyTrashedProfiles(db: D1Database): Promise<number> {
	const rows = await db
		.prepare(
			`SELECT p.id
			 FROM subscription_profiles p
			 WHERE p.deleted_at IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM subscriptions s WHERE s.profile_id = p.id AND s.revoked_at IS NULL
			   )`,
		)
		.all<{ id: string }>();
	if (rows.results.length === 0) return 0;

	let removed = 0;
	for (const group of chunk(
		rows.results.map((row) => row.id),
		MAX_IN_LIST,
	)) {
		const results = await db.batch(purgeProfileGroupStatements(db, group));
		removed += results[results.length - 1]?.meta.changes ?? 0;
	}
	return removed;
}

export async function emptyTrashedSubscribers(db: D1Database): Promise<number> {
	const rows = await db.prepare("SELECT id FROM subscribers WHERE status = 'disabled'").all<{ id: string }>();
	if (rows.results.length === 0) return 0;

	let removed = 0;
	for (const group of chunk(
		rows.results.map((row) => row.id),
		MAX_IN_LIST,
	)) {
		const results = await db.batch(purgeSubscriberGroupStatements(db, group));
		removed += results[results.length - 1]?.meta.changes ?? 0;
	}
	return removed;
}
