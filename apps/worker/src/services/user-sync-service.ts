import type { AgentUser, AgentUsers } from '@zako/contracts';
import { getUsersVersion } from '../repositories/meta';
import { nodeActiveUsersStatement } from '../repositories/subscribers';

/**
 * The response version doubles as the entity tag. The list only contains
 * enabled credentials whose subscriber is active on this node.
 */
export async function listNodeUsers(db: D1Database, nodeId: string): Promise<AgentUsers> {
	const [version, users] = await Promise.all([
		getUsersVersion(db),
		nodeActiveUsersStatement(db, nodeId)
			.all<AgentUser>()
			.then((result) => result.results),
	]);
	return { version, users };
}
