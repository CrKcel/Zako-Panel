import { sqlPlaceholders } from '../lib/sql';

export interface SubscriberRow {
	id: string;
	name: string;
	email: string | null;
	status: 'active' | 'limited' | 'expired' | 'disabled';
	traffic_limit_bytes: number | null;
	expires_at: number | null;
	usage_cycle_start: number;
	usage_cycle_end: number;
	created_at: number;
	updated_at: number;
}

export interface NodeClientRow {
	id: string;
	node_id: string;
	subscriber_id: string;
	xray_email: string;
	vless_uuid: string;
	enabled: number;
	created_at: number;
	updated_at: number;
}

export interface SubscriberUsageRow {
	subscriber_id: string;
	cycle_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}

export interface NewNodeClientRow {
	id: string;
	node_id: string;
	subscriber_id: string;
	xray_email: string;
	vless_uuid: string;
	now: number;
}

const SUBSCRIBER_COLUMNS = `id, name, email, status, traffic_limit_bytes, expires_at,
	usage_cycle_start, usage_cycle_end, created_at, updated_at`;

export async function findSubscriberById(db: D1Database, subscriberId: string): Promise<SubscriberRow | null> {
	const row = await db
		.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE id = ? LIMIT 1`)
		.bind(subscriberId)
		.first<SubscriberRow>();
	return row ?? null;
}

export async function findSubscribersByIds(db: D1Database, subscriberIds: string[]): Promise<SubscriberRow[]> {
	if (subscriberIds.length === 0) return [];
	return (
		await db
			.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE id IN (${sqlPlaceholders(subscriberIds.length)})`)
			.bind(...subscriberIds)
			.all<SubscriberRow>()
	).results;
}

export async function findNodeClientsByNodeAndEmails(db: D1Database, nodeId: string, emails: string[]): Promise<NodeClientRow[]> {
	if (emails.length === 0) return [];
	return (
		await db
			.prepare(
				`SELECT id, node_id, subscriber_id, xray_email, vless_uuid, enabled, created_at, updated_at
				 FROM node_clients
				 WHERE node_id = ? AND xray_email IN (${sqlPlaceholders(emails.length)})`,
			)
			.bind(nodeId, ...emails)
			.all<NodeClientRow>()
	).results;
}

export function enabledNodeClientsStatement(db: D1Database, subscriberId: string): D1PreparedStatement {
	return db
		.prepare(
			`SELECT id, node_id, subscriber_id, xray_email, vless_uuid, enabled, created_at, updated_at
			 FROM node_clients
			 WHERE subscriber_id = ? AND enabled = 1`,
		)
		.bind(subscriberId);
}

export interface NodeClientUsageRow {
	subscriber_id: string;
	xray_email: string;
	usage_cycle_start: number;
}

/**
 * Joins credentials with their subscriber in one statement so a report needs no
 * second lookup to learn the current usage cycle.
 */
export function nodeClientUsageMapStatement(db: D1Database, nodeId: string, emails: string[]): D1PreparedStatement {
	if (emails.length === 0) {
		return db
			.prepare(
				`SELECT nc.subscriber_id, nc.xray_email, s.usage_cycle_start
				 FROM node_clients nc JOIN subscribers s ON s.id = nc.subscriber_id
				 WHERE nc.node_id = ? AND 0 = 1`,
			)
			.bind(nodeId);
	}
	return db
		.prepare(
			`SELECT nc.subscriber_id, nc.xray_email, s.usage_cycle_start
			 FROM node_clients nc JOIN subscribers s ON s.id = nc.subscriber_id
			 WHERE nc.node_id = ? AND nc.xray_email IN (${sqlPlaceholders(emails.length)})`,
		)
		.bind(nodeId, ...emails);
}

export async function findEnabledNodeClientsBySubscriber(db: D1Database, subscriberId: string): Promise<NodeClientRow[]> {
	return (await enabledNodeClientsStatement(db, subscriberId).all<NodeClientRow>()).results;
}

export function insertNodeClientStatement(db: D1Database, client: NewNodeClientRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO node_clients (id, node_id, subscriber_id, xray_email, vless_uuid, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
		)
		.bind(client.id, client.node_id, client.subscriber_id, client.xray_email, client.vless_uuid, client.now, client.now);
}

export function usageStatement(db: D1Database, subscriberId: string): D1PreparedStatement {
	return db
		.prepare(
			`SELECT subscriber_id, cycle_start, uplink_bytes, downlink_bytes, updated_at
			 FROM subscriber_usage WHERE subscriber_id = ? LIMIT 1`,
		)
		.bind(subscriberId);
}

export async function findUsageBySubscribers(db: D1Database, subscriberIds: string[]): Promise<SubscriberUsageRow[]> {
	if (subscriberIds.length === 0) return [];
	return (
		await db
			.prepare(
				`SELECT subscriber_id, cycle_start, uplink_bytes, downlink_bytes, updated_at
				 FROM subscriber_usage
				 WHERE subscriber_id IN (${sqlPlaceholders(subscriberIds.length)})`,
			)
			.bind(...subscriberIds)
			.all<SubscriberUsageRow>()
	).results;
}
