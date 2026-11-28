import type { ClashPreview, DistributionSkipReason, Profile, SubscriberBlockReason } from '@zako/contracts';
import { AppError } from '../lib/errors';
import { isHeartbeatFresh, nowSeconds } from '../lib/node-status';
import { subscriberBlockReason, type EntitlementInput } from '../lib/subscriber-status';
import { getProtocolAdapter } from '../protocols';
import type { ProxyEndpoint } from '../protocols/types';
import { renderClashDocument, type RenderProxy } from '../renderers/clash';
import { listAllEnabledEndpointsStatement, type EndpointRow } from '../repositories/endpoints';
import { getMetaValue, META_KEYS } from '../repositories/meta';
import { listAllNodesStatement, type NodeRow } from '../repositories/nodes';
import { findProfileById, findProfileStatement, profileNodeIdsStatement, type ProfileRow } from '../repositories/profiles';
import { findFirstSubscriber, findSubscriberById, usageStatement, type SubscriberUsageRow } from '../repositories/subscribers';
import { findSubscriptionByToken, type SubscriptionLookupRow } from '../repositories/subscriptions';
import { toProfile } from './profile-mapping';

/**
 * Previews render credentials as a placeholder. The profile preview exists to
 * validate names, groups and rules; keeping the real credential out of it keeps
 * docs/security.md's allowed surfaces for proxy credentials unchanged.
 */
const PREVIEW_SECRET = '00000000-0000-0000-0000-000000000000';

export interface RenderableProxy {
	node_id: string;
	proxy: RenderProxy;
	uri: string;
}

export interface SkippedNode {
	node_id: string;
	node_name: string;
	reason: DistributionSkipReason;
}

export interface Distribution {
	proxies: RenderableProxy[];
	skipped: SkippedNode[];
}

/** Everything one subscription request may read, loaded in a single D1 batch. */
export interface DistributionContext {
	subscription: SubscriptionLookupRow;
	profile: Profile;
	profileNodeIds: string[];
	usage: SubscriberUsageRow | null;
}

function invalidToken(): AppError {
	return new AppError('SUBSCRIPTION_INVALID', 'Subscription token is invalid', 401);
}

function forbidden(message: string): AppError {
	return new AppError('FORBIDDEN', message, 403);
}

const BLOCK_MESSAGES: Record<SubscriberBlockReason, string> = {
	inactive: 'Subscriber is not active',
	expired: 'Subscriber has expired',
	over_quota: 'Subscriber traffic limit reached',
};

function entitlementOf(row: SubscriptionLookupRow, usage: SubscriberUsageRow | null): EntitlementInput {
	return {
		status: row.subscriber_status,
		expires_at: row.subscriber_expires_at,
		traffic_limit_bytes: row.subscriber_traffic_limit_bytes,
		usage_cycle_start: row.subscriber_usage_cycle_start,
		usage,
	};
}

/**
 * Resolves a subscription token to the data needed downstream. Entitlement is
 * checked live from the stored expiry and usage instead of the cron-materialised
 * status, so a quota reset or a renewed expiry takes effect on the next request.
 */
export async function loadDistributionContext(db: D1Database, token: string): Promise<DistributionContext> {
	const subscription = await findSubscriptionByToken(db, token);
	if (!subscription) throw invalidToken();

	const now = nowSeconds();
	if (subscription.revoked_at !== null) throw invalidToken();
	if (subscription.expires_at !== null && subscription.expires_at <= now) {
		throw forbidden('Subscription has expired');
	}

	const [profileResult, nodeIdsResult, usageResult] = await db.batch([
		findProfileStatement(db, subscription.profile_id),
		profileNodeIdsStatement(db, subscription.profile_id),
		usageStatement(db, subscription.subscriber_id),
	]);

	const profileRow = (profileResult?.results as ProfileRow[] | undefined)?.[0];
	if (!profileRow) throw forbidden('Subscription profile is no longer available');
	const profileNodeIds = ((nodeIdsResult?.results as { node_id: string }[] | undefined) ?? []).map((row) => row.node_id);
	const usage = (usageResult?.results as SubscriberUsageRow[] | undefined)?.[0] ?? null;

	const blocked = subscriberBlockReason(entitlementOf(subscription, usage), now);
	if (blocked) throw forbidden(BLOCK_MESSAGES[blocked]);

	return { subscription, profile: toProfile(profileRow), profileNodeIds, usage };
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

/**
 * Applies the profile distribution rules across all nodes. Both serving and
 * preview use this path so a preview cannot show a node that a real subscription
 * drops. The checks run in the documented order, and the first failing rule is
 * the one reported for a skipped node. An endpoint whose protocol has no adapter
 * is not renderable and is reported as `no_endpoint`, matching "no usable
 * endpoint".
 */
function buildProxies(
	profile: Profile,
	profileNodeIds: string[],
	secret: string,
	nodes: NodeRow[],
	endpoints: EndpointRow[],
	now: number,
): Distribution {
	const onlineOnly = profile.online_only;
	const selected = profile.node_selection === 'selected' ? new Set(profileNodeIds) : null;
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

	for (const node of nodes) {
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
			const adapter = getProtocolAdapter(endpoint.protocol);
			if (!adapter) continue;
			const params = adapter.paramsSchema.safeParse(JSON.parse(endpoint.params_json) as unknown);
			if (!params.success) continue;
			const baseName = nodeEndpoints.length === 1 ? node.name : `${node.name}-${endpoint.name}`;
			const proxyEndpoint: ProxyEndpoint = {
				id: endpoint.id,
				name: uniqueName(baseName, usedNames),
				protocol: endpoint.protocol,
				host: endpoint.host,
				port: endpoint.port,
				params: params.data as Record<string, unknown>,
			};
			const credential = { secret };
			rendered.push({
				node_id: node.id,
				proxy: adapter.toClash(proxyEndpoint, credential) as RenderProxy,
				uri: adapter.toUri(proxyEndpoint, credential),
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

async function loadNodesAndEndpoints(db: D1Database): Promise<{ nodes: NodeRow[]; endpoints: EndpointRow[] }> {
	const [nodeResult, endpointResult] = await db.batch([listAllNodesStatement(db), listAllEnabledEndpointsStatement(db)]);
	return {
		nodes: (nodeResult?.results as NodeRow[] | undefined) ?? [],
		endpoints: (endpointResult?.results as EndpointRow[] | undefined) ?? [],
	};
}

/** Resolves the nodes and applies the profile's distribution rules. */
export async function distribute(db: D1Database, context: DistributionContext): Promise<Distribution> {
	const { nodes, endpoints } = await loadNodesAndEndpoints(db);
	return buildProxies(context.profile, context.profileNodeIds, context.subscription.subscriber_vless_uuid, nodes, endpoints, nowSeconds());
}

/** Renders the Clash document for a profile and its distributable proxies. */
export function renderClashDocumentFor(profile: Profile, proxies: RenderableProxy[]): string {
	return renderClashDocument(
		profile.clash_base,
		proxies.map((entry) => entry.proxy),
		profile.proxy_groups,
		profile.rules,
	);
}

interface PreviewTarget {
	subscriber_id: string;
	subscriber_name: string;
	profile: Profile;
	profileNodeIds: string[];
	entitlement: EntitlementInput;
}

/**
 * The preview renders for an explicit subscriber, the configured default
 * subscriber, or the first non-disabled subscriber. It does not require a
 * subscription row: an operator checks profile output before issuing a token,
 * which is the point of the preview.
 */
async function loadPreviewTarget(db: D1Database, profileId: string, subscriberId?: string): Promise<PreviewTarget> {
	const profileRow = await findProfileById(db, profileId);
	if (!profileRow) throw new AppError('NOT_FOUND', 'Profile not found', 404);

	let subscriber = null;
	if (subscriberId !== undefined) {
		subscriber = await findSubscriberById(db, subscriberId);
	} else {
		const defaultId = await getMetaValue(db, META_KEYS.defaultSubscriberId);
		if (defaultId) subscriber = await findSubscriberById(db, defaultId);
		if (!subscriber) subscriber = await findFirstSubscriber(db);
	}
	if (!subscriber) throw new AppError('NOT_FOUND', 'Subscriber not found', 404);

	const [nodeIdsResult, usageResult] = await db.batch([profileNodeIdsStatement(db, profileId), usageStatement(db, subscriber.id)]);
	const usage = (usageResult?.results as SubscriberUsageRow[] | undefined)?.[0] ?? null;

	return {
		subscriber_id: subscriber.id,
		subscriber_name: subscriber.name,
		profile: toProfile(profileRow),
		profileNodeIds: ((nodeIdsResult?.results as { node_id: string }[] | undefined) ?? []).map((row) => row.node_id),
		entitlement: {
			status: subscriber.status,
			expires_at: subscriber.expires_at,
			traffic_limit_bytes: subscriber.traffic_limit_bytes,
			usage_cycle_start: subscriber.usage_cycle_start,
			usage,
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
	const { nodes, endpoints } = await loadNodesAndEndpoints(db);
	const { proxies, skipped } = buildProxies(target.profile, target.profileNodeIds, PREVIEW_SECRET, nodes, endpoints, now);

	return {
		document: renderClashDocumentFor(target.profile, proxies),
		proxies: proxies.map((entry) => ({ name: entry.proxy.name, node_id: entry.node_id })),
		skipped,
		subscriber: {
			id: target.subscriber_id,
			name: target.subscriber_name,
			blocked_reason: subscriberBlockReason(target.entitlement, now),
		},
	};
}
