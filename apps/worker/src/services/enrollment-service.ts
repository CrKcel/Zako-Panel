import type { AgentEndpointProtocol, AgentEnrollResponse, CreateNodeEnrollmentTokenRequest, NodeEnrollmentToken } from '@zako/contracts';
import { isUniqueConstraintError } from '../lib/db-errors';
import { AppError } from '../lib/errors';
import { sha256Hex, timingSafeEqualHex } from '../lib/hash';
import { newId } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import { generateToken, parseAgentToken } from '../lib/token';
import { getProtocolAdapter, isAgentProtocol } from '../protocols';
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
import { prepareNodeProvision, type ProvisionEndpoint } from './node-service';

/**
 * The agent reports endpoint params the route cannot validate: each one belongs to
 * the protocol the agent declared, so validateEndpoints checks it against that
 * protocol's adapter.
 */
export interface EnrollEndpointInput {
	name: string;
	protocol: AgentEndpointProtocol;
	port: number;
	params: Record<string, unknown>;
}

export interface EnrollInput {
	name: string;
	host: string;
	agent_version?: string;
	xray_version?: string;
	endpoints: EnrollEndpointInput[];
}

interface ValidatedEndpoint extends ProvisionEndpoint {
	protocol: AgentEndpointProtocol;
}

const DEFAULT_TTL_SECONDS = 86_400; // 24 hours
const MAX_ENDPOINTS = 16;

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
 * Endpoint names are unique per node, and two inbounds adopted from one node can
 * legitimately share a tag. Suffixes keep enrollment from failing on that.
 */
function uniqueEndpointNames(endpoints: EnrollEndpointInput[]): string[] {
	const used = new Set<string>();
	return endpoints.map((endpoint) => {
		const base = truncateName(endpoint.name.trim() || `endpoint-${endpoint.port}`, 64);
		let candidate = base;
		for (let suffix = 2; used.has(candidate); suffix += 1) {
			const tail = `-${suffix}`;
			candidate = `${truncateName(base, 64 - tail.length)}${tail}`;
		}
		used.add(candidate);
		return candidate;
	});
}

/**
 * The agent reports what the node already serves. Parameters are validated by
 * the protocol adapter so a malformed value is rejected before the token is
 * consumed and the node row is written.
 */
function validateEndpoints(endpoints: EnrollEndpointInput[]): ValidatedEndpoint[] {
	if (endpoints.length === 0) {
		throw new AppError('VALIDATION_ERROR', 'Enrollment must report at least one endpoint', 422);
	}
	if (endpoints.length > MAX_ENDPOINTS) {
		throw new AppError('VALIDATION_ERROR', `Enrollment must not report more than ${MAX_ENDPOINTS} endpoints`, 422);
	}
	const names = uniqueEndpointNames(endpoints);
	return endpoints.map((endpoint, index) => {
		if (!isAgentProtocol(endpoint.protocol)) {
			throw new AppError('VALIDATION_ERROR', `Unsupported endpoint protocol: ${endpoint.protocol}`, 422);
		}
		const adapter = getProtocolAdapter(endpoint.protocol);
		if (!adapter) {
			throw new AppError('VALIDATION_ERROR', `Unsupported endpoint protocol: ${endpoint.protocol}`, 422);
		}
		const params = adapter.paramsSchema.safeParse(endpoint.params);
		if (!params.success) {
			throw new AppError('VALIDATION_ERROR', `Invalid parameters for endpoint ${endpoint.name}`, 422);
		}
		return {
			id: newId(),
			name: names[index] as string,
			protocol: endpoint.protocol,
			host: '',
			port: endpoint.port,
			params: params.data as Record<string, unknown>,
		};
	});
}

/**
 * Validates a one-time enrollment token from `Authorization: Bearer <id>.<secret>`,
 * atomically consumes it, and provisions a new node plus the endpoints the node
 * reported, along with a default subscriber grant.
 */
/** Truncates by code point so a name cannot be split inside a surrogate pair. */
function truncateName(name: string, limit: number): string {
	const points = Array.from(name);
	return points.length > limit ? points.slice(0, limit).join('') : name;
}

export async function enrollNode(
	db: D1Database,
	authorizationHeader: string | undefined,
	input: EnrollInput,
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

	const endpoints = validateEndpoints(input.endpoints).map((endpoint) => ({ ...endpoint, host: input.host }));
	const nodeId = newId();

	const consumed = await consumeEnrollmentToken(db, row.id, now);
	if (!consumed) {
		throw new AppError('UNAUTHORIZED', 'Enrollment token is expired or already used', 401);
	}

	const { statements, agentToken } = await prepareNodeProvision(db, {
		nodeId,
		name: nodeName,
		heartbeatInterval: row.heartbeat_interval_seconds,
		endpoints,
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
		endpoints: endpoints.map((endpoint) => ({
			id: endpoint.id,
			name: endpoint.name,
			protocol: endpoint.protocol,
			port: endpoint.port,
		})),
	};
}
