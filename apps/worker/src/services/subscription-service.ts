import type {
	ClashPreview,
	CreateSubscriptionRequest,
	DistributionSkipReason,
	ProxyGroup,
	SubscriberBlockReason,
	Subscription,
} from '@zako/contracts';
import { AppError } from '../lib/errors';
import { sha256Hex } from '../lib/hash';
import { newId } from '../lib/ids';
import { isHeartbeatFresh, nowSeconds } from '../lib/node-status';
import { cycleUsage } from '../lib/subscriber-status';
import { generateToken } from '../lib/token';
import { vlessRealityAdapter, vlessRealityParamsSchema } from '../protocols/vless-reality';
import type { ProxyEndpoint } from '../protocols/types';
import { renderClashDocument } from '../renderers/clash';
import { renderUriDocument } from '../renderers/uri';
import type { EndpointRow } from '../repositories/endpoints';
import { enabledEndpointsByNodesStatement, listEnabledEndpointRowsByNodes } from '../repositories/endpoints';
import { getMetaValue, META_KEYS } from '../repositories/meta';
import type { NodeRow } from '../repositories/nodes';
import { findNodesByIds, findNodesByIdsStatement } from '../repositories/nodes';
import type { ProfileRow } from '../repositories/profiles';
import { findProfileById, findProfileStatement, profileNodeIdsStatement } from '../repositories/profiles';
import type { NodeClientRow, SubscriberUsageRow } from '../repositories/subscribers';
import { enabledNodeClientsStatement, findSubscriberById, usageStatement } from '../repositories/subscribers';
import {
	findSubscriptionById,
	findSubscriptionByTokenHash,
	insertSubscriptionStatement,
	listSubscriptionRows,
	revokeSubscriptionRow,
	updateSubscriptionTokenHash,
	type SubscriptionLookupRow,
	type SubscriptionRow,
} from '../repositories/subscriptions';
import type { Paginated } from '../types';
import type { ListQuery } from './node-service';

export type SubscriptionEncoding = 'base64' | 'plain';

export interface RenderedSubscription {
	body: string;
	contentType: 'application/yaml' | 'text/plain';
	headers: Record<string, string>;
}

const CLASH_FILE_NAME = 'zako-clash.yaml';
const URI_FILE_NAME = 'zako-uri.txt';

/**
 * Previews render credentials as a placeholder. The profile preview exists to
 * validate names, groups and rules; keeping the real UUID out of it keeps
 * docs/security.md's allowed surfaces for proxy credentials unchanged.
 */
const PREVIEW_UUID = '00000000-0000-0000-0000-000000000000';

function toSubscription(row: SubscriptionRow): Subscription {
	return {
		id: row.id,
		subscriber_id: row.subscriber_id,
		profile_id: row.profile_id,
		name: row.name,
		revoked_at: row.revoked_at,
		expires_at: row.expires_at,
		created_at: row.created_at,
	};
}

function parseObject(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Stored profile JSON is written from validated input; an unreadable base
		// degrades to an empty document rather than failing subscriptions.
	}
	return {};
}

function parseProxyGroups(value: string): ProxyGroup[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? (parsed as ProxyGroup[]) : [];
	} catch {
		return [];
	}
}

function parseRules(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((rule): rule is string => typeof rule === 'string') : [];
	} catch {
		return [];
	}
}

function invalidToken(): AppError {
	return new AppError('SUBSCRIPTION_INVALID', 'Subscription token is invalid', 401);
}

function forbidden(message: string): AppError {
	return new AppError('FORBIDDEN', message, 403);
}

function unavailable(): AppError {
	return new AppError('SUBSCRIPTION_UNAVAILABLE', 'No distributable nodes are available', 503);
}

interface DistributionContext {
	subscription: SubscriptionLookupRow;
	profile: ProfileRow;
	profileNodeIds: string[];
	clients: NodeClientRow[];
	usage: SubscriberUsageRow | null;
}

interface SubscriberEntitlement {
	status: 'active' | 'limited' | 'expired' | 'disabled';
	expires_at: number | null;
	traffic_limit_bytes: number | null;
	usage_cycle_start: number;
	usage: SubscriberUsageRow | null;
}

/**
 * One predicate decides whether a subscriber may receive a subscription. It is
 * shared with the profile preview so the preview reports the same reason a real
 * request would be refused with. Entitlement is checked live from the stored
 * expiry and usage instead of trusting the cron-materialised status, so a quota
 * reset or a renewed expiry takes effect on the next request.
 */
function subscriberBlockReason(subscriber: SubscriberEntitlement, now: number): SubscriberBlockReason | null {
	if (subscriber.status === 'disabled') return 'inactive';
	if (subscriber.expires_at !== null && subscriber.expires_at <= now) return 'expired';
	const used = cycleUsage(subscriber.usage, subscriber.usage_cycle_start);
	if (subscriber.traffic_limit_bytes !== null && used.total >= subscriber.traffic_limit_bytes) return 'over_quota';
	return null;
}

const BLOCK_MESSAGES: Record<SubscriberBlockReason, string> = {
	inactive: 'Subscriber is not active',
	expired: 'Subscriber has expired',
	over_quota: 'Subscriber traffic limit reached',
};

async function loadDistribution(db: D1Database, token: string): Promise<DistributionContext> {
	const hash = await sha256Hex(token);
	const subscription = await findSubscriptionByTokenHash(db, hash);
	if (!subscription) throw invalidToken();

	const now = nowSeconds();
	if (subscription.revoked_at !== null) throw invalidToken();
	if (subscription.expires_at !== null && subscription.expires_at <= now) {
		throw forbidden('Subscription has expired');
	}

	const [profileResult, nodeIdsResult, clientsResult, usageResult] = await db.batch([
		findProfileStatement(db, subscription.profile_id),
		profileNodeIdsStatement(db, subscription.profile_id),
		enabledNodeClientsStatement(db, subscription.subscriber_id),
		usageStatement(db, subscription.subscriber_id),
	]);

	const profile = (profileResult?.results as ProfileRow[] | undefined)?.[0];
	if (!profile) throw forbidden('Subscription profile is no longer available');
	const profileNodeIds = ((nodeIdsResult?.results as { node_id: string }[] | undefined) ?? []).map((row) => row.node_id);
	const clients = (clientsResult?.results as NodeClientRow[] | undefined) ?? [];
	const usage = (usageResult?.results as SubscriberUsageRow[] | undefined)?.[0] ?? null;

	const blocked = subscriberBlockReason(
		{
			status: subscription.subscriber_status,
			expires_at: subscription.subscriber_expires_at,
			traffic_limit_bytes: subscription.subscriber_traffic_limit_bytes,
			usage_cycle_start: subscription.subscriber_usage_cycle_start,
			usage,
		},
		now,
	);
	if (blocked) throw forbidden(BLOCK_MESSAGES[blocked]);

	return { subscription, profile, profileNodeIds, clients, usage };
}

interface RenderableProxy {
	node_id: string;
	proxy: Record<string, unknown>;
	uri: string;
}

function uniqueName(base: string, used: Set<string>): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let suffix = 2;
	while (used.has(`${base}-${suffix}`)) suffix += 1;
	const name = `${base}-${suffix}`;
	used.add(name);
	return name;
}

export interface SkippedNode {
	node_id: string;
	node_name: string;
	reason: DistributionSkipReason;
}

interface BuiltProxies {
	proxies: RenderableProxy[];
	skipped: SkippedNode[];
}

/**
 * Applies the distribution rules to granted nodes. Both serving and preview use
 * this path so a preview cannot show a node that a real subscription drops.
 * The checks run in the documented order, and the first failing rule is the one
 * reported for a skipped node.
 */
function buildProxies(
	profile: ProfileRow,
	profileNodeIds: string[],
	clients: NodeClientRow[],
	nodes: NodeRow[],
	endpoints: EndpointRow[],
	now: number,
): BuiltProxies {
	const onlineOnly = profile.online_only === 1;
	const selected = profile.node_selection === 'selected' ? new Set(profileNodeIds) : null;
	const nodesById = new Map(nodes.map((node) => [node.id, node]));
	const endpointsByNode = new Map<string, EndpointRow[]>();
	for (const endpoint of endpoints) {
		const list = endpointsByNode.get(endpoint.node_id);
		if (list) list.push(endpoint);
		else endpointsByNode.set(endpoint.node_id, [endpoint]);
	}

	const usedNames = new Set<string>();
	const reported = new Set<string>();
	const proxies: RenderableProxy[] = [];
	const skipped: SkippedNode[] = [];

	const skip = (node: NodeRow, reason: DistributionSkipReason): void => {
		if (reported.has(node.id)) return;
		reported.add(node.id);
		skipped.push({ node_id: node.id, node_name: node.name, reason });
	};

	for (const client of clients) {
		if (client.enabled !== 1) continue;
		const node = nodesById.get(client.node_id);
		if (!node) continue;
		if (node.enabled !== 1) {
			skip(node, 'disabled');
			continue;
		}
		if (selected && !selected.has(node.id)) {
			skip(node, 'not_selected');
			continue;
		}
		if (onlineOnly && !isHeartbeatFresh(node.last_seen_at, node.heartbeat_interval_seconds, now)) {
			skip(node, 'offline');
			continue;
		}
		// stats_healthy=0 still distributes so a broken stats API does not hide every node.
		if (node.xray_healthy !== 1) {
			skip(node, 'unhealthy');
			continue;
		}

		const nodeEndpoints = endpointsByNode.get(node.id) ?? [];
		const rendered: RenderableProxy[] = [];
		for (const endpoint of nodeEndpoints) {
			const params = vlessRealityParamsSchema.safeParse(JSON.parse(endpoint.params_json) as unknown);
			if (!params.success) continue;
			const baseName = nodeEndpoints.length === 1 ? node.name : `${node.name}-${endpoint.name}`;
			const proxyEndpoint: ProxyEndpoint = {
				id: endpoint.id,
				name: uniqueName(baseName, usedNames),
				protocol: 'vless-reality',
				host: endpoint.host,
				port: endpoint.port,
				params: params.data,
			};
			rendered.push({
				node_id: node.id,
				proxy: vlessRealityAdapter.toClash(proxyEndpoint, client.vless_uuid),
				uri: vlessRealityAdapter.toUri(proxyEndpoint, client.vless_uuid),
			});
		}
		if (rendered.length === 0) {
			skip(node, 'no_endpoint');
			continue;
		}
		proxies.push(...rendered);
	}
	return { proxies, skipped };
}

async function loadNodesAndEndpoints(db: D1Database, context: DistributionContext, now: number): Promise<RenderableProxy[]> {
	const nodeIds = [...new Set(context.clients.map((client) => client.node_id))];
	if (nodeIds.length === 0) throw unavailable();

	const [nodeResult, endpointResult] = await db.batch([
		findNodesByIdsStatement(db, nodeIds),
		enabledEndpointsByNodesStatement(db, nodeIds),
	]);
	const nodes = (nodeResult?.results as NodeRow[] | undefined) ?? [];
	const endpoints = (endpointResult?.results as EndpointRow[] | undefined) ?? [];
	const { proxies } = buildProxies(context.profile, context.profileNodeIds, context.clients, nodes, endpoints, now);
	if (proxies.length === 0) throw unavailable();
	return proxies;
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
	const tokenHash = await sha256Hex(token);
	const subscriptionId = newId();
	await insertSubscriptionStatement(db, {
		id: subscriptionId,
		subscriber_id: input.subscriber_id,
		profile_id: input.profile_id,
		name: input.name,
		token_hash: tokenHash,
		expires_at: input.expires_at ?? null,
		now,
	}).run();

	const row = await findSubscriptionById(db, subscriptionId);
	if (!row) throw new AppError('INTERNAL_ERROR', 'Subscription was not persisted', 500);
	return { subscription: toSubscription(row), token };
}

export async function rotateSubscription(db: D1Database, subscriptionId: string): Promise<{ token: string }> {
	const existing = await findSubscriptionById(db, subscriptionId);
	if (!existing) throw new AppError('NOT_FOUND', 'Subscription not found', 404);
	const token = generateToken();
	const tokenHash = await sha256Hex(token);
	await updateSubscriptionTokenHash(db, subscriptionId, tokenHash);
	return { token };
}

export async function revokeSubscription(db: D1Database, subscriptionId: string): Promise<Subscription> {
	const existing = await findSubscriptionById(db, subscriptionId);
	if (!existing) throw new AppError('NOT_FOUND', 'Subscription not found', 404);
	await revokeSubscriptionRow(db, subscriptionId, nowSeconds());
	const updated = await findSubscriptionById(db, subscriptionId);
	if (!updated) throw new AppError('NOT_FOUND', 'Subscription not found', 404);
	return toSubscription(updated);
}

export async function getClashSubscription(db: D1Database, token: string): Promise<RenderedSubscription> {
	const context = await loadDistribution(db, token);
	const now = nowSeconds();
	const proxies = await loadNodesAndEndpoints(db, context, now);
	const body = renderClashDocument(
		parseObject(context.profile.clash_base_json),
		proxies.map((entry) => entry.proxy as { name: string }),
		parseProxyGroups(context.profile.proxy_groups_json),
		parseRules(context.profile.rules_json),
	);
	return {
		body,
		contentType: 'application/yaml',
		headers: subscriptionHeaders(context, CLASH_FILE_NAME),
	};
}

export async function getUriSubscription(db: D1Database, token: string, encoding: SubscriptionEncoding): Promise<RenderedSubscription> {
	const context = await loadDistribution(db, token);
	const now = nowSeconds();
	const proxies = await loadNodesAndEndpoints(db, context, now);
	return {
		body: renderUriDocument(
			proxies.map((entry) => entry.uri),
			encoding,
		),
		contentType: 'text/plain',
		headers: subscriptionHeaders(context, URI_FILE_NAME),
	};
}

interface PreviewTarget {
	subscriber_id: string;
	subscriber_name: string;
	profile: ProfileRow;
	profileNodeIds: string[];
	clients: NodeClientRow[];
	entitlement: SubscriberEntitlement;
}

/**
 * The preview renders for an explicit subscriber or the default one. It does not
 * require a subscription row: an operator checks profile output before issuing a
 * token, which is the point of the preview.
 */
async function loadPreviewTarget(db: D1Database, profileId: string, subscriberId?: string): Promise<PreviewTarget> {
	const profile = await findProfileById(db, profileId);
	if (!profile) throw new AppError('NOT_FOUND', 'Profile not found', 404);

	const resolvedSubscriberId = subscriberId ?? (await getMetaValue(db, META_KEYS.defaultSubscriberId));
	if (!resolvedSubscriberId) {
		throw new AppError('NOT_FOUND', 'Subscriber not found', 404);
	}
	const subscriber = await findSubscriberById(db, resolvedSubscriberId);
	if (!subscriber) throw new AppError('NOT_FOUND', 'Subscriber not found', 404);

	const [nodeIdsResult, clientsResult, usageResult] = await db.batch([
		profileNodeIdsStatement(db, profileId),
		enabledNodeClientsStatement(db, subscriber.id),
		usageStatement(db, subscriber.id),
	]);

	return {
		subscriber_id: subscriber.id,
		subscriber_name: subscriber.name,
		profile,
		profileNodeIds: ((nodeIdsResult?.results as { node_id: string }[] | undefined) ?? []).map((row) => row.node_id),
		clients: (clientsResult?.results as NodeClientRow[] | undefined) ?? [],
		entitlement: {
			status: subscriber.status,
			expires_at: subscriber.expires_at,
			traffic_limit_bytes: subscriber.traffic_limit_bytes,
			usage_cycle_start: subscriber.usage_cycle_start,
			usage: (usageResult?.results as SubscriberUsageRow[] | undefined)?.[0] ?? null,
		},
	};
}

/**
 * Renders the Clash document a profile would distribute, together with the nodes
 * it drops and why. Rendering an empty document is not an error here, so an
 * operator can see that a profile currently distributes nothing.
 */
export async function previewProfile(db: D1Database, profileId: string, subscriberId?: string): Promise<ClashPreview> {
	const target = await loadPreviewTarget(db, profileId, subscriberId);
	const now = nowSeconds();

	const nodeIds = [...new Set(target.clients.map((client) => client.node_id))];
	const nodes = nodeIds.length > 0 ? await findNodesByIds(db, nodeIds) : [];
	const endpoints = nodeIds.length > 0 ? await listEnabledEndpointRowsByNodes(db, nodeIds) : [];

	const previewClients = target.clients.map((client) => ({ ...client, vless_uuid: PREVIEW_UUID }));
	const { proxies, skipped } = buildProxies(target.profile, target.profileNodeIds, previewClients, nodes, endpoints, now);
	const document = renderClashDocument(
		parseObject(target.profile.clash_base_json),
		proxies.map((entry) => entry.proxy as { name: string }),
		parseProxyGroups(target.profile.proxy_groups_json),
		parseRules(target.profile.rules_json),
	);

	return {
		document,
		proxies: proxies.map((entry) => ({ name: String(entry.proxy.name), node_id: entry.node_id })),
		skipped,
		subscriber: {
			id: target.subscriber_id,
			name: target.subscriber_name,
			blocked_reason: subscriberBlockReason(target.entitlement, now),
		},
	};
}
