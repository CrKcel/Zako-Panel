import type {
	ConfigVersion,
	CreateEndpointRequest,
	CreateNodeEnrollmentTokenRequest,
	Endpoint,
	Node,
	NodeClient,
	NodeEnrollmentToken,
	UpdateEndpointRequest,
	UpdateNodeRequest,
} from '@zako/contracts';
import { apiPage, apiRequest, LIST_LIMIT, type Page } from './client';

export interface NodeListParams {
	limit?: number;
	cursor?: string;
}

export interface NodeDetail {
	node: Node;
	endpoints: Endpoint[];
}

export interface CreateEnrollmentTokenResult {
	enrollment_token: NodeEnrollmentToken;
	token: string;
}

export const nodesApi = {
	list(params: NodeListParams = {}): Promise<Page<Node>> {
		return apiPage<Node>('/api/v1/admin/nodes', { query: { limit: LIST_LIMIT, ...params } });
	},
	listEnrollmentTokens(params: NodeListParams = {}): Promise<Page<NodeEnrollmentToken>> {
		return apiPage<NodeEnrollmentToken>('/api/v1/admin/node-enrollment-tokens', {
			query: { limit: LIST_LIMIT, ...params },
		});
	},
	createEnrollmentToken(input: CreateNodeEnrollmentTokenRequest): Promise<CreateEnrollmentTokenResult> {
		return apiRequest<CreateEnrollmentTokenResult>('/api/v1/admin/node-enrollment-tokens', {
			method: 'POST',
			body: input,
		});
	},
	revokeEnrollmentToken(tokenId: string): Promise<void> {
		return apiRequest<void>(`/api/v1/admin/node-enrollment-tokens/${tokenId}`, {
			method: 'DELETE',
		});
	},
	get(nodeId: string): Promise<NodeDetail> {
		return apiRequest<NodeDetail>(`/api/v1/admin/nodes/${nodeId}`);
	},
	update(nodeId: string, input: UpdateNodeRequest): Promise<Node> {
		return apiRequest<Node>(`/api/v1/admin/nodes/${nodeId}`, { method: 'PATCH', body: input });
	},
	remove(nodeId: string, options: { force?: boolean; removeXray?: boolean } = {}): Promise<Node | void> {
		return apiRequest<Node | void>(`/api/v1/admin/nodes/${nodeId}`, {
			method: 'DELETE',
			query: {
				force: options.force ? 'true' : 'false',
				remove_xray: options.removeXray ? 'true' : 'false',
			},
		});
	},
	listClients(nodeId: string): Promise<NodeClient[]> {
		return apiRequest<{ items: NodeClient[] }>(`/api/v1/admin/nodes/${nodeId}/clients`).then((data) => data.items);
	},
	createEndpoint(nodeId: string, input: CreateEndpointRequest): Promise<Endpoint> {
		return apiRequest<Endpoint>(`/api/v1/admin/nodes/${nodeId}/endpoints`, { method: 'POST', body: input });
	},
	updateEndpoint(nodeId: string, endpointId: string, input: UpdateEndpointRequest): Promise<Endpoint> {
		return apiRequest<Endpoint>(`/api/v1/admin/nodes/${nodeId}/endpoints/${endpointId}`, {
			method: 'PATCH',
			body: input,
		});
	},
	disableEndpoint(nodeId: string, endpointId: string): Promise<void> {
		return apiRequest<void>(`/api/v1/admin/nodes/${nodeId}/endpoints/${endpointId}`, {
			method: 'DELETE',
		});
	},
	listConfigs(nodeId: string, params: NodeListParams = {}): Promise<Page<ConfigVersion>> {
		return apiPage<ConfigVersion>(`/api/v1/admin/nodes/${nodeId}/configs`, {
			query: { limit: LIST_LIMIT, ...params },
		});
	},
	publishConfig(nodeId: string, definition: Record<string, unknown>): Promise<ConfigVersion> {
		return apiRequest<ConfigVersion>(`/api/v1/admin/nodes/${nodeId}/configs`, {
			method: 'POST',
			body: { definition },
		});
	},
	getConfig(nodeId: string, version: number): Promise<ConfigVersion> {
		return apiRequest<ConfigVersion>(`/api/v1/admin/nodes/${nodeId}/configs/${version}`);
	},
	rollbackConfig(nodeId: string, version: number): Promise<ConfigVersion> {
		return apiRequest<ConfigVersion>(`/api/v1/admin/nodes/${nodeId}/configs/${version}/rollback`, {
			method: 'POST',
		});
	},
};
