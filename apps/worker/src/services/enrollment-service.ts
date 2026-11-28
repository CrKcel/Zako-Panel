import type {
	AgentEndpointProtocol,
	AgentEnrollResponse,
	NodeEnrollmentTokenStatus,
	RotateNodeEnrollmentTokenResponse,
} from '@zako/contracts';
import { isUniqueConstraintError } from '../lib/db-errors';
import { AppError } from '../lib/errors';
import { sha256Hex, timingSafeEqualHex } from '../lib/hash';
import { newId } from '../lib/ids';
import { nowSeconds } from '../lib/node-status';
import { generateToken, isTokenShaped } from '../lib/token';
import { getProtocolAdapter, isAgentProtocol } from '../protocols';
import { insertAuditEventStatement } from '../repositories/audit-events';
import { getMetaValue, getMetaValues, META_KEYS, upsertMetaStatement } from '../repositories/meta';
import { findNodeByName } from '../repositories/nodes';
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

const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 300;
const MAX_ENDPOINTS = 16;

export async function getEnrollmentTokenStatus(db: D1Database): Promise<NodeEnrollmentTokenStatus> {
	const values = await getMetaValues(db, [META_KEYS.enrollmentTokenHash, META_KEYS.enrollmentTokenRotatedAt]);
	const hash = values.get(META_KEYS.enrollmentTokenHash);
	const configured = Boolean(hash && hash.length > 0);
	if (!configured) {
		return { configured: false, rotated_at: null };
	}
	const rawRotatedAt = values.get(META_KEYS.enrollmentTokenRotatedAt);
	const parsedRotatedAt = rawRotatedAt !== undefined ? Number(rawRotatedAt) : NaN;
	const rotatedAt = Number.isSafeInteger(parsedRotatedAt) && parsedRotatedAt >= 0 ? parsedRotatedAt : null;
	return { configured: true, rotated_at: rotatedAt };
}

export async function rotateEnrollmentToken(db: D1Database, actorEmail?: string): Promise<RotateNodeEnrollmentTokenResponse> {
	const now = nowSeconds();
	const token = generateToken();
	const tokenHash = await sha256Hex(token);

	await db.batch([
		upsertMetaStatement(db, META_KEYS.enrollmentTokenHash, tokenHash),
		upsertMetaStatement(db, META_KEYS.enrollmentTokenRotatedAt, String(now)),
		insertAuditEventStatement(db, {
			id: newId(),
			actor_email: actorEmail ?? null,
			action: 'enrollment_token.rotate',
			target_type: 'enrollment_token',
			target_id: null,
			detail_json: null,
			created_at: now,
		}),
	]);

	return { token, rotated_at: now };
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
 * the protocol adapter so a malformed value is rejected before the node row is
 * written.
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

/** Truncates by code point so a name cannot be split inside a surrogate pair. */
function truncateName(name: string, limit: number): string {
	const points = Array.from(name);
	return points.length > limit ? points.slice(0, limit).join('') : name;
}

/**
 * Validates the panel-wide reusable enrollment token from
 * `Authorization: Bearer <token>` and provisions a new node plus the endpoints
 * the node reported.
 */
export async function enrollNode(
	db: D1Database,
	authorizationHeader: string | undefined,
	input: EnrollInput,
): Promise<AgentEnrollResponse> {
	const bearer = authorizationHeader?.startsWith('Bearer ') ? authorizationHeader.slice('Bearer '.length).trim() : undefined;
	if (!bearer || !isTokenShaped(bearer)) {
		throw new AppError('UNAUTHORIZED', 'Invalid enrollment token', 401);
	}

	const storedHash = await getMetaValue(db, META_KEYS.enrollmentTokenHash);
	if (!storedHash) {
		throw new AppError('UNAUTHORIZED', 'Invalid enrollment token', 401);
	}
	const presentedHash = await sha256Hex(bearer);
	if (!timingSafeEqualHex(presentedHash, storedHash)) {
		throw new AppError('UNAUTHORIZED', 'Invalid enrollment token', 401);
	}

	const nodeName = truncateName(input.name, 64);
	if (await findNodeByName(db, nodeName)) {
		throw new AppError('CONFLICT', 'Node name already exists', 409);
	}

	const endpoints = validateEndpoints(input.endpoints).map((endpoint) => ({ ...endpoint, host: input.host }));
	const nodeId = newId();
	const now = nowSeconds();

	const { statements, agentToken } = await prepareNodeProvision(db, {
		nodeId,
		name: nodeName,
		heartbeatInterval: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
		endpoints,
		now,
	});

	try {
		await db.batch(statements);
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw new AppError('CONFLICT', 'Node name already exists', 409);
		}
		throw error;
	}

	return {
		node_id: nodeId,
		agent_token: agentToken,
		heartbeat_interval_seconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
		endpoints: endpoints.map((endpoint) => ({
			id: endpoint.id,
			name: endpoint.name,
			protocol: endpoint.protocol,
			port: endpoint.port,
		})),
	};
}
