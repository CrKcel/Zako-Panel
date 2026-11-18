import { Hono } from 'hono';
import { AppError } from '../../lib/errors';
import { noContent, ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import { createEnrollmentToken, listEnrollmentTokens, revokeEnrollmentToken } from '../../services/enrollment-service';
import type { AppEnv } from '../../types';
import { createEnrollmentTokenSchema, listQuerySchema, pathId } from '../schemas';

export const enrollmentTokenRoutes = new Hono<AppEnv>();

enrollmentTokenRoutes.get('/', async (c) => {
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listEnrollmentTokens(c.env.DB, query));
});

enrollmentTokenRoutes.post('/', async (c) => {
	const input = await readJson(c, createEnrollmentTokenSchema);
	const admin = c.get('admin');
	if (!admin) throw new AppError('UNAUTHORIZED', 'Missing admin identity', 401);
	return ok(c, await createEnrollmentToken(c.env.DB, input, admin.email), 201);
});

enrollmentTokenRoutes.delete('/:tokenId', async (c) => {
	const tokenId = pathId(c, 'tokenId');
	await revokeEnrollmentToken(c.env.DB, tokenId);
	return noContent(c);
});
