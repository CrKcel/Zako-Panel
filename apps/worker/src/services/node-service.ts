import type {
	CreateEndpointRequest,
	CreateNodeRequest,
	Endpoint,
	Node,
	NodeStatusDetail,
	UpdateEndpointRequest,
	UpdateNodeRequest,
} from '@zako/contracts';
import { notImplemented } from '../lib/errors';
import type { Paginated } from '../types';

export interface ListQuery {
	limit: number;
	cursor?: string;
}

export interface CreateNodeResult {
	node: Node;
	endpoint: Endpoint;
	agent_token: string;
}

export async function listNodes(_db: D1Database, _query: ListQuery): Promise<Paginated<Node>> {
	throw notImplemented('node listing');
}

export async function createNode(_db: D1Database, _input: CreateNodeRequest): Promise<CreateNodeResult> {
	throw notImplemented('node creation');
}

export async function getNode(_db: D1Database, _nodeId: string): Promise<{ node: Node; endpoints: Endpoint[] }> {
	throw notImplemented('node lookup');
}

export async function updateNode(_db: D1Database, _nodeId: string, _input: UpdateNodeRequest): Promise<Node> {
	throw notImplemented('node update');
}

export async function rotateAgentToken(_db: D1Database, _nodeId: string): Promise<{ agent_token: string }> {
	throw notImplemented('agent token rotation');
}

export async function getNodeStatus(_db: D1Database, _nodeId: string): Promise<NodeStatusDetail> {
	throw notImplemented('node status');
}

export async function listEndpoints(_db: D1Database, _nodeId: string): Promise<Endpoint[]> {
	throw notImplemented('endpoint listing');
}

export async function createEndpoint(_db: D1Database, _nodeId: string, _input: CreateEndpointRequest): Promise<Endpoint> {
	throw notImplemented('endpoint creation');
}

export async function updateEndpoint(
	_db: D1Database,
	_nodeId: string,
	_endpointId: string,
	_input: UpdateEndpointRequest,
): Promise<Endpoint> {
	throw notImplemented('endpoint update');
}

export async function disableEndpoint(_db: D1Database, _nodeId: string, _endpointId: string): Promise<void> {
	throw notImplemented('endpoint disable');
}
