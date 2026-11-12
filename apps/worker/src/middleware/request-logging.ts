import type { MiddlewareHandler } from 'hono';
import { log } from '../lib/log';
import type { AppEnv } from '../types';

export const requestLogging: MiddlewareHandler<AppEnv> = async (c, next) => {
	await next();
	log('info', {
		request_id: c.get('requestId'),
		method: c.req.method,
		route: c.req.routePath,
		status: c.res.status,
		error_code: c.get('errorCode'),
		duration_ms: Date.now() - c.get('startedAt'),
	});
};
