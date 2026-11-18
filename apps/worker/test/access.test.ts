import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { accessAuth } from '../src/middleware/access';
import { errorHandler } from '../src/middleware/error-handler';
import type { AppEnv } from '../src/types';

const app = new Hono<AppEnv>();
app.use('*', accessAuth);
app.onError(errorHandler);
app.get('/', (c) => c.json({ email: c.get('admin')?.email }));

function request(init: RequestInit | undefined, overrides: Partial<Env>): Promise<Response> {
	return Promise.resolve(
		app.request('https://panel.test/', init, {
			DB: env.DB,
			ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
			ACCESS_AUD: 'aud',
			...overrides,
		}),
	);
}

describe('admin access', () => {
	it('authenticates local development requests by DEV_ADMIN_EMAIL without a D1 admin row', async () => {
		const response = await request(undefined, { ENVIRONMENT: 'development', DEV_ADMIN_EMAIL: 'Dev@Example.com' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ email: 'dev@example.com' });
	});

	it('keeps the Access requirement outside local development', async () => {
		const production = await request(undefined, { ENVIRONMENT: 'production', DEV_ADMIN_EMAIL: 'dev@example.com' });
		expect(production.status).toBe(401);

		const missingEmail = await request(undefined, { ENVIRONMENT: 'development' });
		expect(missingEmail.status).toBe(401);
	});

	it('never replaces a presented Access token with the development identity', async () => {
		const response = await request(
			{ headers: { 'Cf-Access-Jwt-Assertion': 'token' } },
			{ ENVIRONMENT: 'development', DEV_ADMIN_EMAIL: 'dev@example.com', ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined },
		);
		expect(response.status).toBe(500);
	});
});
