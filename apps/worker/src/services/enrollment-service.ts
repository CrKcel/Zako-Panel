import type { AgentEnrollRequest, AgentEnrollResponse, CreateNodeEnrollmentTokenRequest, NodeEnrollmentToken } from '@zako/contracts';
import { isUniqueConstraintError } from '../lib/db-errors';
import { AppError } from '../lib/errors';
import { sha256Hex, timingSafeEqualHex } from '../lib/hash';
import { newId } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import { generateToken, parseAgentToken } from '../lib/token';
import type { VlessRealityParams } from '../protocols/vless-reality';
import {
	consumeEnrollmentToken,
	type EnrollmentTokenRow,
	findEnrollmentTokenById,
	findNodeByName,
	insertEnrollmentToken,
	linkEnrollmentTokenNodeStatement,
	listEnrollmentTokenRows,
	revokeEnrollmentTokenRow,
} from '../repositories/enrollment-tokens';
import type { ListQuery, Paginated } from '../types';
import { prepareNodeProvision } from './node-service';

const DEFAULT_TTL_SECONDS = 86_400; // 24 hours
const DEFAULT_ENDPOINT_NAME = 'vless-reality';

function deriveStatus(row: EnrollmentTokenRow, now: number): NodeEnrollmentToken['status'] {
	if (row.used_at !== null) return 'used';
	if (row.revoked_at !== null) return 'revoked';
	if (row.expires_at <= now) return 'expired';
	return 'active';
}

function toEnrollmentToken(row: EnrollmentTokenRow, now: number): NodeEnrollmentToken {
	return {
		id: row.id,
		name_prefix: row.name_prefix,
		default_sni: row.default_sni,
		default_port: row.default_port,
		default_fingerprint: row.default_fingerprint,
		heartbeat_interval_seconds: row.heartbeat_interval_seconds,
		created_by: row.created_by,
		expires_at: row.expires_at,
		used_at: row.used_at,
		used_node_id: row.used_node_id,
		revoked_at: row.revoked_at,
		status: deriveStatus(row, now),
		created_at: row.created_at,
	};
}

export async function createEnrollmentToken(
	db: D1Database,
	input: Partial<CreateNodeEnrollmentTokenRequest>,
	createdBy: string,
): Promise<{ enrollment_token: NodeEnrollmentToken; token: string }> {
	const now = nowSeconds();
	const id = newId();
	const secret = generateToken();
	const tokenHash = await sha256Hex(secret);
	const ttl = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;
	const row: EnrollmentTokenRow = {
		id,
		token_hash: tokenHash,
		name_prefix: input.name_prefix ?? null,
		default_sni: input.default_sni ?? 'www.microsoft.com',
		default_port: input.default_port ?? 443,
		default_fingerprint: input.default_fingerprint ?? 'chrome',
		heartbeat_interval_seconds: input.heartbeat_interval_seconds ?? 300,
		created_by: createdBy,
		expires_at: now + ttl,
		used_at: null,
		used_node_id: null,
		revoked_at: null,
		created_at: now,
	};

	await insertEnrollmentToken(db, row);
	return {
		enrollment_token: toEnrollmentToken(row, now),
		token: `${id}.${secret}`,
	};
}

export async function listEnrollmentTokens(db: D1Database, query: ListQuery): Promise<Paginated<NodeEnrollmentToken>> {
	const rows = await listEnrollmentTokenRows(db, query.limit + 1, query.cursor);
	const hasMore = rows.length > query.limit;
	const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
	const now = nowSeconds();
	const items = pageRows.map((row) => toEnrollmentToken(row, now));
	const last = items[items.length - 1];
	return { items, next_cursor: hasMore && last ? last.id : null };
}

export async function revokeEnrollmentToken(db: D1Database, tokenId: string): Promise<void> {
	const existing = await findEnrollmentTokenById(db, tokenId);
	if (!existing) {
		throw new AppError('NOT_FOUND', 'Enrollment token not found', 404);
	}
	await revokeEnrollmentTokenRow(db, tokenId, nowSeconds());
}

/**
 * Validates a one-time enrollment token from `Authorization: Bearer <id>.<secret>`,
 * atomically consumes it, and provisions a new node + endpoint + default subscriber.
 */
export async function enrollNode(
	db: D1Database,
	authorizationHeader: string | undefined,
	input: AgentEnrollRequest,
): Promise<AgentEnrollResponse> {
	const bearer = authorizationHeader?.startsWith('Bearer ') ? authorizationHeader.slice('Bearer '.length).trim() : undefined;
	const parsed = parseAgentToken(bearer);
	if (!parsed) {
		throw new AppError('UNAUTHORIZED', 'Invalid enrollment token', 401);
	}

	const row = await findEnrollmentTokenById(db, parsed.nodeId);
	if (!row) {
		throw new AppError('UNAUTHORIZED', 'Invalid enrollment token', 401);
	}
	const presentedHash = await sha256Hex(parsed.secret);
	if (!timingSafeEqualHex(presentedHash, row.token_hash)) {
		throw new AppError('UNAUTHORIZED', 'Invalid enrollment token', 401);
	}

	const now = nowSeconds();
	if (row.revoked_at !== null || row.used_at !== null || row.expires_at <= now) {
		throw new AppError('UNAUTHORIZED', 'Enrollment token is expired or already used', 401);
	}

	const nodeName = row.name_prefix ? `${row.name_prefix}-${input.name}`.slice(0, 64) : input.name;
	// Pre-check name uniqueness before consuming the one-time token so a naming
	// conflict does not burn the operator's enrollment token.
	if (await findNodeByName(db, nodeName)) {
		throw new AppError('CONFLICT', 'Node name already exists', 409);
	}

	const nodeId = newId();
	const endpointId = newId();
	const sni = input.sni ?? row.default_sni;
	const port = input.port ?? row.default_port;
	const fingerprint = row.default_fingerprint as VlessRealityParams['fingerprint'];

	const consumed = await consumeEnrollmentToken(db, row.id, now);
	if (!consumed) {
		throw new AppError('UNAUTHORIZED', 'Enrollment token is expired or already used', 401);
	}

	const { statements, agentToken } = await prepareNodeProvision(db, {
		nodeId,
		endpointId,
		name: nodeName,
		heartbeatInterval: row.heartbeat_interval_seconds,
		endpoint: {
			name: DEFAULT_ENDPOINT_NAME,
			host: input.host,
			port,
			params: {
				sni,
				public_key: input.reality_public_key,
				short_id: input.reality_short_id,
				fingerprint,
				flow: 'xtls-rprx-vision',
				network: 'tcp',
			},
		},
		now,
	});

	try {
		await db.batch([...statements, linkEnrollmentTokenNodeStatement(db, row.id, nodeId)]);
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw new AppError('CONFLICT', 'Node name already exists', 409);
		}
		throw error;
	}

	return {
		node_id: nodeId,
		agent_token: agentToken,
		heartbeat_interval_seconds: row.heartbeat_interval_seconds,
		endpoint: {
			id: endpointId,
			name: DEFAULT_ENDPOINT_NAME,
			host: input.host,
			port,
			sni,
			short_id: input.reality_short_id,
			fingerprint,
		},
	};
}
