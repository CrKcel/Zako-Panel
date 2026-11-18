import { Hono } from 'hono';
import { AppError } from '../../lib/errors';
import { noContent } from '../../lib/response';
import { completeAgentUninstall } from '../../services/node-service';
import type { AppEnv } from '../../types';
import { agentUninstallSchema } from '../schemas';

export const uninstallRoutes = new Hono<AppEnv>();

uninstallRoutes.post('/', async (c) => {
	const nodeId = c.get('agent')?.nodeId;
	if (!nodeId) throw new AppError('UNAUTHORIZED', 'Missing agent identity', 401);

	let reason: 'panel_directive' | 'node_cli' = 'node_cli';
	const raw = await c.req.text();
	if (raw.trim().length > 0) {
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(raw) as unknown;
		} catch {
			throw new AppError('BAD_REQUEST', 'Request body must be valid JSON', 400);
		}
		const parsed = agentUninstallSchema.safeParse(parsedJson);
		if (!parsed.success) {
			throw new AppError('VALIDATION_ERROR', 'Validation failed', 400);
		}
		reason = parsed.data.reason;
	}

	await completeAgentUninstall(c.env.DB, nodeId, reason);
	return noContent(c);
});
