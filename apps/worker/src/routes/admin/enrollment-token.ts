import { Hono } from 'hono';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/response';
import { getEnrollmentTokenStatus, rotateEnrollmentToken } from '../../services/enrollment-service';
import type { AppEnv } from '../../types';

export const enrollmentTokenRoutes = new Hono<AppEnv>();

enrollmentTokenRoutes.get('/', async (c) => {
	return ok(c, await getEnrollmentTokenStatus(c.env.DB));
});

enrollmentTokenRoutes.post('/rotate', async (c) => {
	const admin = c.get('admin');
	if (!admin) throw new AppError('UNAUTHORIZED', 'Missing admin identity', 401);
	return ok(c, await rotateEnrollmentToken(c.env.DB, admin.email));
});
