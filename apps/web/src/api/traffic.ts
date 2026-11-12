import type { TrafficGroupBy, TrafficSummary } from '@zako/contracts';
import { apiRequest } from './client';

export interface TrafficSummaryParams {
	from: number;
	to: number;
	groupBy: TrafficGroupBy;
	nodeId?: string;
	subscriberId?: string;
}

export const trafficApi = {
	summary(params: TrafficSummaryParams): Promise<TrafficSummary> {
		return apiRequest<TrafficSummary>('/api/v1/admin/traffic/summary', {
			query: {
				from: params.from,
				to: params.to,
				groupBy: params.groupBy,
				nodeId: params.nodeId,
				subscriberId: params.subscriberId,
			},
		});
	},
};
