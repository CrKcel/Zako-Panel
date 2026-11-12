import type { MiddlewareHandler } from 'hono';
import { newId } from '../lib/ids';
import type { AppEnv } from '../types';

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
	const requestId = newId();
	c.set('requestId', requestId);
	c.set('startedAt', Date.now());
	c.header('X-Request-Id', requestId);
	await next();
};
