import { Hono } from 'hono';
import { ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import { requireRole } from '../../middleware/roles';
import { createSubscription, listSubscriptions, revokeSubscription, rotateSubscription } from '../../services/subscription-service';
import type { AppEnv } from '../../types';
import { createSubscriptionSchema, listQuerySchema, pathId } from '../schemas';

export const subscriptionRoutes = new Hono<AppEnv>();

subscriptionRoutes.get('/', requireRole('viewer'), async (c) => {
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listSubscriptions(c.env.DB, query));
});

subscriptionRoutes.post('/', requireRole('admin'), async (c) => {
	const input = await readJson(c, createSubscriptionSchema);
	return ok(c, await createSubscription(c.env.DB, input), 201);
});

subscriptionRoutes.post('/:subscriptionId/rotate', requireRole('admin'), async (c) => {
	const subscriptionId = pathId(c, 'subscriptionId');
	return ok(c, await rotateSubscription(c.env.DB, subscriptionId));
});

subscriptionRoutes.post('/:subscriptionId/revoke', requireRole('admin'), async (c) => {
	const subscriptionId = pathId(c, 'subscriptionId');
	return ok(c, await revokeSubscription(c.env.DB, subscriptionId));
});
