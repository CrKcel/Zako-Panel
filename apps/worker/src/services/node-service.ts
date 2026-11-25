import type {
	AgentUpdateResult,
	Endpoint,
	EndpointProtocol,
	Node,
	NodeClient,
	NodeStatusDetail,
	SysStats,
	UpdateNodeRequest,
} from '@zako/contracts';
import { isUniqueConstraintError } from '../lib/db-errors';
import { AppError } from '../lib/errors';
import { sha256Hex } from '../lib/hash';
import { newId, newXrayEmail } from '../lib/ids';
import { deriveNodeStatus, nowSeconds } from '../lib/node-status';
import { generateToken } from '../lib/token';
import { getProtocolAdapter, isEndpointProtocol, requireProtocolAdapter } from '../protocols';
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
	deleteNodeById,
	findNodeById,
	insertNodeStatement,
	listNodeRows,
	markNodeUninstalling,
	recordAgentUpdateOutcome,
	setDesiredAgentVersion,
	updateNode as updateNodeRow,
	type NodeRow,
} from '../repositories/nodes';
import { insertAuditEvent } from '../repositories/audit-events';
import { findSubscriberById, insertNodeClientStatement, listNodeClientRowsByNode } from '../repositories/subscribers';
import type { ListQuery, Paginated } from '../types';
import { bumpUsersVersionStatement } from './users-version';

export interface ProvisionEndpoint {
	id: string;
	name: string;
	protocol: string;
	host: string;
	port: number;
	params: Record<string, unknown>;
}

/**
 * Endpoint writes carry unvalidated protocol params: the route can only check that
 * an object was sent, while the service validates it against the protocol adapter.
 */
export interface CreateEndpointInput {
	name: string;
	host: string;
	port: number;
	protocol: EndpointProtocol;
	params: Record<string, unknown>;
}

export interface UpdateEndpointInput {
	name?: string;
	host?: string;
	port?: number;
	params?: Record<string, unknown>;
	enabled?: boolean;
}

export interface NodeProvisionParams {
	nodeId: string;
	name: string;
	heartbeatInterval: number;
	endpoints: ProvisionEndpoint[];
	now: number;
}

/**
 * Prepares the D1 batch statements and permanent agent token for creating a new
 * node, the endpoints reported by the node, and a default-subscriber grant when
 * present.
 */
export async function prepareNodeProvision(
	db: D1Database,
	params: NodeProvisionParams,
): Promise<{
	statements: D1PreparedStatement[];
	agentToken: string;
}> {
	const secret = generateToken();
	const tokenHash = await sha256Hex(secret);
	const defaultSubscriberId = await getMetaValue(db, META_KEYS.defaultSubscriberId);
	const defaultSubscriber = defaultSubscriberId ? await findSubscriberById(db, defaultSubscriberId) : null;

	const statements = [
		insertNodeStatement(db, {
			id: params.nodeId,
			name: params.name,
			agent_token_hash: tokenHash,
			heartbeat_interval_seconds: params.heartbeatInterval,
			now: params.now,
		}),
		...params.endpoints.map((endpoint) =>
			insertEndpointStatement(db, {
				id: endpoint.id,
				node_id: params.nodeId,
				name: endpoint.name,
				protocol: endpoint.protocol,
				host: endpoint.host,
				port: endpoint.port,
				params_json: JSON.stringify(endpoint.params),
				now: params.now,
			}),
		),
		bumpUsersVersionStatement(db),
	];
	if (defaultSubscriber) {
		statements.push(
			insertNodeClientStatement(db, {
				id: newId(),
				node_id: params.nodeId,
				subscriber_id: defaultSubscriber.id,
				xray_email: newXrayEmail(),
				vless_uuid: crypto.randomUUID(),
				now: params.now,
			}),
		);
	}

	return {
		statements,
		agentToken: `${params.nodeId}.${secret}`,
	};
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
				uninstall_requested_at: row.uninstall_requested_at,
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
		desired_agent_version: row.desired_agent_version,
		last_update_error: row.last_update_error,
		last_update_at: row.last_update_at,
		uninstall_requested_at: row.uninstall_requested_at,
		uninstall_remove_xray: row.uninstall_remove_xray === 1,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function toEndpoint(row: EndpointRow): Endpoint {
	if (!isEndpointProtocol(row.protocol)) {
		throw new AppError('INTERNAL_ERROR', 'Stored endpoint protocol is not supported', 500);
	}
	const adapter = requireProtocolAdapter(row.protocol);
	const params = adapter.paramsSchema.safeParse(JSON.parse(row.params_json) as unknown);
	if (!params.success) {
		throw new AppError('INTERNAL_ERROR', 'Stored endpoint parameters are invalid', 500);
	}
	return {
		id: row.id,
		node_id: row.node_id,
		name: row.name,
		protocol: row.protocol,
		host: row.host,
		port: row.port,
		params: params.data as Endpoint['params'],
		enabled: row.enabled === 1,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/**
 * Validates protocol parameters against the adapter that owns them. The route
 * schema cannot do this because the protocol is resolved from the request (create)
 * or from the stored endpoint (update).
 */
function validatedParams(protocol: EndpointProtocol, params: unknown): Record<string, unknown> {
	const adapter = getProtocolAdapter(protocol);
	if (!adapter) {
		throw new AppError('VALIDATION_ERROR', `Unsupported endpoint protocol: ${protocol}`, 422);
	}
	const parsed = adapter.paramsSchema.safeParse(params);
	if (!parsed.success) {
		throw new AppError('VALIDATION_ERROR', `Invalid parameters for protocol ${protocol}`, 422);
	}
	return parsed.data as Record<string, unknown>;
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

export async function createEndpoint(db: D1Database, nodeId: string, input: CreateEndpointInput): Promise<Endpoint> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();
	const now = nowSeconds();
	const endpointId = newId();
	try {
		await insertEndpointStatement(db, {
			id: endpointId,
			node_id: nodeId,
			name: input.name,
			protocol: input.protocol,
			host: input.host,
			port: input.port,
			params_json: JSON.stringify(validatedParams(input.protocol, input.params)),
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

export async function updateEndpoint(db: D1Database, nodeId: string, endpointId: string, input: UpdateEndpointInput): Promise<Endpoint> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();
	const existing = await findEndpointById(db, nodeId, endpointId);
	if (!existing) throw new AppError('NOT_FOUND', 'Endpoint not found', 404);
	if (!isEndpointProtocol(existing.protocol)) {
		throw new AppError('INTERNAL_ERROR', 'Stored endpoint protocol is not supported', 500);
	}
	try {
		await updateEndpointRow(
			db,
			nodeId,
			endpointId,
			{
				name: input.name,
				host: input.host,
				port: input.port,
				// The protocol is fixed at creation, so an omitted protocol in the
				// request is validated against the stored one.
				params_json: input.params === undefined ? undefined : JSON.stringify(validatedParams(existing.protocol, input.params)),
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

export interface DeleteNodeOptions {
	force: boolean;
	removeXray: boolean;
	actorEmail: string | null;
}

/**
 * Deletes a node immediately when forced or never seen, or marks it uninstalling
 * so the agent receives the uninstall directive on its next heartbeat.
 */
export async function deleteOrUninstallNode(
	db: D1Database,
	nodeId: string,
	options: DeleteNodeOptions,
): Promise<{ deleted: true } | { deleted: false; node: Node }> {
	const existing = await findNodeById(db, nodeId);
	if (!existing) throw nodeNotFound();
	const now = nowSeconds();

	if (options.force || existing.last_seen_at === null) {
		await deleteNodeById(db, nodeId);
		await insertAuditEvent(db, {
			id: newId(),
			actor_email: options.actorEmail,
			action: 'node.delete',
			target_type: 'node',
			target_id: nodeId,
			detail_json: JSON.stringify({ force: options.force, name: existing.name }),
			created_at: now,
		});
		return { deleted: true };
	}

	await markNodeUninstalling(db, nodeId, options.removeXray, now);
	await insertAuditEvent(db, {
		id: newId(),
		actor_email: options.actorEmail,
		action: 'node.uninstall_request',
		target_type: 'node',
		target_id: nodeId,
		detail_json: JSON.stringify({ remove_xray: options.removeXray, name: existing.name }),
		created_at: now,
	});
	const updated = await findNodeById(db, nodeId);
	if (!updated) throw nodeNotFound();
	return { deleted: false, node: toNode(updated, now) };
}

/**
 * Removes a node when the agent acknowledges a panel-initiated uninstall or
 * initiates self-uninstall from the node CLI.
 */
export async function completeAgentUninstall(db: D1Database, nodeId: string, reason: 'panel_directive' | 'node_cli'): Promise<void> {
	const existing = await findNodeById(db, nodeId);
	if (!existing) return;
	const now = nowSeconds();
	await deleteNodeById(db, nodeId);
	await insertAuditEvent(db, {
		id: newId(),
		actor_email: null,
		action: reason === 'panel_directive' ? 'node.uninstall_ack' : 'node.self_uninstall',
		target_type: 'node',
		target_id: nodeId,
		detail_json: JSON.stringify({ reason, name: existing.name }),
		created_at: now,
	});
}

function normalizeAgentVersion(raw: string): string {
	const trimmed = raw.trim().replace(/^[vV]/, '');
	if (!/^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$/.test(trimmed)) {
		throw new AppError('BAD_REQUEST', 'Invalid agent version format', 400);
	}
	return trimmed;
}

/**
 * Sets desired_agent_version on a node so its agent receives a self_update
 * directive on the next heartbeat.
 */
export async function requestNodeAgentUpdate(
	db: D1Database,
	nodeId: string,
	targetVersion: string,
	actorEmail: string | null,
): Promise<Node> {
	const existing = await findNodeById(db, nodeId);
	if (!existing) throw nodeNotFound();
	if (existing.uninstall_requested_at !== null) {
		throw new AppError('CONFLICT', 'Node is uninstalling', 409);
	}

	const normalized = normalizeAgentVersion(targetVersion);
	const now = nowSeconds();
	await setDesiredAgentVersion(db, nodeId, normalized, now);
	await insertAuditEvent(db, {
		id: newId(),
		actor_email: actorEmail,
		action: 'node.agent_update_request',
		target_type: 'node',
		target_id: nodeId,
		detail_json: JSON.stringify({ target_version: normalized, name: existing.name }),
		created_at: now,
	});
	const updated = await findNodeById(db, nodeId);
	if (!updated) throw nodeNotFound();
	return toNode(updated, now);
}

/**
 * Records the outcome of a node-side agent self-update attempt.
 */
export async function recordAgentUpdateResult(db: D1Database, nodeId: string, result: AgentUpdateResult): Promise<AgentUpdateResult> {
	const existing = await findNodeById(db, nodeId);
	if (!existing) throw nodeNotFound();

	const normalized = normalizeAgentVersion(result.target_version);
	const now = nowSeconds();
	const errorText = result.error ? `${result.error.code}: ${result.error.message}`.slice(0, 512) : null;

	await recordAgentUpdateOutcome(db, nodeId, {
		status: result.status,
		targetVersion: normalized,
		reportedAt: result.reported_at,
		error: errorText,
		now,
	});

	await insertAuditEvent(db, {
		id: newId(),
		actor_email: null,
		action: result.status === 'applied' ? 'node.agent_update_applied' : 'node.agent_update_failed',
		target_type: 'node',
		target_id: nodeId,
		detail_json: JSON.stringify({
			target_version: normalized,
			status: result.status,
			error: result.error ?? null,
		}),
		created_at: now,
	});

	return {
		target_version: normalized,
		status: result.status,
		reported_at: result.reported_at,
		error: result.error ?? null,
	};
}
