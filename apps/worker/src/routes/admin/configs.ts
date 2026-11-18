import { Hono } from 'hono';
import { ok, okPage } from '../../lib/response';
import { readJson, readQuery } from '../../lib/validation';
import { getConfig, listConfigs, publishConfig, rollbackConfig } from '../../services/config-service';
import type { AppEnv } from '../../types';
import { listQuerySchema, pathId, positiveVersion, publishConfigSchema } from '../schemas';

export const configRoutes = new Hono<AppEnv>();

configRoutes.get('/:nodeId/configs', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const query = readQuery(c, listQuerySchema);
	return okPage(c, await listConfigs(c.env.DB, nodeId, query));
});

configRoutes.post('/:nodeId/configs', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const input = await readJson(c, publishConfigSchema);
	return ok(c, await publishConfig(c.env.DB, nodeId, input, c.get('admin')), 201);
});

configRoutes.get('/:nodeId/configs/:version', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const version = positiveVersion(c);
	return ok(c, await getConfig(c.env.DB, nodeId, version));
});

configRoutes.post('/:nodeId/configs/:version/rollback', async (c) => {
	const nodeId = pathId(c, 'nodeId');
	const version = positiveVersion(c);
	return ok(c, await rollbackConfig(c.env.DB, nodeId, version, c.get('admin')), 201);
});
