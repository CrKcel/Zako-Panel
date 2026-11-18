import { Hono } from 'hono';
import { noContent, ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import { createProfile, deleteProfile, getProfile, listProfiles, updateProfile } from '../../services/profile-service';
import { previewProfile } from '../../services/distribution';
import type { AppEnv } from '../../types';
import { createProfileSchema, listQuerySchema, pathId, previewProfileQuerySchema, updateProfileSchema } from '../schemas';

export const profileRoutes = new Hono<AppEnv>();

profileRoutes.get('/', async (c) => {
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listProfiles(c.env.DB, query));
});

profileRoutes.post('/', async (c) => {
	const input = await readJson(c, createProfileSchema);
	return ok(c, await createProfile(c.env.DB, input), 201);
});

profileRoutes.get('/:profileId', async (c) => {
	const profileId = pathId(c, 'profileId');
	return ok(c, await getProfile(c.env.DB, profileId));
});

profileRoutes.get('/:profileId/preview', async (c) => {
	const profileId = pathId(c, 'profileId');
	const query = readQuery(c, previewProfileQuerySchema);
	return ok(c, await previewProfile(c.env.DB, profileId, query.subscriberId));
});

profileRoutes.patch('/:profileId', async (c) => {
	const profileId = pathId(c, 'profileId');
	const input = await readJson(c, updateProfileSchema);
	return ok(c, await updateProfile(c.env.DB, profileId, input));
});

profileRoutes.delete('/:profileId', async (c) => {
	const profileId = pathId(c, 'profileId');
	await deleteProfile(c.env.DB, profileId);
	return noContent(c);
});
