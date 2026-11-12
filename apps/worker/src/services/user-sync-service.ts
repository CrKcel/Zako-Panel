import type { AgentUsers } from '@zako/contracts';
import { notImplemented } from '../lib/errors';

/**
 * The response version doubles as the entity tag. The list only contains
 * enabled credentials whose subscriber is active on this node.
 */
export async function listNodeUsers(_db: D1Database, _nodeId: string): Promise<AgentUsers> {
	throw notImplemented('node user synchronization');
}
