import { Hono } from 'hono';
import { AppError } from '../../lib/errors';
import { noContent, ok } from '../../lib/response';
import { readQuery } from '../../lib/validation';
import { emptyRecycleBin, listRecycleBinItems, purgeRecycleBinItem, restoreRecycleBinItem } from '../../services/recycle-bin-service';
import type { AppContext, AppEnv } from '../../types';
import { pathId, recycleBinItemTypeSchema, recycleBinQuerySchema } from '../schemas';

function pathItemType(c: AppContext) {
	const raw = c.req.param('itemType');
	const parsed = recycleBinItemTypeSchema.safeParse(raw);
	if (!parsed.success) {
		throw new AppError('VALIDATION_ERROR', 'Invalid recycle bin item type', 400);
	}
	return parsed.data;
}

export const recycleBinRoutes = new Hono<AppEnv>();

recycleBinRoutes.get('/', async (c) => {
	const query = readQuery(c, recycleBinQuerySchema);
	return ok(c, await listRecycleBinItems(c.env.DB, query.type));
});

recycleBinRoutes.delete('/', async (c) => {
	const query = readQuery(c, recycleBinQuerySchema);
	const deleted = await emptyRecycleBin(c.env.DB, query.type, c.get('admin')?.email ?? null);
	return ok(c, { deleted });
});

recycleBinRoutes.post('/:itemType/:itemId/restore', async (c) => {
	const itemType = pathItemType(c);
	const itemId = pathId(c, 'itemId');
	return ok(c, await restoreRecycleBinItem(c.env.DB, itemType, itemId, c.get('admin')?.email ?? null));
});

recycleBinRoutes.delete('/:itemType/:itemId', async (c) => {
	const itemType = pathItemType(c);
	const itemId = pathId(c, 'itemId');
	await purgeRecycleBinItem(c.env.DB, itemType, itemId, c.get('admin')?.email ?? null);
	return noContent(c);
});
