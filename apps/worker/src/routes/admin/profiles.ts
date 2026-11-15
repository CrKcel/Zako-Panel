import { Hono } from 'hono';
import { noContent, ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import { requireRole } from '../../middleware/roles';
import { createProfile, deleteProfile, getProfile, listProfiles, updateProfile } from '../../services/profile-service';
import { previewProfile } from '../../services/subscription-service';
import type { AppEnv } from '../../types';
import { createProfileSchema, listQuerySchema, pathId, previewProfileQuerySchema, updateProfileSchema } from '../schemas';

export const profileRoutes = new Hono<AppEnv>();

profileRoutes.get('/', requireRole('viewer'), async (c) => {
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listProfiles(c.env.DB, query));
});

profileRoutes.post('/', requireRole('admin'), async (c) => {
	const input = await readJson(c, createProfileSchema);
	return ok(c, await createProfile(c.env.DB, input), 201);
});

profileRoutes.get('/:profileId', requireRole('viewer'), async (c) => {
	const profileId = pathId(c, 'profileId');
	return ok(c, await getProfile(c.env.DB, profileId));
});

profileRoutes.get('/:profileId/preview', requireRole('viewer'), async (c) => {
	const profileId = pathId(c, 'profileId');
	const query = readQuery(c, previewProfileQuerySchema);
	return ok(c, await previewProfile(c.env.DB, profileId, query.subscriberId));
});

profileRoutes.patch('/:profileId', requireRole('admin'), async (c) => {
	const profileId = pathId(c, 'profileId');
	const input = await readJson(c, updateProfileSchema);
	return ok(c, await updateProfile(c.env.DB, profileId, input));
});

profileRoutes.delete('/:profileId', requireRole('admin'), async (c) => {
	const profileId = pathId(c, 'profileId');
	await deleteProfile(c.env.DB, profileId);
	return noContent(c);
});
