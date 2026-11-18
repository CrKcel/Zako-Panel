import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { errorHandler } from '../src/middleware/error-handler';
import { adminRoutes } from '../src/routes/admin';
import { createAdmin, listAdmins, updateAdmin } from '../src/services/admin-service';
import type { AppEnv } from '../src/types';
import { seedAdmin } from './helpers';

const app = new Hono<AppEnv>();
app.route('/api/v1/admin', adminRoutes);
app.onError(errorHandler);

function requestAs(email: string, path: string, init: RequestInit = {}): Promise<Response> {
	const testEnv: Env = { DB: env.DB, ENVIRONMENT: 'development', DEV_ADMIN_EMAIL: email };
	return Promise.resolve(app.request(`https://panel.test${path}`, init, testEnv));
}

describe('administrator management', () => {
	it('creates, lists and updates administrators', async () => {
		const created = await createAdmin(env.DB, { email: 'Ops@Example.com', role: 'admin' });
		expect(created.email).toBe('ops@example.com');
		expect(created.enabled).toBe(true);

		const page = await listAdmins(env.DB, { limit: 10 });
		expect(page.items.map((item) => item.email)).toEqual(['ops@example.com']);

		const updated = await updateAdmin(env.DB, created.id, { role: 'viewer', enabled: false });
		expect(updated.role).toBe('viewer');
		expect(updated.enabled).toBe(false);
	});

	it('rejects a duplicate email', async () => {
		await createAdmin(env.DB, { email: 'owner@example.com', role: 'owner' });
		await expect(createAdmin(env.DB, { email: 'OWNER@example.com', role: 'admin' })).rejects.toMatchObject({ status: 409 });
	});

	it('never removes the last enabled owner', async () => {
		const ownerId = await seedAdmin({ email: 'owner@example.com', role: 'owner' });
		const secondOwnerId = await seedAdmin({ email: 'second@example.com', role: 'owner' });

		expect((await updateAdmin(env.DB, secondOwnerId, { enabled: false })).enabled).toBe(false);
		await expect(updateAdmin(env.DB, ownerId, { enabled: false })).rejects.toMatchObject({ status: 409 });
		await expect(updateAdmin(env.DB, ownerId, { role: 'viewer' })).rejects.toMatchObject({ status: 409 });

		await updateAdmin(env.DB, secondOwnerId, { enabled: true });
		const demoted = await updateAdmin(env.DB, ownerId, { role: 'admin' });
		expect(demoted.role).toBe('admin');
	});

	it('applies role boundaries to the admin routes', async () => {
		await seedAdmin({ email: 'viewer@example.com', role: 'viewer' });
		await seedAdmin({ email: 'admin@example.com', role: 'admin' });
		await seedAdmin({ email: 'owner@example.com', role: 'owner' });

		expect((await requestAs('viewer@example.com', '/api/v1/admin/subscribers')).status).toBe(200);
		expect(
			(
				await requestAs('viewer@example.com', '/api/v1/admin/subscribers', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: 'Viewer made' }),
				})
			).status,
		).toBe(403);

		const created = await requestAs('admin@example.com', '/api/v1/admin/subscribers', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Admin made' }),
		});
		expect(created.status).toBe(201);

		expect((await requestAs('admin@example.com', '/api/v1/admin/admins')).status).toBe(403);
		expect((await requestAs('owner@example.com', '/api/v1/admin/admins')).status).toBe(200);

		const seeded = await seedAdmin({ email: 'last-owner@example.com', role: 'owner' });
		await env.DB.prepare('UPDATE admin_users SET enabled = 0 WHERE id <> ?').bind(seeded).run();
		const rejected = await requestAs('last-owner@example.com', `/api/v1/admin/admins/${seeded}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled: false }),
		});
		expect(rejected.status).toBe(409);
		expect((await rejected.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'CONFLICT' } });
	});

	it('rejects malformed administrator requests at the route boundary', async () => {
		await seedAdmin({ email: 'owner@example.com', role: 'owner' });
		const invalidEmail = await requestAs('owner@example.com', '/api/v1/admin/admins', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'not-an-email', role: 'admin' }),
		});
		expect(invalidEmail.status).toBe(400);

		const derivedStatus = await requestAs('owner@example.com', '/api/v1/admin/subscribers/01J2Z6Q8Y3V9M4K7T1B5C0D2E6', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'limited' }),
		});
		expect(derivedStatus.status).toBe(400);

		const emptyPatch = await requestAs('owner@example.com', '/api/v1/admin/admins/01J2Z6Q8Y3V9M4K7T1B5C0D2E6', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(emptyPatch.status).toBe(400);
	});
});
