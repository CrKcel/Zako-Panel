import type { AgentUser, AgentUsers } from '@zako/contracts';
import { getUsersVersion } from '../repositories/meta';
import { activeSubscriberUsersStatement } from '../repositories/subscribers';

/**
 * The response version doubles as the entity tag. The list contains every
 * active subscriber's credentials, synced uniformly to all nodes.
 */
export async function listNodeUsers(db: D1Database): Promise<AgentUsers> {
	const [version, users] = await Promise.all([
		getUsersVersion(db),
		activeSubscriberUsersStatement(db)
			.all<AgentUser>()
			.then((result) => result.results),
	]);
	return { version, users };
}
