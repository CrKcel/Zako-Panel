import { Hono } from 'hono';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/response';
import { readJson } from '../../lib/validation';
import { recordAgentUpdateResult } from '../../services/node-service';
import type { AppEnv } from '../../types';
import { agentUpdateResultSchema } from '../schemas';

export const updateRoutes = new Hono<AppEnv>();

updateRoutes.post('/result', async (c) => {
	const nodeId = c.get('agent')?.nodeId;
	if (!nodeId) throw new AppError('UNAUTHORIZED', 'Missing agent identity', 401);
	const result = await readJson(c, agentUpdateResultSchema);
	return ok(c, await recordAgentUpdateResult(c.env.DB, nodeId, result));
});
