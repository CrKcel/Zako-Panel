import { Hono } from 'hono';
import { ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import { requireRole } from '../../middleware/roles';
import { createAdmin, listAdmins, updateAdmin } from '../../services/admin-service';
import type { AppEnv } from '../../types';
import { createAdminSchema, listQuerySchema, pathId, updateAdminSchema } from '../schemas';

export const adminUserRoutes = new Hono<AppEnv>();

adminUserRoutes.get('/', requireRole('owner'), async (c) => {
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listAdmins(c.env.DB, query));
});

adminUserRoutes.post('/', requireRole('owner'), async (c) => {
	const input = await readJson(c, createAdminSchema);
	return ok(c, await createAdmin(c.env.DB, input), 201);
});

adminUserRoutes.patch('/:adminId', requireRole('owner'), async (c) => {
	const adminId = pathId(c, 'adminId');
	const input = await readJson(c, updateAdminSchema);
	return ok(c, await updateAdmin(c.env.DB, adminId, input));
});
