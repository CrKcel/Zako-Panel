import type { ErrorHandler, NotFoundHandler } from 'hono';
import { AppError } from '../lib/errors';
import { log } from '../lib/log';
import { fail } from '../lib/response';
import type { AppEnv } from '../types';

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
	const requestId = c.get('requestId') ?? '';

	if (err instanceof AppError) {
		c.set('errorCode', err.code);
		if (err.status >= 500) {
			log('error', {
				request_id: requestId,
				route: c.req.routePath,
				code: err.code,
				message: err.message,
				status: err.status,
			});
		}
		return fail(c, err.status, err.code, err.message);
	}

	c.set('errorCode', 'INTERNAL_ERROR');
	log('error', {
		request_id: requestId,
		route: c.req.routePath,
		code: 'INTERNAL_ERROR',
		message: err.message,
		status: 500,
	});
	return fail(c, 500, 'INTERNAL_ERROR', 'Internal server error');
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
	c.set('errorCode', 'NOT_FOUND');
	return fail(c, 404, 'NOT_FOUND', 'Route not found');
};
