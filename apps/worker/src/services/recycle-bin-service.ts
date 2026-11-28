import type { RecycleBinCounts, RecycleBinItem, RecycleBinItemType, RecycleBinList, RecycleBinRestoreResult } from '@zako/contracts';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import { deriveSubscriberStatus } from '../lib/subscriber-status';
import { insertAuditEvent, insertAuditEventStatement } from '../repositories/audit-events';
import { hasActiveSubscriptionsForProfile } from '../repositories/profiles';
import {
	countRecycleBinItems,
	emptyTrashedProfiles,
	emptyTrashedSubscribers,
	emptyTrashedSubscriptions,
	findTrashedProfileById,
	findTrashedSubscriberById,
	findTrashedSubscriptionById,
	listTrashedProfiles,
	listTrashedSubscribers,
	listTrashedSubscriptions,
	purgeExpiredProfiles,
	purgeExpiredSubscribers,
	purgeExpiredSubscriptions,
	purgeProfileById,
	purgeSubscriberById,
	purgeSubscriptionById,
	restoreProfileRow,
	restoreSubscriberStatement,
	restoreSubscriptionRow,
	type TrashedSubscriptionSummary,
} from '../repositories/recycle-bin';
import { findUsageBySubscribers } from '../repositories/subscribers';
import { bumpUsersVersionStatement } from './users-version';

export const RECYCLE_BIN_RETENTION_DAYS = 30;
const DAY_SECONDS = 86_400;
const RETENTION_SECONDS = RECYCLE_BIN_RETENTION_DAYS * DAY_SECONDS;

function notFound(type: RecycleBinItemType): AppError {
	const label = type === 'subscriber' ? 'Subscriber' : type === 'subscription' ? 'Subscription' : 'Profile';
	return new AppError('NOT_FOUND', `${label} not found in recycle bin`, 404);
}

function formatSubscriptionDetail(row: TrashedSubscriptionSummary): string {
	const subscriberLabel = row.subscriber_name ?? row.subscriber_id;
	const profileLabel = row.profile_name ?? row.profile_id;
	return `${subscriberLabel} · ${profileLabel}`;
}

function buildItem(type: RecycleBinItemType, id: string, name: string, detail: string | null, deletedAt: number): RecycleBinItem {
	return {
		type,
		id,
		name,
		detail,
		deleted_at: deletedAt,
		purge_at: deletedAt + RETENTION_SECONDS,
	};
}

export async function listRecycleBinItems(db: D1Database, filterType?: RecycleBinItemType): Promise<RecycleBinList> {
	const includeSubscriber = !filterType || filterType === 'subscriber';
	const includeSubscription = !filterType || filterType === 'subscription';
	const includeProfile = !filterType || filterType === 'profile';

	const [countsRow, subscribers, subscriptions, profiles] = await Promise.all([
		countRecycleBinItems(db),
		includeSubscriber ? listTrashedSubscribers(db) : Promise.resolve([]),
		includeSubscription ? listTrashedSubscriptions(db) : Promise.resolve([]),
		includeProfile ? listTrashedProfiles(db) : Promise.resolve([]),
	]);

	const items: RecycleBinItem[] = [
		...subscribers.map((row) => buildItem('subscriber', row.id, row.name, row.email, row.deleted_at)),
		...subscriptions.map((row) => buildItem('subscription', row.id, row.name, formatSubscriptionDetail(row), row.deleted_at)),
		...profiles.map((row) => buildItem('profile', row.id, row.name, row.description, row.deleted_at)),
	];
	items.sort((a, b) => b.deleted_at - a.deleted_at || a.id.localeCompare(b.id));

	const counts: RecycleBinCounts = {
		subscriber: countsRow.subscriber,
		subscription: countsRow.subscription,
		profile: countsRow.profile,
		total: countsRow.subscriber + countsRow.subscription + countsRow.profile,
	};

	return {
		items,
		retention_days: RECYCLE_BIN_RETENTION_DAYS,
		counts,
	};
}

export async function restoreRecycleBinItem(
	db: D1Database,
	itemType: RecycleBinItemType,
	itemId: string,
	actorEmail: string | null,
): Promise<RecycleBinRestoreResult> {
	const now = nowSeconds();

	if (itemType === 'subscriber') {
		const existing = await findTrashedSubscriberById(db, itemId);
		if (!existing) throw notFound('subscriber');

		const [usage] = await findUsageBySubscribers(db, [itemId]);
		const status = deriveSubscriberStatus(
			{
				status: 'active',
				expires_at: existing.expires_at,
				traffic_limit_bytes: existing.traffic_limit_bytes,
				usage_cycle_start: existing.usage_cycle_start,
				usage: usage ?? null,
			},
			now,
		);
		const statements = [
			restoreSubscriberStatement(db, itemId, status, now),
			bumpUsersVersionStatement(db),
			insertAuditEventStatement(db, {
				id: newId(),
				actor_email: actorEmail,
				action: 'recycle_bin.restore',
				target_type: 'subscriber',
				target_id: itemId,
				detail_json: JSON.stringify({ name: existing.name, restored_status: status }),
				created_at: now,
			}),
		];
		await db.batch(statements);
		return { type: 'subscriber', id: itemId };
	}

	if (itemType === 'subscription') {
		const existing = await findTrashedSubscriptionById(db, itemId);
		if (!existing) throw notFound('subscription');
		if (existing.subscriber_status === null || existing.subscriber_status === 'disabled') {
			throw new AppError('CONFLICT', 'Restore the subscriber before restoring this subscription', 409);
		}
		if (existing.profile_deleted_at !== null) {
			throw new AppError('CONFLICT', 'Restore the profile before restoring this subscription', 409);
		}
		const restored = await restoreSubscriptionRow(db, itemId);
		if (!restored) throw notFound('subscription');
		await insertAuditEvent(db, {
			id: newId(),
			actor_email: actorEmail,
			action: 'recycle_bin.restore',
			target_type: 'subscription',
			target_id: itemId,
			detail_json: null,
			created_at: now,
		});
		return { type: 'subscription', id: itemId };
	}

	const existing = await findTrashedProfileById(db, itemId);
	if (!existing) throw notFound('profile');
	const restored = await restoreProfileRow(db, itemId, now);
	if (!restored) throw notFound('profile');
	await insertAuditEvent(db, {
		id: newId(),
		actor_email: actorEmail,
		action: 'recycle_bin.restore',
		target_type: 'profile',
		target_id: itemId,
		detail_json: JSON.stringify({ name: existing.name }),
		created_at: now,
	});
	return { type: 'profile', id: itemId };
}

export async function purgeRecycleBinItem(
	db: D1Database,
	itemType: RecycleBinItemType,
	itemId: string,
	actorEmail: string | null,
): Promise<void> {
	const now = nowSeconds();

	if (itemType === 'subscriber') {
		const existing = await findTrashedSubscriberById(db, itemId);
		if (!existing) throw notFound('subscriber');
		const deleted = await purgeSubscriberById(db, itemId);
		if (!deleted) throw notFound('subscriber');
		await insertAuditEvent(db, {
			id: newId(),
			actor_email: actorEmail,
			action: 'recycle_bin.purge',
			target_type: 'subscriber',
			target_id: itemId,
			detail_json: JSON.stringify({ name: existing.name }),
			created_at: now,
		});
		return;
	}

	if (itemType === 'subscription') {
		const existing = await findTrashedSubscriptionById(db, itemId);
		if (!existing) throw notFound('subscription');
		const deleted = await purgeSubscriptionById(db, itemId);
		if (!deleted) throw notFound('subscription');
		await insertAuditEvent(db, {
			id: newId(),
			actor_email: actorEmail,
			action: 'recycle_bin.purge',
			target_type: 'subscription',
			target_id: itemId,
			detail_json: null,
			created_at: now,
		});
		return;
	}

	const existing = await findTrashedProfileById(db, itemId);
	if (!existing) throw notFound('profile');
	if (await hasActiveSubscriptionsForProfile(db, itemId)) {
		throw new AppError('CONFLICT', 'Profile is referenced by an active subscription', 409);
	}
	const deleted = await purgeProfileById(db, itemId);
	if (!deleted) throw notFound('profile');
	await insertAuditEvent(db, {
		id: newId(),
		actor_email: actorEmail,
		action: 'recycle_bin.purge',
		target_type: 'profile',
		target_id: itemId,
		detail_json: JSON.stringify({ name: existing.name }),
		created_at: now,
	});
}

export async function emptyRecycleBin(
	db: D1Database,
	filterType: RecycleBinItemType | undefined,
	actorEmail: string | null,
): Promise<RecycleBinCounts> {
	const now = nowSeconds();
	let subscription = 0;
	let profile = 0;
	let subscriber = 0;

	// Subscriptions must be purged before profiles and subscribers so foreign keys clear cleanly.
	if (!filterType || filterType === 'subscription') {
		subscription = await emptyTrashedSubscriptions(db);
	}
	if (!filterType || filterType === 'profile') {
		profile = await emptyTrashedProfiles(db);
	}
	if (!filterType || filterType === 'subscriber') {
		subscriber = await emptyTrashedSubscribers(db);
	}

	const deleted: RecycleBinCounts = {
		subscriber,
		subscription,
		profile,
		total: subscriber + subscription + profile,
	};

	await insertAuditEvent(db, {
		id: newId(),
		actor_email: actorEmail,
		action: 'recycle_bin.empty',
		target_type: filterType ?? 'all',
		target_id: null,
		detail_json: JSON.stringify(deleted),
		created_at: now,
	});

	return deleted;
}

export interface RecycleBinPurgeSummary {
	subscriptions: number;
	profiles: number;
	subscribers: number;
}

export async function purgeExpiredRecycleBinItems(
	db: D1Database,
	now: number,
	drainFn: (purge: (cutoff: number, batchSize: number) => Promise<number>, cutoff: number) => Promise<number>,
): Promise<RecycleBinPurgeSummary> {
	const cutoff = now - RETENTION_SECONDS;
	const subscriptions = await drainFn((c, size) => purgeExpiredSubscriptions(db, c, size), cutoff);
	const profiles = await drainFn((c, size) => purgeExpiredProfiles(db, c, size), cutoff);
	const subscribers = await drainFn((c, size) => purgeExpiredSubscribers(db, c, size), cutoff);
	return { subscriptions, profiles, subscribers };
}
