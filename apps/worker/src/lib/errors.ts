import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorCode =
	| 'BAD_REQUEST'
	| 'VALIDATION_ERROR'
	| 'UNAUTHORIZED'
	| 'FORBIDDEN'
	| 'NOT_FOUND'
	| 'CONFLICT'
	| 'PAYLOAD_TOO_LARGE'
	| 'UNPROCESSABLE_ENTITY'
	| 'TOO_MANY_REQUESTS'
	| 'NOT_IMPLEMENTED'
	| 'INTERNAL_ERROR'
	| 'SERVICE_UNAVAILABLE'
	| 'REPORT_CONFLICT'
	| 'NODE_NOT_FOUND'
	| 'SUBSCRIPTION_INVALID'
	| 'SUBSCRIPTION_UNAVAILABLE';

export class AppError extends Error {
	readonly code: ErrorCode;
	readonly status: ContentfulStatusCode;

	constructor(code: ErrorCode, message: string, status: ContentfulStatusCode) {
		super(message);
		this.name = 'AppError';
		this.code = code;
		this.status = status;
	}
}

export function notImplemented(operation: string): AppError {
	return new AppError('NOT_IMPLEMENTED', `${operation} is not implemented`, 501);
}
