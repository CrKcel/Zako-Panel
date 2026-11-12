import { Hono } from 'hono';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/response';
import { readJson } from '../../lib/validation';
import { ingestReport } from '../../services/traffic-service';
import type { AppEnv } from '../../types';
import { agentReportSchema } from '../schemas';

export const reportRoutes = new Hono<AppEnv>();

reportRoutes.post('/', async (c) => {
	const nodeId = c.get('agent')?.nodeId;
	if (!nodeId) throw new AppError('UNAUTHORIZED', 'Missing agent identity', 401);
	const report = await readJson(c, agentReportSchema);
	return ok(c, await ingestReport(c.env.DB, nodeId, report));
});
