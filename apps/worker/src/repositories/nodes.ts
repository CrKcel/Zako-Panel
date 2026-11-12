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

export async function findAgentAuthById(db: D1Database, nodeId: string): Promise<AgentAuthRow | null> {
	const row = await db.prepare('SELECT id, agent_token_hash, enabled FROM nodes WHERE id = ? LIMIT 1').bind(nodeId).first<AgentAuthRow>();
	return row ?? null;
}
