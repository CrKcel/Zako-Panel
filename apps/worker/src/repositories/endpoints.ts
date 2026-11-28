import { sqlPlaceholders } from '../lib/sql';

export interface EndpointRow {
	id: string;
	node_id: string;
	name: string;
	protocol: string;
	host: string;
	port: number;
	params_json: string;
	enabled: number;
	created_at: number;
	updated_at: number;
}

export interface NewEndpointRow {
	id: string;
	node_id: string;
	name: string;
	protocol: string;
	host: string;
	port: number;
	params_json: string;
	now: number;
}

export interface EndpointUpdateInput {
	name?: string;
	host?: string;
	port?: number;
	params_json?: string;
	enabled?: boolean;
}

const ENDPOINT_COLUMNS = 'id, node_id, name, protocol, host, port, params_json, enabled, created_at, updated_at';

export async function listEndpointRowsByNode(db: D1Database, nodeId: string): Promise<EndpointRow[]> {
	return (
		await db
			.prepare(`SELECT ${ENDPOINT_COLUMNS} FROM endpoints WHERE node_id = ? ORDER BY created_at ASC, id ASC`)
			.bind(nodeId)
			.all<EndpointRow>()
	).results;
}

export function enabledEndpointsByNodesStatement(db: D1Database, nodeIds: string[]): D1PreparedStatement {
	return db
		.prepare(
			`SELECT ${ENDPOINT_COLUMNS} FROM endpoints
			 WHERE enabled = 1 AND node_id IN (${sqlPlaceholders(nodeIds.length)})
			 ORDER BY node_id ASC, created_at ASC, id ASC`,
		)
		.bind(...nodeIds);
}

export function listAllEnabledEndpointsStatement(db: D1Database): D1PreparedStatement {
	return db.prepare(`SELECT ${ENDPOINT_COLUMNS} FROM endpoints WHERE enabled = 1 ORDER BY node_id ASC, created_at ASC, id ASC`);
}

export async function listEnabledEndpointRowsByNodes(db: D1Database, nodeIds: string[]): Promise<EndpointRow[]> {
	if (nodeIds.length === 0) return [];
	return (await enabledEndpointsByNodesStatement(db, nodeIds).all<EndpointRow>()).results;
}

export async function findEndpointById(db: D1Database, nodeId: string, endpointId: string): Promise<EndpointRow | null> {
	const row = await db
		.prepare(`SELECT ${ENDPOINT_COLUMNS} FROM endpoints WHERE node_id = ? AND id = ? LIMIT 1`)
		.bind(nodeId, endpointId)
		.first<EndpointRow>();
	return row ?? null;
}

export function insertEndpointStatement(db: D1Database, endpoint: NewEndpointRow): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO endpoints (id, node_id, name, protocol, host, port, params_json, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		)
		.bind(
			endpoint.id,
			endpoint.node_id,
			endpoint.name,
			endpoint.protocol,
			endpoint.host,
			endpoint.port,
			endpoint.params_json,
			endpoint.now,
			endpoint.now,
		);
}

export async function updateEndpoint(
	db: D1Database,
	nodeId: string,
	endpointId: string,
	input: EndpointUpdateInput,
	now: number,
): Promise<void> {
	const assignments: string[] = ['updated_at = ?'];
	const values: unknown[] = [now];
	if (input.name !== undefined) {
		assignments.push('name = ?');
		values.push(input.name);
	}
	if (input.host !== undefined) {
		assignments.push('host = ?');
		values.push(input.host);
	}
	if (input.port !== undefined) {
		assignments.push('port = ?');
		values.push(input.port);
	}
	if (input.params_json !== undefined) {
		assignments.push('params_json = ?');
		values.push(input.params_json);
	}
	if (input.enabled !== undefined) {
		assignments.push('enabled = ?');
		values.push(input.enabled ? 1 : 0);
	}
	values.push(nodeId, endpointId);
	await db
		.prepare(`UPDATE endpoints SET ${assignments.join(', ')} WHERE node_id = ? AND id = ?`)
		.bind(...values)
		.run();
}

export async function disableEndpoint(db: D1Database, nodeId: string, endpointId: string, now: number): Promise<boolean> {
	const result = await db
		.prepare('UPDATE endpoints SET enabled = 0, updated_at = ? WHERE node_id = ? AND id = ?')
		.bind(now, nodeId, endpointId)
		.run();
	return result.meta.changes > 0;
}
