import { sqlPlaceholders } from '../lib/sql';

export interface AgentAuthRow {
	id: string;
	agent_token_hash: string;
	enabled: number;
}

export interface NodeRow {
	id: string;
	name: string;
	enabled: number;
	heartbeat_interval_seconds: number;
	last_seen_at: number | null;
	xray_healthy: number | null;
	stats_healthy: number | null;
	agent_version: string | null;
	xray_version: string | null;
	sys_json: string | null;
	desired_config_version: number;
	applied_config_version: number;
	last_config_error: string | null;
	last_config_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface NodeRuntimeRow {
	id: string;
	heartbeat_interval_seconds: number;
	desired_config_version: number;
}

export interface NewNodeRow {
	id: string;
	name: string;
	agent_token_hash: string;
	heartbeat_interval_seconds: number;
	now: number;
}

export interface NodeUpdateInput {
	name?: string;
	enabled?: boolean;
	heartbeat_interval_seconds?: number;
}

export interface NodeHeartbeatInput {
	nodeId: string;
	last_seen_at: number;
	xray_healthy: boolean;
	stats_healthy: boolean;
	agent_version: string;
	xray_version: string;
	sys_json: string | null;
	applied_config_version: number;
	updated_at: number;
}

const NODE_COLUMNS = `id, name, enabled, heartbeat_interval_seconds, last_seen_at,
	xray_healthy, stats_healthy, agent_version, xray_version, sys_json,
	desired_config_version, applied_config_version, last_config_error,
	last_config_at, created_at, updated_at`;

export async function findAgentAuthById(db: D1Database, nodeId: string): Promise<AgentAuthRow | null> {
	const row = await db.prepare('SELECT id, agent_token_hash, enabled FROM nodes WHERE id = ? LIMIT 1').bind(nodeId).first<AgentAuthRow>();
	return row ?? null;
}

export async function findNodeById(db: D1Database, nodeId: string): Promise<NodeRow | null> {
	const row = await db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ? LIMIT 1`).bind(nodeId).first<NodeRow>();
	return row ?? null;
}

export async function findNodeRuntimeById(db: D1Database, nodeId: string): Promise<NodeRuntimeRow | null> {
	const row = await db
		.prepare('SELECT id, heartbeat_interval_seconds, desired_config_version FROM nodes WHERE id = ? LIMIT 1')
		.bind(nodeId)
		.first<NodeRuntimeRow>();
	return row ?? null;
}

export async function listNodeRows(db: D1Database, limit: number, cursor?: string): Promise<NodeRow[]> {
	if (cursor) {
		return (await db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id > ? ORDER BY id ASC LIMIT ?`).bind(cursor, limit).all<NodeRow>())
			.results;
	}
	return (await db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes ORDER BY id ASC LIMIT ?`).bind(limit).all<NodeRow>()).results;
}

export function findNodesByIdsStatement(db: D1Database, nodeIds: string[]): D1PreparedStatement {
	return db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id IN (${sqlPlaceholders(nodeIds.length)})`).bind(...nodeIds);
}

export async function findNodesByIds(db: D1Database, nodeIds: string[]): Promise<NodeRow[]> {
	if (nodeIds.length === 0) return [];
	return (await findNodesByIdsStatement(db, nodeIds).all<NodeRow>()).results;
}

export function insertNodeStatement(db: D1Database, node: NewNodeRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO nodes
			 (id, name, enabled, agent_token_hash, heartbeat_interval_seconds, desired_config_version,
			  applied_config_version, created_at, updated_at)
			 VALUES (?, ?, 1, ?, ?, 0, 0, ?, ?)`,
		)
		.bind(node.id, node.name, node.agent_token_hash, node.heartbeat_interval_seconds, node.now, node.now);
}

export async function updateNode(db: D1Database, nodeId: string, input: NodeUpdateInput, now: number): Promise<void> {
	const assignments: string[] = ['updated_at = ?'];
	const values: unknown[] = [now];
	if (input.name !== undefined) {
		assignments.push('name = ?');
		values.push(input.name);
	}
	if (input.enabled !== undefined) {
		assignments.push('enabled = ?');
		values.push(input.enabled ? 1 : 0);
	}
	if (input.heartbeat_interval_seconds !== undefined) {
		assignments.push('heartbeat_interval_seconds = ?');
		values.push(input.heartbeat_interval_seconds);
	}
	values.push(nodeId);
	await db
		.prepare(`UPDATE nodes SET ${assignments.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();
}

export async function updateAgentTokenHash(db: D1Database, nodeId: string, tokenHash: string, now: number): Promise<void> {
	await db.prepare('UPDATE nodes SET agent_token_hash = ?, updated_at = ? WHERE id = ?').bind(tokenHash, now, nodeId).run();
}

export function updateNodeHeartbeatStatement(db: D1Database, input: NodeHeartbeatInput): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE nodes
			 SET last_seen_at = ?, xray_healthy = ?, stats_healthy = ?, agent_version = ?,
			     xray_version = ?, sys_json = ?, applied_config_version = ?, updated_at = ?
			 WHERE id = ?`,
		)
		.bind(
			input.last_seen_at,
			input.xray_healthy ? 1 : 0,
			input.stats_healthy ? 1 : 0,
			input.agent_version,
			input.xray_version,
			input.sys_json,
			input.applied_config_version,
			input.updated_at,
			input.nodeId,
		);
}
