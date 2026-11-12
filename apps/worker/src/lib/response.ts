import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode } from './errors';
import type { AppContext, Paginated } from '../types';

export function ok<T>(c: AppContext, data: T, status: ContentfulStatusCode = 200) {
	return c.json({ data, meta: { request_id: c.get('requestId') } }, status);
}

export function okPage<T>(c: AppContext, page: Paginated<T>) {
	return c.json(
		{
			data: { items: page.items },
			meta: { request_id: c.get('requestId'), next_cursor: page.next_cursor },
		},
		200,
	);
}

export function noContent(c: AppContext) {
	return c.body(null, 204);
}

export function fail(c: AppContext, status: ContentfulStatusCode, code: ErrorCode, message: string) {
	return c.json(
		{
			error: {
				code,
				message,
				request_id: c.get('requestId'),
			},
		},
		status,
	);
}
