import { Hono } from 'hono';
import { ok } from '../../lib/response';
import { readQuery } from '../../lib/validation';
import { getTrafficSummary } from '../../services/traffic-service';
import type { AppEnv } from '../../types';
import { trafficQuerySchema } from '../schemas';

export const trafficRoutes = new Hono<AppEnv>();

trafficRoutes.get('/summary', async (c) => {
	const query = readQuery(c, trafficQuerySchema);
	return ok(c, await getTrafficSummary(c.env.DB, query));
});
