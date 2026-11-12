import type { MiddlewareHandler } from 'hono';
import { AppError } from '../lib/errors';
import { sha256Hex, timingSafeEqualHex } from '../lib/hash';
import { parseAgentToken } from '../lib/token';
import { findAgentAuthById } from '../repositories/nodes';
import type { AppEnv } from '../types';

export const agentAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const header = c.req.header('Authorization');
	const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
	const parsed = parseAgentToken(token);
	if (!parsed) throw new AppError('UNAUTHORIZED', 'Invalid agent token', 401);

	const node = await findAgentAuthById(c.env.DB, parsed.nodeId);
	if (!node || node.enabled !== 1) {
		throw new AppError('UNAUTHORIZED', 'Invalid agent token', 401);
	}

	const presentedHash = await sha256Hex(parsed.secret);
	if (!timingSafeEqualHex(presentedHash, node.agent_token_hash)) {
		throw new AppError('UNAUTHORIZED', 'Invalid agent token', 401);
	}

	c.set('agent', { nodeId: node.id });
	await next();
};
