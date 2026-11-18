import type { CreateSubscriptionRequest, Subscription } from '@zako/contracts';
import { apiPage, apiRequest, LIST_LIMIT, type Page } from './client';

export interface SubscriptionListParams {
	limit?: number;
	cursor?: string;
}

export const subscriptionsApi = {
	list(params: SubscriptionListParams = {}): Promise<Page<Subscription>> {
		return apiPage<Subscription>('/api/v1/admin/subscriptions', { query: { limit: LIST_LIMIT, ...params } });
	},
	create(input: CreateSubscriptionRequest): Promise<{ subscription: Subscription; token: string }> {
		return apiRequest<{ subscription: Subscription; token: string }>('/api/v1/admin/subscriptions', {
			method: 'POST',
			body: input,
		});
	},
	rotate(subscriptionId: string): Promise<{ token: string }> {
		return apiRequest<{ token: string }>(`/api/v1/admin/subscriptions/${subscriptionId}/rotate`, {
			method: 'POST',
		});
	},
	revoke(subscriptionId: string): Promise<Subscription> {
		return apiRequest<Subscription>(`/api/v1/admin/subscriptions/${subscriptionId}/revoke`, {
			method: 'POST',
		});
	},
};
