import { Hono } from 'hono';
import { ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import { createSubscription, listSubscriptions, revokeSubscription, updateSubscription } from '../../services/subscription-service';
import type { AppEnv } from '../../types';
import { createSubscriptionSchema, listQuerySchema, pathId, updateSubscriptionSchema } from '../schemas';

export const subscriptionRoutes = new Hono<AppEnv>();

subscriptionRoutes.get('/', async (c) => {
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listSubscriptions(c.env.DB, query));
});

subscriptionRoutes.post('/', async (c) => {
	const input = await readJson(c, createSubscriptionSchema);
	return ok(c, await createSubscription(c.env.DB, input), 201);
});

subscriptionRoutes.patch('/:subscriptionId', async (c) => {
	const subscriptionId = pathId(c, 'subscriptionId');
	const input = await readJson(c, updateSubscriptionSchema);
	return ok(c, await updateSubscription(c.env.DB, subscriptionId, input));
});

subscriptionRoutes.post('/:subscriptionId/revoke', async (c) => {
	const subscriptionId = pathId(c, 'subscriptionId');
	return ok(c, await revokeSubscription(c.env.DB, subscriptionId));
});
