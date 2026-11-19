import { Hono } from 'hono';
import { noContent, ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import {
	createEndpoint,
	createNode,
	deleteOrUninstallNode,
	disableEndpoint,
	getNode,
	getNodeStatus,
	listEndpoints,
	listNodeClients,
	listNodes,
	requestNodeAgentUpdate,
	rotateAgentToken,
	updateEndpoint,
	updateNode,
} from '../../services/node-service';
import type { AppEnv } from '../../types';
import {
	createEndpointSchema,
	createNodeSchema,
	deleteNodeQuerySchema,
	listQuerySchema,
	pathId,
	requestNodeAgentUpdateSchema,
	updateEndpointSchema,
	updateNodeSchema,
} from '../schemas';

export const nodeRoutes = new Hono<AppEnv>();

nodeRoutes.get('/', async (c) => {
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listNodes(c.env.DB, query));
});

nodeRoutes.post('/', async (c) => {
	const input = await readJson(c, createNodeSchema);
	return ok(c, await createNode(c.env.DB, input), 201);
});

nodeRoutes.get('/:nodeId', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	return ok(c, await getNode(c.env.DB, nodeId));
});

nodeRoutes.patch('/:nodeId', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const input = await readJson(c, updateNodeSchema);
	return ok(c, await updateNode(c.env.DB, nodeId, input));
});

nodeRoutes.delete('/:nodeId', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const query = readQuery(c, deleteNodeQuerySchema);
	const result = await deleteOrUninstallNode(c.env.DB, nodeId, {
		force: query.force,
		removeXray: query.remove_xray,
		actorEmail: c.get('admin')?.email ?? null,
	});
	if (result.deleted) {
		return noContent(c);
	}
	return ok(c, result.node, 202);
});

nodeRoutes.post('/:nodeId/agent-token/rotate', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	return ok(c, await rotateAgentToken(c.env.DB, nodeId));
});

nodeRoutes.post('/:nodeId/agent-update', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const input = await readJson(c, requestNodeAgentUpdateSchema);
	const node = await requestNodeAgentUpdate(c.env.DB, nodeId, input.target_version, c.get('admin')?.email ?? null);
	return ok(c, node, 202);
});

nodeRoutes.get('/:nodeId/status', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	return ok(c, await getNodeStatus(c.env.DB, nodeId));
});

nodeRoutes.get('/:nodeId/clients', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const items = await listNodeClients(c.env.DB, nodeId);
	return c.json({ data: { items }, meta: { request_id: c.get('requestId') } });
});

nodeRoutes.get('/:nodeId/endpoints', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const items = await listEndpoints(c.env.DB, nodeId);
	return c.json({ data: { items }, meta: { request_id: c.get('requestId') } });
});

nodeRoutes.post('/:nodeId/endpoints', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const input = await readJson(c, createEndpointSchema);
	return ok(c, await createEndpoint(c.env.DB, nodeId, input), 201);
});

nodeRoutes.patch('/:nodeId/endpoints/:endpointId', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const endpointId = pathId(c, 'endpointId');
	const input = await readJson(c, updateEndpointSchema);
	return ok(c, await updateEndpoint(c.env.DB, nodeId, endpointId, input));
});

nodeRoutes.delete('/:nodeId/endpoints/:endpointId', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const endpointId = pathId(c, 'endpointId');
	await disableEndpoint(c.env.DB, nodeId, endpointId);
	return noContent(c);
});
