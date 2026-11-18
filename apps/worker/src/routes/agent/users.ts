import { Hono } from 'hono';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/response';
import { listNodeUsers } from '../../services/user-sync-service';
import type { AppEnv } from '../../types';

export const usersRoutes = new Hono<AppEnv>();

/** Accepts the exact tag the Worker emits plus weak and wildcard validators. */
function matchesEntityTag(header: string, etag: string): boolean {
	return header.split(',').some((candidate) => {
		const value = candidate.trim();
		return value === '*' || value === etag || value === `W/${etag}`;
	});
}

usersRoutes.get('/', async (c) => {
	const nodeId = c.get('agent')?.nodeId;
	if (!nodeId) throw new AppError('UNAUTHORIZED', 'Missing agent identity', 401);
	const users = await listNodeUsers(c.env.DB, nodeId);
	const etag = `"${users.version}"`;
	c.header('ETag', etag);

	const ifNoneMatch = c.req.header('If-None-Match');
	if (ifNoneMatch && matchesEntityTag(ifNoneMatch, etag)) {
		return c.body(null, 304);
	}
	return ok(c, users);
});
