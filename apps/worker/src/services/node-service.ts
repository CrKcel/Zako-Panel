import type {
	CreateEndpointRequest,
	CreateNodeRequest,
	Endpoint,
	Node,
	NodeClient,
	NodeStatusDetail,
	SysStats,
	UpdateEndpointRequest,
	UpdateNodeRequest,
} from '@zako/contracts';
import { isUniqueConstraintError } from '../lib/db-errors';
import { AppError } from '../lib/errors';
import { sha256Hex } from '../lib/hash';
import { newId, newXrayEmail } from '../lib/ids';
import { deriveNodeStatus, nowSeconds } from '../lib/node-status';
import { generateToken } from '../lib/token';
import { DEFAULT_PROTOCOL, requireProtocolAdapter } from '../protocols';
import {
	disableEndpoint as disableEndpointRow,
	type EndpointRow,
	findEndpointById,
	insertEndpointStatement,
	listEndpointRowsByNode,
	updateEndpoint as updateEndpointRow,
} from '../repositories/endpoints';
import { getMetaValue, META_KEYS } from '../repositories/meta';
import {
	findNodeById,
	insertNodeStatement,
	listNodeRows,
	updateAgentTokenHash,
	updateNode as updateNodeRow,
	type NodeRow,
} from '../repositories/nodes';
import { findSubscriberById, insertNodeClientStatement, listNodeClientRowsByNode } from '../repositories/subscribers';
import type { ListQuery, Paginated } from '../types';
import { bumpUsersVersionStatement } from './users-version';

export interface CreateNodeResult {
	node: Node;
	endpoint: Endpoint;
	agent_token: string;
}

function parseSysStats(sysJson: string | null): SysStats | null {
	if (!sysJson) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(sysJson) as unknown;
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const value = parsed as Record<string, unknown>;
	if (
		typeof value.cpu !== 'number' ||
		typeof value.mem !== 'number' ||
		typeof value.load !== 'number' ||
		typeof value.uptime !== 'number'
	) {
		return null;
	}
	return { cpu: value.cpu, mem: value.mem, load: value.load, uptime: value.uptime };
}

function optionalBoolean(value: number | null): boolean | null {
	return value === null ? null : value === 1;
}

function toNode(row: NodeRow, now: number): Node {
	return {
		id: row.id,
		name: row.name,
		enabled: row.enabled === 1,
		status: deriveNodeStatus(
			{
				enabled: row.enabled === 1,
				last_seen_at: row.last_seen_at,
				heartbeat_interval_seconds: row.heartbeat_interval_seconds,
				xray_healthy: optionalBoolean(row.xray_healthy),
				stats_healthy: optionalBoolean(row.stats_healthy),
			},
			now,
		),
		heartbeat_interval_seconds: row.heartbeat_interval_seconds,
		last_seen_at: row.last_seen_at,
		xray_healthy: optionalBoolean(row.xray_healthy),
		stats_healthy: optionalBoolean(row.stats_healthy),
		agent_version: row.agent_version,
		xray_version: row.xray_version,
		sys: parseSysStats(row.sys_json),
		desired_config_version: row.desired_config_version,
		applied_config_version: row.applied_config_version,
		last_config_error: row.last_config_error,
		last_config_at: row.last_config_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function toEndpoint(row: EndpointRow): Endpoint {
	const adapter = requireProtocolAdapter(row.protocol);
	const params = adapter.paramsSchema.safeParse(JSON.parse(row.params_json) as unknown);
	if (!params.success) {
		throw new AppError('INTERNAL_ERROR', 'Stored endpoint parameters are invalid', 500);
	}
	return {
		id: row.id,
		node_id: row.node_id,
		name: row.name,
		// The protocol registry is the single source of truth for endpoint shapes.
		protocol: DEFAULT_PROTOCOL,
		host: row.host,
		port: row.port,
		params: params.data as Endpoint['params'],
		enabled: row.enabled === 1,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function nodeNotFound(): AppError {
	return new AppError('NODE_NOT_FOUND', 'Node not found', 404);
}

export async function listNodes(db: D1Database, query: ListQuery): Promise<Paginated<Node>> {
	const rows = await listNodeRows(db, query.limit + 1, query.cursor);
	const hasMore = rows.length > query.limit;
	const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
	const now = nowSeconds();
	const items = pageRows.map((row) => toNode(row, now));
	const last = items[items.length - 1];
	return { items, next_cursor: hasMore && last ? last.id : null };
}

export async function createNode(db: D1Database, input: CreateNodeRequest): Promise<CreateNodeResult> {
	const now = nowSeconds();
	const nodeId = newId();
	const endpointId = newId();
	const secret = generateToken();
	const tokenHash = await sha256Hex(secret);
	const heartbeatInterval = input.heartbeat_interval_seconds ?? 300;

	const defaultSubscriberId = await getMetaValue(db, META_KEYS.defaultSubscriberId);
	const defaultSubscriber = defaultSubscriberId ? await findSubscriberById(db, defaultSubscriberId) : null;

	const nodeRow: NodeRow = {
		id: nodeId,
		name: input.name,
		enabled: 1,
		heartbeat_interval_seconds: heartbeatInterval,
		last_seen_at: null,
		xray_healthy: null,
		stats_healthy: null,
		agent_version: null,
		xray_version: null,
		sys_json: null,
		desired_config_version: 0,
		applied_config_version: 0,
		last_config_error: null,
		last_config_at: null,
		created_at: now,
		updated_at: now,
	};

	const statements = [
		insertNodeStatement(db, {
			id: nodeId,
			name: input.name,
			agent_token_hash: tokenHash,
			heartbeat_interval_seconds: heartbeatInterval,
			now,
		}),
		insertEndpointStatement(db, {
			id: endpointId,
			node_id: nodeId,
			name: input.endpoint.name,
			protocol: DEFAULT_PROTOCOL,
			host: input.endpoint.host,
			port: input.endpoint.port,
			params_json: JSON.stringify(input.endpoint.params),
			now,
		}),
		bumpUsersVersionStatement(db),
	];
	if (defaultSubscriber) {
		statements.push(
			insertNodeClientStatement(db, {
				id: newId(),
				node_id: nodeId,
				subscriber_id: defaultSubscriber.id,
				xray_email: newXrayEmail(),
				vless_uuid: crypto.randomUUID(),
				now,
			}),
		);
	}

	try {
		await db.batch(statements);
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw new AppError('CONFLICT', 'Node name already exists', 409);
		}
		throw error;
	}

	const endpointRow: EndpointRow = {
		id: endpointId,
		node_id: nodeId,
		name: input.endpoint.name,
		protocol: DEFAULT_PROTOCOL,
		host: input.endpoint.host,
		port: input.endpoint.port,
		params_json: JSON.stringify(input.endpoint.params),
		enabled: 1,
		created_at: now,
		updated_at: now,
	};

	return {
		node: toNode(nodeRow, now),
		endpoint: toEndpoint(endpointRow),
		agent_token: `${nodeId}.${secret}`,
	};
}

export async function getNode(db: D1Database, nodeId: string): Promise<{ node: Node; endpoints: Endpoint[] }> {
	const row = await findNodeById(db, nodeId);
	if (!row) throw nodeNotFound();
	const endpointRows = await listEndpointRowsByNode(db, nodeId);
	return { node: toNode(row, nowSeconds()), endpoints: endpointRows.map(toEndpoint) };
}

export async function updateNode(db: D1Database, nodeId: string, input: UpdateNodeRequest): Promise<Node> {
	const existing = await findNodeById(db, nodeId);
	if (!existing) throw nodeNotFound();
	try {
		await updateNodeRow(
			db,
			nodeId,
			{
				name: input.name,
				enabled: input.enabled,
				heartbeat_interval_seconds: input.heartbeat_interval_seconds,
			},
			nowSeconds(),
		);
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw new AppError('CONFLICT', 'Node name already exists', 409);
		}
		throw error;
	}
	const updated = await findNodeById(db, nodeId);
	if (!updated) throw nodeNotFound();
	return toNode(updated, nowSeconds());
}

export async function rotateAgentToken(db: D1Database, nodeId: string): Promise<{ agent_token: string }> {
	const existing = await findNodeById(db, nodeId);
	if (!existing) throw nodeNotFound();
	const secret = generateToken();
	const tokenHash = await sha256Hex(secret);
	await updateAgentTokenHash(db, nodeId, tokenHash, nowSeconds());
	return { agent_token: `${nodeId}.${secret}` };
}

export async function getNodeStatus(db: D1Database, nodeId: string): Promise<NodeStatusDetail> {
	const row = await findNodeById(db, nodeId);
	if (!row) throw nodeNotFound();
	const node = toNode(row, nowSeconds());
	return {
		node_id: node.id,
		status: node.status,
		heartbeat_interval_seconds: node.heartbeat_interval_seconds,
		last_seen_at: node.last_seen_at,
		xray_healthy: node.xray_healthy,
		stats_healthy: node.stats_healthy,
		agent_version: node.agent_version,
		xray_version: node.xray_version,
		last_config_error: node.last_config_error,
	};
}

export async function listEndpoints(db: D1Database, nodeId: string): Promise<Endpoint[]> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();
	const rows = await listEndpointRowsByNode(db, nodeId);
	return rows.map(toEndpoint);
}

/**
 * Exposes the credentials a node-local inbound must contain. P0 has no user
 * sync, so without this the operator cannot make statistics keys and inbound
 * client emails agree and every user bucket is attributed as unknown.
 */
export async function listNodeClients(db: D1Database, nodeId: string): Promise<NodeClient[]> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();
	const rows = await listNodeClientRowsByNode(db, nodeId);
	return rows.map((row) => ({
		id: row.id,
		node_id: row.node_id,
		subscriber_id: row.subscriber_id,
		subscriber_name: row.subscriber_name,
		xray_email: row.xray_email,
		vless_uuid: row.vless_uuid,
		enabled: row.enabled === 1,
	}));
}

export async function createEndpoint(db: D1Database, nodeId: string, input: CreateEndpointRequest): Promise<Endpoint> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();
	const now = nowSeconds();
	const endpointId = newId();
	try {
		await insertEndpointStatement(db, {
			id: endpointId,
			node_id: nodeId,
			name: input.name,
			protocol: DEFAULT_PROTOCOL,
			host: input.host,
			port: input.port,
			params_json: JSON.stringify(input.params),
			now,
		}).run();
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw new AppError('CONFLICT', 'Endpoint name already exists', 409);
		}
		throw error;
	}
	const row = await findEndpointById(db, nodeId, endpointId);
	if (!row) throw new AppError('INTERNAL_ERROR', 'Endpoint was not persisted', 500);
	return toEndpoint(row);
}

export async function updateEndpoint(db: D1Database, nodeId: string, endpointId: string, input: UpdateEndpointRequest): Promise<Endpoint> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();
	const existing = await findEndpointById(db, nodeId, endpointId);
	if (!existing) throw new AppError('NOT_FOUND', 'Endpoint not found', 404);
	try {
		await updateEndpointRow(
			db,
			nodeId,
			endpointId,
			{
				name: input.name,
				host: input.host,
				port: input.port,
				params_json: input.params === undefined ? undefined : JSON.stringify(input.params),
				enabled: input.enabled,
			},
			nowSeconds(),
		);
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw new AppError('CONFLICT', 'Endpoint name already exists', 409);
		}
		throw error;
	}
	const updated = await findEndpointById(db, nodeId, endpointId);
	if (!updated) throw new AppError('NOT_FOUND', 'Endpoint not found', 404);
	return toEndpoint(updated);
}

export async function disableEndpoint(db: D1Database, nodeId: string, endpointId: string): Promise<void> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();
	const changed = await disableEndpointRow(db, nodeId, endpointId, nowSeconds());
	if (!changed) throw new AppError('NOT_FOUND', 'Endpoint not found', 404);
}
