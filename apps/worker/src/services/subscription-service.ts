import type { CreateSubscriptionRequest, Subscription } from '@zako/contracts';
import { notImplemented } from '../lib/errors';
import type { Paginated } from '../types';
import type { ListQuery } from './node-service';

export type SubscriptionEncoding = 'base64' | 'plain';

export interface RenderedSubscription {
	body: string;
	contentType: 'application/yaml' | 'text/plain';
	headers: Record<string, string>;
}

export async function listSubscriptions(_db: D1Database, _query: ListQuery): Promise<Paginated<Subscription>> {
	throw notImplemented('subscription listing');
}

export async function createSubscription(
	_db: D1Database,
	_input: CreateSubscriptionRequest,
): Promise<{ subscription: Subscription; token: string }> {
	throw notImplemented('subscription creation');
}

export async function rotateSubscription(_db: D1Database, _subscriptionId: string): Promise<{ token: string }> {
	throw notImplemented('subscription token rotation');
}

export async function revokeSubscription(_db: D1Database, _subscriptionId: string): Promise<Subscription> {
	throw notImplemented('subscription revocation');
}

export async function getClashSubscription(_db: D1Database, _token: string): Promise<RenderedSubscription> {
	throw notImplemented('Clash subscription rendering');
}

export async function getUriSubscription(_db: D1Database, _token: string, _encoding: SubscriptionEncoding): Promise<RenderedSubscription> {
	throw notImplemented('URI subscription rendering');
}
