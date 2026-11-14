import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { findAdminByEmail } from '../repositories/admins';
import type { AppContext, AppEnv } from '../types';

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function issuerFor(teamDomain: string): string {
	const trimmed = teamDomain.trim().replace(/\/+$/, '');
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return `https://${trimmed}`;
}

function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
	const cached = jwksByIssuer.get(issuer);
	if (cached) return cached;
	const created = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
	jwksByIssuer.set(issuer, created);
	return created;
}

/**
 * Local development runs without an Access proxy, so no JWT reaches the
 * Worker. Both bindings must be set explicitly; deployed environments keep
 * ENVIRONMENT=production and therefore never take this path.
 */
function localAdminEmail(env: Env): string | null {
	const email = env.DEV_ADMIN_EMAIL?.trim().toLowerCase();
	if (env.ENVIRONMENT !== 'development' || !email) return null;
	return email;
}

async function applyAdmin(c: AppContext, email: string): Promise<void> {
	const admin = await findAdminByEmail(c.env.DB, email);
	if (!admin || admin.enabled !== 1) {
		throw new AppError('FORBIDDEN', 'Administrator is not enabled', 403);
	}
	c.set('admin', { id: admin.id, email: admin.email, role: admin.role });
}

/**
 * Verifies the Cloudflare Access JWT with the team JWKS and resolves the
 * administrator from D1. Access only gates the path; the D1 role and enabled
 * flag remain authoritative inside the worker.
 */
export const accessAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const token = c.req.header('Cf-Access-Jwt-Assertion');

	if (!token) {
		const email = localAdminEmail(c.env);
		if (!email) throw new AppError('UNAUTHORIZED', 'Missing Access token', 401);
		await applyAdmin(c, email);
		await next();
		return;
	}

	const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience } = c.env;
	if (!teamDomain || !audience) {
		throw new AppError('INTERNAL_ERROR', 'Access is not configured', 500);
	}

	const issuer = issuerFor(teamDomain);
	let email: string | null = null;
	try {
		const { payload } = await jwtVerify(token, jwksFor(issuer), { issuer, audience });
		email = typeof payload.email === 'string' ? payload.email : null;
	} catch {
		throw new AppError('UNAUTHORIZED', 'Invalid Access token', 401);
	}
	if (!email) throw new AppError('UNAUTHORIZED', 'Access token has no email claim', 401);

	await applyAdmin(c, email);
	await next();
};
