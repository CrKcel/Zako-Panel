import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import type { AppEnv } from '../types';

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

/**
 * Verifies the Cloudflare Access JWT with the team JWKS and attaches the
 * authenticated administrator's email from the token (or DEV_ADMIN_EMAIL in
 * local development). Access itself is authoritative for who may reach the
 * panel.
 */
export const accessAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const token = c.req.header('Cf-Access-Jwt-Assertion');

	if (!token) {
		const email = localAdminEmail(c.env);
		if (!email) throw new AppError('UNAUTHORIZED', 'Missing Access token', 401);
		c.set('admin', { email });
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

	c.set('admin', { email: email.trim().toLowerCase() });
	await next();
};
