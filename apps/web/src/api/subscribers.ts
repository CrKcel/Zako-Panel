import type {
	CreateSubscriberRequest,
	ReplaceSubscriberNodesRequest,
	Subscriber,
	SubscriberDetail,
	UpdateSubscriberRequest,
} from '@zako/contracts';
import { apiPage, apiRequest, type Page } from './client';

export interface SubscriberListParams {
	limit?: number;
	cursor?: string;
}

export const subscribersApi = {
	list(params: SubscriberListParams = {}): Promise<Page<Subscriber>> {
		return apiPage<Subscriber>('/api/v1/admin/subscribers', { query: { ...params } });
	},
	create(input: CreateSubscriberRequest): Promise<Subscriber> {
		return apiRequest<Subscriber>('/api/v1/admin/subscribers', { method: 'POST', body: input });
	},
	get(subscriberId: string): Promise<SubscriberDetail> {
		return apiRequest<SubscriberDetail>(`/api/v1/admin/subscribers/${subscriberId}`);
	},
	update(subscriberId: string, input: UpdateSubscriberRequest): Promise<Subscriber> {
		return apiRequest<Subscriber>(`/api/v1/admin/subscribers/${subscriberId}`, { method: 'PATCH', body: input });
	},
	replaceNodes(subscriberId: string, nodeIds: string[]): Promise<SubscriberDetail> {
		const input: ReplaceSubscriberNodesRequest = { node_ids: nodeIds };
		return apiRequest<SubscriberDetail>(`/api/v1/admin/subscribers/${subscriberId}/nodes`, {
			method: 'PUT',
			body: input,
		});
	},
};
