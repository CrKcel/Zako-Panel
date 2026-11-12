import type { CreateSubscriptionRequest, ProxyGroup, Subscription } from '@zako/contracts';
import { AppError } from '../lib/errors';
import { sha256Hex } from '../lib/hash';
import { newId } from '../lib/ids';
import { isHeartbeatFresh, nowSeconds } from '../lib/node-status';
import { generateToken } from '../lib/token';
import { vlessRealityAdapter, vlessRealityParamsSchema } from '../protocols/vless-reality';
import type { ProxyEndpoint } from '../protocols/types';
import { renderClashDocument } from '../renderers/clash';
import { renderUriDocument } from '../renderers/uri';
import type { EndpointRow } from '../repositories/endpoints';
import { enabledEndpointsByNodesStatement } from '../repositories/endpoints';
import type { NodeRow } from '../repositories/nodes';
import { findNodesByIdsStatement } from '../repositories/nodes';
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

function effectiveUsage(usage: SubscriberUsageRow | null, cycleStart: number): { uplink: number; downlink: number } {
	if (!usage || usage.cycle_start < cycleStart) return { uplink: 0, downlink: 0 };
	return { uplink: usage.uplink_bytes, downlink: usage.downlink_bytes };
}

interface DistributionContext {
	subscription: SubscriptionLookupRow;
	profile: ProfileRow;
	profileNodeIds: string[];
	clients: NodeClientRow[];
	usage: SubscriberUsageRow | null;
}

async function loadDistribution(db: D1Database, token: string): Promise<DistributionContext> {
	const hash = await sha256Hex(token);
	const subscription = await findSubscriptionByTokenHash(db, hash);
	if (!subscription) throw invalidToken();

	const now = nowSeconds();
	if (subscription.revoked_at !== null) throw invalidToken();
	if (subscription.expires_at !== null && subscription.expires_at <= now) {
		throw forbidden('Subscription has expired');
	}
	if (subscription.subscriber_status !== 'active') throw forbidden('Subscriber is not active');
	if (subscription.subscriber_expires_at !== null && subscription.subscriber_expires_at <= now) {
		throw forbidden('Subscriber has expired');
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

	const used = effectiveUsage(usage, subscription.subscriber_usage_cycle_start);
	const limit = subscription.subscriber_traffic_limit_bytes;
	if (limit !== null && used.uplink + used.downlink >= limit) {
		throw forbidden('Subscriber traffic limit reached');
	}

	return { subscription, profile, profileNodeIds, clients, usage };
}

interface RenderableProxy {
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

function buildProxies(context: DistributionContext, nodes: NodeRow[], endpoints: EndpointRow[], now: number): RenderableProxy[] {
	const onlineOnly = context.profile.online_only === 1;
	const selected = context.profile.node_selection === 'selected' ? new Set(context.profileNodeIds) : null;
	const nodesById = new Map(nodes.map((node) => [node.id, node]));
	const endpointsByNode = new Map<string, EndpointRow[]>();
	for (const endpoint of endpoints) {
		const list = endpointsByNode.get(endpoint.node_id);
		if (list) list.push(endpoint);
		else endpointsByNode.set(endpoint.node_id, [endpoint]);
	}

	const usedNames = new Set<string>();
	const proxies: RenderableProxy[] = [];
	for (const client of context.clients) {
		if (client.enabled !== 1) continue;
		const node = nodesById.get(client.node_id);
		if (!node || node.enabled !== 1) continue;
		if (selected && !selected.has(node.id)) continue;
		if (onlineOnly && !isHeartbeatFresh(node.last_seen_at, node.heartbeat_interval_seconds, now)) continue;
		// stats_healthy=0 still distributes so a broken stats API does not hide every node.
		if (node.xray_healthy !== 1) continue;

		const nodeEndpoints = endpointsByNode.get(node.id) ?? [];
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
			proxies.push({
				proxy: vlessRealityAdapter.toClash(proxyEndpoint, client.vless_uuid),
				uri: vlessRealityAdapter.toUri(proxyEndpoint, client.vless_uuid),
			});
		}
	}
	return proxies;
}

async function loadNodesAndEndpoints(db: D1Database, context: DistributionContext, now: number): Promise<RenderableProxy[]> {
	const allowed = new Set(context.clients.map((client) => client.node_id));
	if (context.profile.node_selection === 'selected') {
		for (const nodeId of allowed) {
			if (!context.profileNodeIds.includes(nodeId)) allowed.delete(nodeId);
		}
	}
	if (allowed.size === 0) throw unavailable();

	const nodeIds = [...allowed];
	const [nodeResult, endpointResult] = await db.batch([
		findNodesByIdsStatement(db, nodeIds),
		enabledEndpointsByNodesStatement(db, nodeIds),
	]);
	const nodes = (nodeResult?.results as NodeRow[] | undefined) ?? [];
	const endpoints = (endpointResult?.results as EndpointRow[] | undefined) ?? [];
	const proxies = buildProxies(context, nodes, endpoints, now);
	if (proxies.length === 0) throw unavailable();
	return proxies;
}

function subscriptionHeaders(context: DistributionContext, fileName: string): Record<string, string> {
	const used = effectiveUsage(context.usage, context.subscription.subscriber_usage_cycle_start);
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
