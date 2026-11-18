export interface NodeConfigRow {
	node_id: string;
	version: number;
	definition_json: string;
	definition_sha256: string;
	created_by: string | null;
	created_at: number;
	applied_at: number | null;
	last_error: string | null;
}

export interface PublishConfigParams {
	nodeId: string;
	definitionJson: string;
	definitionSha256: string;
	createdBy: string | null;
	actorEmail: string | null;
	auditId: string;
	auditAction: string;
	auditDetailJson: string;
	now: number;
}

export interface RecordConfigOutcomeParams {
	nodeId: string;
	version: number;
	status: 'applied' | 'failed';
	appliedAt: number;
	errorText: string | null;
	now: number;
}

const CONFIG_COLUMNS = `node_id, version, definition_json, definition_sha256,
	created_by, created_at, applied_at, last_error`;

export async function listConfigRows(db: D1Database, nodeId: string, limit: number, cursorVersion?: number): Promise<NodeConfigRow[]> {
	if (cursorVersion !== undefined) {
		return (
			await db
				.prepare(
					`SELECT ${CONFIG_COLUMNS}
					 FROM node_configs
					 WHERE node_id = ? AND version < ?
					 ORDER BY version DESC
					 LIMIT ?`,
				)
				.bind(nodeId, cursorVersion, limit)
				.all<NodeConfigRow>()
		).results;
	}
	return (
		await db
			.prepare(
				`SELECT ${CONFIG_COLUMNS}
				 FROM node_configs
				 WHERE node_id = ?
				 ORDER BY version DESC
				 LIMIT ?`,
			)
			.bind(nodeId, limit)
			.all<NodeConfigRow>()
	).results;
}

export async function findConfigByVersion(db: D1Database, nodeId: string, version: number): Promise<NodeConfigRow | null> {
	const row = await db
		.prepare(
			`SELECT ${CONFIG_COLUMNS}
			 FROM node_configs
			 WHERE node_id = ? AND version = ?
			 LIMIT 1`,
		)
		.bind(nodeId, version)
		.first<NodeConfigRow>();
	return row ?? null;
}

export async function insertConfigAndAdvanceDesired(db: D1Database, params: PublishConfigParams): Promise<NodeConfigRow> {
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO node_configs
				 (node_id, version, definition_json, definition_sha256, created_by, created_at)
				 SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?
				 FROM node_configs
				 WHERE node_id = ?`,
			)
			.bind(params.nodeId, params.definitionJson, params.definitionSha256, params.createdBy, params.now, params.nodeId),
		db
			.prepare(
				`UPDATE nodes
				 SET desired_config_version = (SELECT MAX(version) FROM node_configs WHERE node_id = ?),
				     last_config_error = NULL,
				     updated_at = ?
				 WHERE id = ?`,
			)
			.bind(params.nodeId, params.now, params.nodeId),
		db
			.prepare(
				`INSERT INTO audit_events
				 (id, actor_email, action, target_type, target_id, detail_json, created_at)
				 VALUES (?, ?, ?, 'node', ?, ?, ?)`,
			)
			.bind(params.auditId, params.actorEmail, params.auditAction, params.nodeId, params.auditDetailJson, params.now),
		db
			.prepare(
				`SELECT ${CONFIG_COLUMNS}
				 FROM node_configs
				 WHERE node_id = ?
				 ORDER BY version DESC
				 LIMIT 1`,
			)
			.bind(params.nodeId),
	]);

	const row = results[3]?.results?.[0] as NodeConfigRow | undefined;
	if (!row) {
		throw new Error('Failed to read inserted node_config row');
	}
	return row;
}

export async function recordConfigApplyOutcome(db: D1Database, params: RecordConfigOutcomeParams): Promise<void> {
	if (params.status === 'applied') {
		await db.batch([
			db
				.prepare(
					`UPDATE node_configs
					 SET applied_at = COALESCE(applied_at, ?),
					     last_error = NULL
					 WHERE node_id = ? AND version = ?`,
				)
				.bind(params.appliedAt, params.nodeId, params.version),
			db
				.prepare(
					`UPDATE nodes
					 SET applied_config_version = MIN(desired_config_version, MAX(applied_config_version, ?)),
					     last_config_at = ?,
					     last_config_error = CASE WHEN desired_config_version <= ? THEN NULL ELSE last_config_error END,
					     updated_at = ?
					 WHERE id = ?`,
				)
				.bind(params.version, params.appliedAt, params.version, params.now, params.nodeId),
		]);
		return;
	}

	await db.batch([
		db
			.prepare(
				`UPDATE node_configs
				 SET last_error = ?
				 WHERE node_id = ? AND version = ?`,
			)
			.bind(params.errorText, params.nodeId, params.version),
		db
			.prepare(
				`UPDATE nodes
				 SET last_config_error = CASE WHEN desired_config_version = ? THEN ? ELSE last_config_error END,
				     last_config_at = CASE WHEN desired_config_version = ? THEN ? ELSE last_config_at END,
				     updated_at = ?
				 WHERE id = ?`,
			)
			.bind(params.version, params.errorText, params.version, params.appliedAt, params.now, params.nodeId),
	]);
}
