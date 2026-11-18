import { Hono } from 'hono';
import { ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import {
	createSubscriber,
	getSubscriber,
	listSubscribers,
	replaceSubscriberNodes,
	updateSubscriber,
} from '../../services/subscriber-service';
import type { AppEnv } from '../../types';
import { createSubscriberSchema, listQuerySchema, pathId, replaceSubscriberNodesSchema, updateSubscriberSchema } from '../schemas';

export const subscriberRoutes = new Hono<AppEnv>();

subscriberRoutes.get('/', async (c) => {
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listSubscribers(c.env.DB, query));
});

subscriberRoutes.post('/', async (c) => {
	const input = await readJson(c, createSubscriberSchema);
	return ok(c, await createSubscriber(c.env.DB, input), 201);
});

subscriberRoutes.get('/:subscriberId', async (c) => {
	const subscriberId = pathId(c, 'subscriberId');
	return ok(c, await getSubscriber(c.env.DB, subscriberId));
});

subscriberRoutes.patch('/:subscriberId', async (c) => {
	const subscriberId = pathId(c, 'subscriberId');
	const input = await readJson(c, updateSubscriberSchema);
	return ok(c, await updateSubscriber(c.env.DB, subscriberId, input));
});

subscriberRoutes.put('/:subscriberId/nodes', async (c) => {
	const subscriberId = pathId(c, 'subscriberId');
	const input = await readJson(c, replaceSubscriberNodesSchema);
	return ok(c, await replaceSubscriberNodes(c.env.DB, subscriberId, input.node_ids));
});
