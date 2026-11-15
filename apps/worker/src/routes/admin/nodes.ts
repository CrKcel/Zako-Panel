import { Hono } from 'hono';
import { noContent, ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import { requireRole } from '../../middleware/roles';
import {
	createEndpoint,
	createNode,
	disableEndpoint,
	getNode,
	getNodeStatus,
	listEndpoints,
	listNodeClients,
	listNodes,
	rotateAgentToken,
	updateEndpoint,
	updateNode,
} from '../../services/node-service';
import type { AppEnv } from '../../types';
import { createEndpointSchema, createNodeSchema, listQuerySchema, pathId, updateEndpointSchema, updateNodeSchema } from '../schemas';

export const nodeRoutes = new Hono<AppEnv>();

nodeRoutes.get('/', requireRole('viewer'), async (c) => {
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listNodes(c.env.DB, query));
});

nodeRoutes.post('/', requireRole('admin'), async (c) => {
	const input = await readJson(c, createNodeSchema);
	return ok(c, await createNode(c.env.DB, input), 201);
});

nodeRoutes.get('/:nodeId', requireRole('viewer'), async (c) => {
	const nodeId = pathId(c, 'nodeId');
	return ok(c, await getNode(c.env.DB, nodeId));
});

nodeRoutes.patch('/:nodeId', requireRole('admin'), async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const input = await readJson(c, updateNodeSchema);
	return ok(c, await updateNode(c.env.DB, nodeId, input));
});

nodeRoutes.post('/:nodeId/agent-token/rotate', requireRole('admin'), async (c) => {
	const nodeId = pathId(c, 'nodeId');
	return ok(c, await rotateAgentToken(c.env.DB, nodeId));
});

nodeRoutes.get('/:nodeId/status', requireRole('viewer'), async (c) => {
	const nodeId = pathId(c, 'nodeId');
	return ok(c, await getNodeStatus(c.env.DB, nodeId));
});

nodeRoutes.get('/:nodeId/clients', requireRole('viewer'), async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const items = await listNodeClients(c.env.DB, nodeId);
	return c.json({ data: { items }, meta: { request_id: c.get('requestId') } });
});

nodeRoutes.get('/:nodeId/endpoints', requireRole('viewer'), async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const items = await listEndpoints(c.env.DB, nodeId);
	return c.json({ data: { items }, meta: { request_id: c.get('requestId') } });
});

nodeRoutes.post('/:nodeId/endpoints', requireRole('admin'), async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const input = await readJson(c, createEndpointSchema);
	return ok(c, await createEndpoint(c.env.DB, nodeId, input), 201);
});

nodeRoutes.patch('/:nodeId/endpoints/:endpointId', requireRole('admin'), async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const endpointId = pathId(c, 'endpointId');
	const input = await readJson(c, updateEndpointSchema);
	return ok(c, await updateEndpoint(c.env.DB, nodeId, endpointId, input));
});

nodeRoutes.delete('/:nodeId/endpoints/:endpointId', requireRole('admin'), async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const endpointId = pathId(c, 'endpointId');
	await disableEndpoint(c.env.DB, nodeId, endpointId);
	return noContent(c);
});
