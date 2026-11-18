import type {
	CreateEndpointRequest,
	CreateNodeRequest,
	Endpoint,
	Node,
	NodeClient,
	UpdateEndpointRequest,
	UpdateNodeRequest,
} from '@zako/contracts';
import { apiPage, apiRequest, LIST_LIMIT, type Page } from './client';

export interface NodeListParams {
	limit?: number;
	cursor?: string;
}

export interface CreateNodeResult {
	node: Node;
	endpoint: Endpoint;
	agent_token: string;
}

export interface NodeDetail {
	node: Node;
	endpoints: Endpoint[];
}

export const nodesApi = {
	list(params: NodeListParams = {}): Promise<Page<Node>> {
		return apiPage<Node>('/api/v1/admin/nodes', { query: { limit: LIST_LIMIT, ...params } });
	},
	create(input: CreateNodeRequest): Promise<CreateNodeResult> {
		return apiRequest<CreateNodeResult>('/api/v1/admin/nodes', { method: 'POST', body: input });
	},
	get(nodeId: string): Promise<NodeDetail> {
		return apiRequest<NodeDetail>(`/api/v1/admin/nodes/${nodeId}`);
	},
	update(nodeId: string, input: UpdateNodeRequest): Promise<Node> {
		return apiRequest<Node>(`/api/v1/admin/nodes/${nodeId}`, { method: 'PATCH', body: input });
	},
	rotateAgentToken(nodeId: string): Promise<{ agent_token: string }> {
		return apiRequest<{ agent_token: string }>(`/api/v1/admin/nodes/${nodeId}/agent-token/rotate`, {
			method: 'POST',
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
};
