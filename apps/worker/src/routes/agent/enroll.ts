import { Hono } from 'hono';
import { ok } from '../../lib/response';
import { readJson } from '../../lib/validation';
import { enrollNode } from '../../services/enrollment-service';
import type { AppEnv } from '../../types';
import { agentEnrollSchema } from '../schemas';

export const enrollRoutes = new Hono<AppEnv>();

enrollRoutes.post('/', async (c) => {
	const input = await readJson(c, agentEnrollSchema);
	return ok(c, await enrollNode(c.env.DB, c.req.header('Authorization'), input), 201);
});
