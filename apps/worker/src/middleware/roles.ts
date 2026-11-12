import type { AdminRole } from '@zako/contracts';
import type { MiddlewareHandler } from 'hono';
import { AppError } from '../lib/errors';
import type { AppEnv } from '../types';

const ROLE_LEVEL: Record<AdminRole, number> = {
	viewer: 1,
	admin: 2,
	owner: 3,
};

export function hasRole(role: AdminRole, required: AdminRole): boolean {
	return ROLE_LEVEL[role] >= ROLE_LEVEL[required];
}

export function requireRole(required: AdminRole): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const admin = c.get('admin');
		if (!admin) throw new AppError('UNAUTHORIZED', 'Missing administrator identity', 401);
		if (!hasRole(admin.role, required)) {
			throw new AppError('FORBIDDEN', 'Insufficient role', 403);
		}
		await next();
	};
}
