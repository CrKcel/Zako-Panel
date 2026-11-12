import { Hono } from 'hono';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/response';
import { listNodeUsers } from '../../services/user-sync-service';
import type { AppEnv } from '../../types';

export const usersRoutes = new Hono<AppEnv>();

usersRoutes.get('/', async (c) => {
	const nodeId = c.get('agent')?.nodeId;
	if (!nodeId) throw new AppError('UNAUTHORIZED', 'Missing agent identity', 401);
	const users = await listNodeUsers(c.env.DB, nodeId);
	c.header('ETag', `"${users.version}"`);
	return ok(c, users);
});
