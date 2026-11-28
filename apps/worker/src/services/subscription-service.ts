import type { CreateSubscriptionRequest, Subscription, UpdateSubscriptionRequest } from '@zako/contracts';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import { cycleUsage } from '../lib/subscriber-status';
import { generateToken } from '../lib/token';
import { renderUriDocument } from '../renderers/uri';
import { findProfileById } from '../repositories/profiles';
import { findSubscriberById } from '../repositories/subscribers';
import {
	findSubscriptionById,
	insertSubscriptionStatement,
	listSubscriptionRows,
	revokeSubscriptionRow,
	updateSubscriptionRow,
	type SubscriptionRow,
} from '../repositories/subscriptions';
import type { ListQuery, Paginated } from '../types';
import { distribute, loadDistributionContext, renderClashDocumentFor, type Distribution, type DistributionContext } from './distribution';

export type SubscriptionEncoding = 'base64' | 'plain';

export interface RenderedSubscription {
	body: string;
	contentType: 'application/yaml' | 'text/plain';
	headers: Record<string, string>;
}

const CLASH_FILE_NAME = 'zako-clash.yaml';
const URI_FILE_NAME = 'zako-uri.txt';

function toSubscription(row: SubscriptionRow): Subscription {
	return {
		id: row.id,
		subscriber_id: row.subscriber_id,
		subscriber_name: row.subscriber_name,
		profile_id: row.profile_id,
		profile_name: row.profile_name,
		name: row.name,
		token: row.token,
		revoked_at: row.revoked_at,
		expires_at: row.expires_at,
		created_at: row.created_at,
	};
}

function unavailable(): AppError {
	return new AppError('SUBSCRIPTION_UNAVAILABLE', 'No distributable nodes are available', 503);
}

export async function listSubscriptions(db: D1Database, query: ListQuery): Promise<Paginated<Subscription>> {
	const rows = await listSubscriptionRows(db, query.limit + 1, query.cursor);
	const hasMore = rows.length > query.limit;
	const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
	const items = pageRows.map(toSubscription);
	const last = items[items.length - 1];
	return { items, next_cursor: hasMore && last ? last.id : null };
}

export async function createSubscription(
	db: D1Database,
	input: CreateSubscriptionRequest,
): Promise<{ subscription: Subscription; token: string }> {
	const subscriber = await findSubscriberById(db, input.subscriber_id);
	if (!subscriber) throw new AppError('NOT_FOUND', 'Subscriber not found', 404);
	const profile = await findProfileById(db, input.profile_id);
	if (!profile) throw new AppError('NOT_FOUND', 'Profile not found', 404);

	const now = nowSeconds();
	const token = generateToken();
	const subscriptionId = newId();
	await insertSubscriptionStatement(db, {
		id: subscriptionId,
		subscriber_id: input.subscriber_id,
		profile_id: input.profile_id,
		name: input.name,
		token,
		expires_at: input.expires_at ?? null,
		now,
	}).run();

	const row = await findSubscriptionById(db, subscriptionId);
	if (!row) throw new AppError('INTERNAL_ERROR', 'Subscription was not persisted', 500);
	return { subscription: toSubscription(row), token };
}

export async function updateSubscription(db: D1Database, subscriptionId: string, input: UpdateSubscriptionRequest): Promise<Subscription> {
	const existing = await findSubscriptionById(db, subscriptionId);
	if (!existing) throw new AppError('NOT_FOUND', 'Subscription not found', 404);
	if (existing.revoked_at !== null) throw new AppError('CONFLICT', 'Subscription is revoked', 409);

	if (input.profile_id !== undefined) {
		const profile = await findProfileById(db, input.profile_id);
		if (!profile) throw new AppError('NOT_FOUND', 'Profile not found', 404);
	}

	await updateSubscriptionRow(db, subscriptionId, {
		profile_id: input.profile_id,
		name: input.name,
		expires_at: input.expires_at,
	});

	const updated = await findSubscriptionById(db, subscriptionId);
	if (!updated) throw new AppError('NOT_FOUND', 'Subscription not found', 404);
	return toSubscription(updated);
}

export async function revokeSubscription(db: D1Database, subscriptionId: string): Promise<Subscription> {
	const existing = await findSubscriptionById(db, subscriptionId);
	if (!existing) throw new AppError('NOT_FOUND', 'Subscription not found', 404);
	await revokeSubscriptionRow(db, subscriptionId, nowSeconds());
	const updated = await findSubscriptionById(db, subscriptionId);
	if (!updated) throw new AppError('NOT_FOUND', 'Subscription not found', 404);
	return toSubscription(updated);
}

/** Loads the context and the proxies for one token; refusing when nothing is distributable. */
async function loadRenderable(db: D1Database, token: string): Promise<{ context: DistributionContext; distribution: Distribution }> {
	const context = await loadDistributionContext(db, token);
	const distribution = await distribute(db, context);
	if (distribution.proxies.length === 0) throw unavailable();
	return { context, distribution };
}

function subscriptionHeaders(context: DistributionContext, fileName: string): Record<string, string> {
	const used = cycleUsage(context.usage, context.subscription.subscriber_usage_cycle_start);
	const total = context.subscription.subscriber_traffic_limit_bytes ?? 0;
	const expire = context.subscription.subscriber_expires_at ?? 0;
	return {
		'Content-Disposition': `attachment; filename="${fileName}"`,
		'subscription-userinfo': `upload=${used.uplink}; download=${used.downlink}; total=${total}; expire=${expire}`,
	};
}

export async function getClashSubscription(db: D1Database, token: string): Promise<RenderedSubscription> {
	const { context, distribution } = await loadRenderable(db, token);
	return {
		body: renderClashDocumentFor(context.profile, distribution.proxies),
		contentType: 'application/yaml',
		headers: subscriptionHeaders(context, CLASH_FILE_NAME),
	};
}

export async function getUriSubscription(db: D1Database, token: string, encoding: SubscriptionEncoding): Promise<RenderedSubscription> {
	const { context, distribution } = await loadRenderable(db, token);
	return {
		body: renderUriDocument(
			distribution.proxies.map((entry) => entry.uri),
			encoding,
		),
		contentType: 'text/plain',
		headers: subscriptionHeaders(context, URI_FILE_NAME),
	};
}
