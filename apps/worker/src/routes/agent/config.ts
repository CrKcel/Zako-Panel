import { Hono } from 'hono';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/response';
import { readJson } from '../../lib/validation';
import { getDesiredConfig, recordConfigResult } from '../../services/config-service';
import type { AppEnv } from '../../types';
import { agentConfigResultSchema } from '../schemas';

export const configRoutes = new Hono<AppEnv>();

configRoutes.get('/', async (c) => {
	const nodeId = c.get('agent')?.nodeId;
	if (!nodeId) throw new AppError('UNAUTHORIZED', 'Missing agent identity', 401);
	const config = await getDesiredConfig(c.env.DB, nodeId);
	if (!config) return c.body(null, 204);
	return ok(c, config);
});

configRoutes.post('/result', async (c) => {
	const nodeId = c.get('agent')?.nodeId;
	if (!nodeId) throw new AppError('UNAUTHORIZED', 'Missing agent identity', 401);
	const result = await readJson(c, agentConfigResultSchema);
	return ok(c, await recordConfigResult(c.env.DB, nodeId, result));
});
