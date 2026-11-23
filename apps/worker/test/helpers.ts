import { env } from 'cloudflare:test';
import { sha256Hex } from '../src/lib/hash';
import { newId } from '../src/lib/ids';
import type { EndpointProtocol } from '@zako/contracts';
import type { Hysteria2Params } from '../src/protocols/hysteria2';
import type { ShadowsocksParams } from '../src/protocols/shadowsocks';
import type { TrojanParams } from '../src/protocols/trojan';
import type { VlessRealityParams } from '../src/protocols/vless-reality';
import type { VmessParams } from '../src/protocols/vmess';

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export function hourStart(timestamp: number): number {
	return Math.floor(timestamp / 3600) * 3600;
}

/** 43 URL-safe characters, which is the shape the subscription route accepts. */
export function testToken(seed: string): string {
	return seed.repeat(Math.ceil(43 / seed.length)).slice(0, 43);
}

export const DEFAULT_PARAMS: VlessRealityParams = {
	sni: 'www.example.com',
	public_key: 'PUBLIC_KEY_0000000000000000000000000000000000000000',
	short_id: 'abcd1234',
	fingerprint: 'chrome',
	flow: 'xtls-rprx-vision',
	network: 'tcp',
};

export const DEFAULT_VMESS_PARAMS: VmessParams = {
	security: 'tls',
	sni: 'www.example.com',
	network: 'ws',
	path: '/ws',
	host: 'cdn.example.com',
};

export const DEFAULT_TROJAN_PARAMS: TrojanParams = {
	sni: 'www.example.com',
	network: 'tcp',
	path: '',
	host: '',
};

export const DEFAULT_SHADOWSOCKS_PARAMS: ShadowsocksParams = { method: 'aes-256-gcm' };

export const DEFAULT_HYSTERIA2_PARAMS: Hysteria2Params = { sni: 'www.example.com', obfs: 'none', obfs_password: '' };

const DEFAULT_PARAMS_BY_PROTOCOL: Record<EndpointProtocol, Record<string, unknown>> = {
	'vless-reality': DEFAULT_PARAMS,
	vmess: DEFAULT_VMESS_PARAMS,
	trojan: DEFAULT_TROJAN_PARAMS,
	shadowsocks: DEFAULT_SHADOWSOCKS_PARAMS,
	hysteria2: DEFAULT_HYSTERIA2_PARAMS,
};

/** Clears rows between tests; migrations stay applied for the whole file. */
export async function resetDatabase(): Promise<void> {
	const tables = [
		'user_traffic_hourly',
		'site_traffic_hourly',
		'node_traffic_hourly',
		'traffic_reports',
		'subscriber_usage',
		'node_clients',
		'subscriptions',
		'profile_nodes',
		'subscription_profiles',
		'endpoints',
		'nodes',
		'subscribers',
		'node_configs',
		'audit_events',
		'meta',
	];
	await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

export async function seedMeta(key: string, value: string): Promise<void> {
	await env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(key, value).run();
}

export async function readMeta(key: string): Promise<string | null> {
	const row = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(key).first<{ v: string }>();
	return row?.v ?? null;
}

export interface SeedNodeOptions {
	id?: string;
	name?: string;
	secret?: string;
	enabled?: boolean;
	heartbeatIntervalSeconds?: number;
	lastSeenAt?: number | null;
	xrayHealthy?: boolean | null;
	statsHealthy?: boolean | null;
	desiredConfigVersion?: number;
}

export async function seedNode(options: SeedNodeOptions = {}): Promise<string> {
	const id = options.id ?? newId();
	const now = nowSeconds();
	const tokenHash = options.secret ? await sha256Hex(options.secret) : await sha256Hex(newId());
	const lastSeenAt = options.lastSeenAt === undefined ? now : options.lastSeenAt;
	await env.DB.prepare(
		`INSERT INTO nodes
		 (id, name, enabled, agent_token_hash, heartbeat_interval_seconds, last_seen_at,
		  xray_healthy, stats_healthy, desired_config_version, applied_config_version, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
	)
		.bind(
			id,
			options.name ?? `node-${id.slice(-6)}`,
			options.enabled === false ? 0 : 1,
			tokenHash,
			options.heartbeatIntervalSeconds ?? 300,
			lastSeenAt,
			options.xrayHealthy === undefined ? 1 : options.xrayHealthy === null ? null : options.xrayHealthy ? 1 : 0,
			options.statsHealthy === undefined ? 1 : options.statsHealthy === null ? null : options.statsHealthy ? 1 : 0,
			options.desiredConfigVersion ?? 0,
			now,
			now,
		)
		.run();
	return id;
}

export interface SeedEndpointOptions {
	id?: string;
	name?: string;
	host?: string;
	port?: number;
	protocol?: EndpointProtocol;
	params?: Record<string, unknown>;
	enabled?: boolean;
}

export async function seedEndpoint(nodeId: string, options: SeedEndpointOptions = {}): Promise<string> {
	const id = options.id ?? newId();
	const now = nowSeconds();
	const protocol = options.protocol ?? 'vless-reality';
	await env.DB.prepare(
		`INSERT INTO endpoints (id, node_id, name, protocol, host, port, params_json, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			nodeId,
			options.name ?? `endpoint-${id.slice(-4)}`,
			protocol,
			options.host ?? '203.0.113.10',
			options.port ?? 443,
			JSON.stringify(options.params ?? DEFAULT_PARAMS_BY_PROTOCOL[protocol]),
			options.enabled === false ? 0 : 1,
			now,
			now,
		)
		.run();
	return id;
}

export interface SeedSubscriberOptions {
	id?: string;
	name?: string;
	status?: 'active' | 'limited' | 'expired' | 'disabled';
	trafficLimitBytes?: number | null;
	expiresAt?: number | null;
	usageCycleStart?: number;
	usageCycleEnd?: number;
}

export async function seedSubscriber(options: SeedSubscriberOptions = {}): Promise<string> {
	const id = options.id ?? newId();
	const now = nowSeconds();
	const cycleStart = options.usageCycleStart ?? now - 86_400;
	await env.DB.prepare(
		`INSERT INTO subscribers
		 (id, name, email, status, traffic_limit_bytes, expires_at, usage_cycle_start, usage_cycle_end, created_at, updated_at)
		 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			options.name ?? 'subscriber',
			options.status ?? 'active',
			options.trafficLimitBytes ?? null,
			options.expiresAt ?? null,
			cycleStart,
			options.usageCycleEnd ?? cycleStart + 30 * 86_400,
			now,
			now,
		)
		.run();
	return id;
}

export interface SeedNodeClientOptions {
	id?: string;
	xrayEmail?: string;
	uuid?: string;
	enabled?: boolean;
}

export async function seedNodeClient(
	nodeId: string,
	subscriberId: string,
	options: SeedNodeClientOptions = {},
): Promise<{ id: string; xrayEmail: string; uuid: string }> {
	const id = options.id ?? newId();
	const xrayEmail = options.xrayEmail ?? `u_${newId()}`;
	const uuid = options.uuid ?? crypto.randomUUID();
	const now = nowSeconds();
	await env.DB.prepare(
		`INSERT INTO node_clients
		 (id, node_id, subscriber_id, xray_email, vless_uuid, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, nodeId, subscriberId, xrayEmail, uuid, options.enabled === false ? 0 : 1, now, now)
		.run();
	return { id, xrayEmail, uuid };
}

export interface SeedProfileOptions {
	id?: string;
	name?: string;
	nodeSelection?: 'all' | 'selected';
	onlineOnly?: boolean;
	clashBase?: Record<string, unknown>;
	proxyGroups?: unknown[];
	rules?: string[];
	nodeIds?: string[];
}

export async function seedProfile(options: SeedProfileOptions = {}): Promise<string> {
	const id = options.id ?? newId();
	const now = nowSeconds();
	await env.DB.prepare(
		`INSERT INTO subscription_profiles
		 (id, name, description, node_selection, online_only, clash_base_json, proxy_groups_json,
		  rules_json, revision, created_at, updated_at)
		 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`,
	)
		.bind(
			id,
			options.name ?? `profile-${id.slice(-6)}`,
			options.nodeSelection ?? 'all',
			options.onlineOnly === false ? 0 : 1,
			JSON.stringify(options.clashBase ?? {}),
			JSON.stringify(options.proxyGroups ?? []),
			JSON.stringify(options.rules ?? []),
			now,
			now,
		)
		.run();
	for (const nodeId of options.nodeIds ?? []) {
		await env.DB.prepare('INSERT INTO profile_nodes (profile_id, node_id) VALUES (?, ?)').bind(id, nodeId).run();
	}
	return id;
}

export interface SeedSubscriptionOptions {
	id?: string;
	name?: string;
	token: string;
	subscriberId: string;
	profileId: string;
	revokedAt?: number | null;
	expiresAt?: number | null;
}

export async function seedSubscription(options: SeedSubscriptionOptions): Promise<string> {
	const id = options.id ?? newId();
	const now = nowSeconds();
	const tokenHash = await sha256Hex(options.token);
	await env.DB.prepare(
		`INSERT INTO subscriptions (id, subscriber_id, profile_id, name, token_hash, revoked_at, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			options.subscriberId,
			options.profileId,
			options.name ?? 'subscription',
			tokenHash,
			options.revokedAt ?? null,
			options.expiresAt ?? null,
			now,
		)
		.run();
	return id;
}

export async function seedSubscriberUsage(subscriberId: string, cycleStart: number, uplink: number, downlink: number): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO subscriber_usage (subscriber_id, cycle_start, uplink_bytes, downlink_bytes, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(subscriberId, cycleStart, uplink, downlink, nowSeconds())
		.run();
}

export interface SeededSubscription {
	token: string;
	subscriberId: string;
	profileId: string;
	nodeId: string;
	nodeClient: { xrayEmail: string; uuid: string };
	endpointId: string;
}

export interface SeedDistributionOptions {
	onlineOnly?: boolean;
	nodeSelection?: 'all' | 'selected';
	profileNodeIds?: string[];
	subscriberStatus?: 'active' | 'limited' | 'expired' | 'disabled';
	subscriberExpiresAt?: number | null;
	trafficLimitBytes?: number | null;
	scope?: string;
}

/** Seeds one online node with one endpoint and a granted subscriber. */
export async function seedDistribution(options: SeedDistributionOptions = {}): Promise<SeededSubscription> {
	const nodeId = await seedNode({ name: `Tokyo-${options.scope ?? newId().slice(-4)}` });
	const endpointId = await seedEndpoint(nodeId, { name: 'primary' });
	const subscriberId = await seedSubscriber({
		status: options.subscriberStatus,
		expiresAt: options.subscriberExpiresAt,
		trafficLimitBytes: options.trafficLimitBytes,
	});
	const nodeClient = await seedNodeClient(nodeId, subscriberId);
	const profileId = await seedProfile({
		nodeSelection: options.nodeSelection,
		onlineOnly: options.onlineOnly,
		nodeIds: options.profileNodeIds ?? (options.nodeSelection === 'selected' ? [nodeId] : []),
	});
	const token = testToken(options.scope ?? 'a');
	await seedSubscription({ token, subscriberId, profileId });
	return { token, subscriberId, profileId, nodeId, nodeClient, endpointId };
}
