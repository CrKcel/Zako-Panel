import { Hono } from 'hono';
import { AppError } from '../lib/errors';
import { isTokenShaped } from '../lib/token';
import { readQuery } from '../lib/validation';
import { getClashSubscription, getUriSubscription } from '../services/subscription-service';
import type { AppEnv, AppContext } from '../types';
import { subscriptionEncodingSchema } from './schemas';

export const subscriptionRoutes = new Hono<AppEnv>();

function subscriptionToken(c: AppContext): string {
	const token = c.req.param('token');
	if (!token || !isTokenShaped(token)) {
		throw new AppError('UNAUTHORIZED', 'Invalid subscription token', 401);
	}
	return token;
}

subscriptionRoutes.get('/:token/clash.yaml', async (c) => {
	const token = subscriptionToken(c);
	const rendered = await getClashSubscription(c.env.DB, token);
	return c.body(rendered.body, 200, {
		'Content-Type': `${rendered.contentType}; charset=utf-8`,
		'Cache-Control': 'private, no-store',
		'profile-update-interval': '6',
		...rendered.headers,
	});
});

subscriptionRoutes.get('/:token/uri', async (c) => {
	const token = subscriptionToken(c);
	const { encoding } = readQuery(c, subscriptionEncodingSchema);
	const rendered = await getUriSubscription(c.env.DB, token, encoding);
	return c.body(rendered.body, 200, {
		'Content-Type': `${rendered.contentType}; charset=utf-8`,
		'Cache-Control': 'private, no-store',
		'profile-update-interval': '6',
		...rendered.headers,
	});
});
