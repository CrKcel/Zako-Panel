import type { CreateSubscriberRequest, Subscriber, UpdateSubscriberRequest } from '@zako/contracts';
import { apiPage, apiRequest, LIST_LIMIT, type Page } from './client';

export interface SubscriberListParams {
	limit?: number;
	cursor?: string;
}

export const subscribersApi = {
	list(params: SubscriberListParams = {}): Promise<Page<Subscriber>> {
		return apiPage<Subscriber>('/api/v1/admin/subscribers', { query: { limit: LIST_LIMIT, ...params } });
	},
	create(input: CreateSubscriberRequest): Promise<Subscriber> {
		return apiRequest<Subscriber>('/api/v1/admin/subscribers', { method: 'POST', body: input });
	},
	get(subscriberId: string): Promise<Subscriber> {
		return apiRequest<Subscriber>(`/api/v1/admin/subscribers/${subscriberId}`);
	},
	update(subscriberId: string, input: UpdateSubscriberRequest): Promise<Subscriber> {
		return apiRequest<Subscriber>(`/api/v1/admin/subscribers/${subscriberId}`, { method: 'PATCH', body: input });
	},
};
