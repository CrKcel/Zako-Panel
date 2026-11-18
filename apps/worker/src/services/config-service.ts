import type { AgentConfig, AgentConfigResult, ConfigVersion, PublishConfigRequest } from '@zako/contracts';
import { canonicalJson } from '../lib/canonical-json';
import { AppError } from '../lib/errors';
import { sha256Hex } from '../lib/hash';
import { newId } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import {
	findConfigByVersion,
	insertConfigAndAdvanceDesired,
	listConfigRows,
	type NodeConfigRow,
	recordConfigApplyOutcome,
} from '../repositories/configs';
import { findNodeById } from '../repositories/nodes';
import type { AdminIdentity, ListQuery, Paginated } from '../types';

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_ERROR_TEXT_LENGTH = 512;

function nodeNotFound(): AppError {
	return new AppError('NODE_NOT_FOUND', 'Node not found', 404);
}

function configNotFound(): AppError {
	return new AppError('NOT_FOUND', 'Configuration version not found', 404);
}

function parseDefinitionObject(definitionJson: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(definitionJson) as unknown;
	} catch {
		throw new AppError('INTERNAL_ERROR', 'Stored configuration definition is invalid JSON', 500);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new AppError('INTERNAL_ERROR', 'Stored configuration definition is not an object', 500);
	}
	return parsed as Record<string, unknown>;
}

function toConfigVersion(row: NodeConfigRow): ConfigVersion {
	return {
		node_id: row.node_id,
		version: row.version,
		definition: parseDefinitionObject(row.definition_json),
		definition_sha256: row.definition_sha256,
		created_by: row.created_by,
		created_at: row.created_at,
		applied_at: row.applied_at,
		last_error: row.last_error,
	};
}

/**
 * Validates that the Xray config skeleton is safe to store on the control plane:
 * it must declare inbounds with exactly one VLESS inbound and must never carry
 * a REALITY privateKey (which stays exclusively on the node).
 */
function validateConfigDefinition(definition: Record<string, unknown>): void {
	const inbounds = definition.inbounds;
	if (!Array.isArray(inbounds)) {
		throw new AppError('VALIDATION_ERROR', 'Configuration definition must contain an inbounds array', 422);
	}

	let vlessCount = 0;
	for (const rawInbound of inbounds) {
		if (rawInbound === null || typeof rawInbound !== 'object' || Array.isArray(rawInbound)) {
			throw new AppError('VALIDATION_ERROR', 'Each inbound entry must be a JSON object', 422);
		}
		const inbound = rawInbound as Record<string, unknown>;
		if (inbound.protocol === 'vless') {
			vlessCount += 1;
		}
		const stream = inbound.streamSettings;
		if (stream !== null && typeof stream === 'object' && !Array.isArray(stream)) {
			const reality = (stream as Record<string, unknown>).realitySettings;
			if (reality !== null && typeof reality === 'object' && !Array.isArray(reality)) {
				const privateKey = (reality as Record<string, unknown>).privateKey;
				if (typeof privateKey === 'string' && privateKey.trim() !== '') {
					throw new AppError(
						'VALIDATION_ERROR',
						'REALITY privateKey must not be stored in the control plane; leave it unset so the node injects its local key',
						422,
					);
				}
			}
		}
	}

	if (vlessCount === 0) {
		throw new AppError('VALIDATION_ERROR', 'Configuration must include a vless inbound', 422);
	}
	if (vlessCount > 1) {
		throw new AppError('VALIDATION_ERROR', 'Configuration must not include more than one vless inbound', 422);
	}
}

function parseCursorVersion(cursor: string | undefined): number | undefined {
	if (cursor === undefined) return undefined;
	if (!/^[1-9]\d*$/.test(cursor)) {
		throw new AppError('VALIDATION_ERROR', 'Invalid configuration cursor', 400);
	}
	const parsed = Number(cursor);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new AppError('VALIDATION_ERROR', 'Invalid configuration cursor', 400);
	}
	return parsed;
}

function formatConfigErrorText(error: AgentConfigResult['error']): string {
	if (!error) return 'Configuration apply failed';
	const combined = error.code ? `${error.code}: ${error.message}` : error.message;
	const trimmed = combined.trim() || 'Configuration apply failed';
	return trimmed.length > MAX_ERROR_TEXT_LENGTH ? trimmed.slice(0, MAX_ERROR_TEXT_LENGTH) : trimmed;
}

export async function listConfigs(db: D1Database, nodeId: string, query: ListQuery): Promise<Paginated<ConfigVersion>> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();

	const cursorVersion = parseCursorVersion(query.cursor);
	const rows = await listConfigRows(db, nodeId, query.limit + 1, cursorVersion);
	const hasMore = rows.length > query.limit;
	const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
	const items = pageRows.map(toConfigVersion);
	const last = items[items.length - 1];
	return { items, next_cursor: hasMore && last ? String(last.version) : null };
}

export async function publishConfig(
	db: D1Database,
	nodeId: string,
	input: PublishConfigRequest,
	actor?: AdminIdentity,
): Promise<ConfigVersion> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();

	validateConfigDefinition(input.definition);

	const definitionJson = canonicalJson(input.definition);
	if (new TextEncoder().encode(definitionJson).byteLength > MAX_CONFIG_BYTES) {
		throw new AppError('PAYLOAD_TOO_LARGE', `Configuration exceeds ${MAX_CONFIG_BYTES} bytes`, 413);
	}
	const definitionSha256 = await sha256Hex(definitionJson);
	const now = nowSeconds();

	const inserted = await insertConfigAndAdvanceDesired(db, {
		nodeId,
		definitionJson,
		definitionSha256,
		createdBy: actor?.email ?? null,
		actorEmail: actor?.email ?? null,
		auditId: newId(),
		auditAction: 'node.config.publish',
		auditDetailJson: JSON.stringify({ sha256: definitionSha256 }),
		now,
	});
	return toConfigVersion(inserted);
}

export async function getConfig(db: D1Database, nodeId: string, version: number): Promise<ConfigVersion> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();

	const row = await findConfigByVersion(db, nodeId, version);
	if (!row) throw configNotFound();
	return toConfigVersion(row);
}

export async function rollbackConfig(db: D1Database, nodeId: string, version: number, actor?: AdminIdentity): Promise<ConfigVersion> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();

	const target = await findConfigByVersion(db, nodeId, version);
	if (!target) throw configNotFound();

	const now = nowSeconds();
	const inserted = await insertConfigAndAdvanceDesired(db, {
		nodeId,
		definitionJson: target.definition_json,
		definitionSha256: target.definition_sha256,
		createdBy: actor?.email ?? null,
		actorEmail: actor?.email ?? null,
		auditId: newId(),
		auditAction: 'node.config.rollback',
		auditDetailJson: JSON.stringify({
			source_version: version,
			sha256: target.definition_sha256,
		}),
		now,
	});
	return toConfigVersion(inserted);
}

export async function getDesiredConfig(db: D1Database, nodeId: string): Promise<AgentConfig | null> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();

	if (node.desired_config_version <= 0 || node.desired_config_version === node.applied_config_version) {
		return null;
	}

	const row = await findConfigByVersion(db, nodeId, node.desired_config_version);
	if (!row) return null;

	return {
		version: row.version,
		definition_sha256: row.definition_sha256,
		definition: parseDefinitionObject(row.definition_json),
	};
}

export async function recordConfigResult(db: D1Database, nodeId: string, result: AgentConfigResult): Promise<AgentConfigResult> {
	const node = await findNodeById(db, nodeId);
	if (!node) throw nodeNotFound();

	const target = await findConfigByVersion(db, nodeId, result.version);
	if (!target) throw configNotFound();

	const errorText = result.status === 'failed' ? formatConfigErrorText(result.error) : null;
	await recordConfigApplyOutcome(db, {
		nodeId,
		version: result.version,
		status: result.status,
		appliedAt: result.applied_at,
		errorText,
		now: nowSeconds(),
	});

	return result;
}
