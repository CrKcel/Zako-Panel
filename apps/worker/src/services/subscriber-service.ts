import type { CreateSubscriberRequest, Subscriber, SubscriberDetail, UpdateSubscriberRequest } from '@zako/contracts';
import { notImplemented } from '../lib/errors';
import type { Paginated } from '../types';
import type { ListQuery } from './node-service';

export async function listSubscribers(_db: D1Database, _query: ListQuery): Promise<Paginated<Subscriber>> {
	throw notImplemented('subscriber listing');
}

export async function createSubscriber(_db: D1Database, _input: CreateSubscriberRequest): Promise<Subscriber> {
	throw notImplemented('subscriber creation');
}

export async function getSubscriber(_db: D1Database, _subscriberId: string): Promise<SubscriberDetail> {
	throw notImplemented('subscriber lookup');
}

export async function updateSubscriber(_db: D1Database, _subscriberId: string, _input: UpdateSubscriberRequest): Promise<Subscriber> {
	throw notImplemented('subscriber update');
}

export async function replaceSubscriberNodes(_db: D1Database, _subscriberId: string, _nodeIds: string[]): Promise<SubscriberDetail> {
	throw notImplemented('subscriber node grants');
}
