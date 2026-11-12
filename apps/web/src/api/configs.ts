import type { ConfigVersion, PublishConfigRequest } from '@zako/contracts';
import { apiPage, apiRequest, type Page } from './client';

export interface ConfigListParams {
	limit?: number;
	cursor?: string;
}

export const configsApi = {
	list(nodeId: string, params: ConfigListParams = {}): Promise<Page<ConfigVersion>> {
		return apiPage<ConfigVersion>(`/api/v1/admin/nodes/${nodeId}/configs`, { query: { ...params } });
	},
	publish(nodeId: string, input: PublishConfigRequest): Promise<ConfigVersion> {
		return apiRequest<ConfigVersion>(`/api/v1/admin/nodes/${nodeId}/configs`, {
			method: 'POST',
			body: input,
		});
	},
	get(nodeId: string, version: number): Promise<ConfigVersion> {
		return apiRequest<ConfigVersion>(`/api/v1/admin/nodes/${nodeId}/configs/${version}`);
	},
	rollback(nodeId: string, version: number): Promise<ConfigVersion> {
		return apiRequest<ConfigVersion>(`/api/v1/admin/nodes/${nodeId}/configs/${version}/rollback`, {
			method: 'POST',
		});
	},
};
