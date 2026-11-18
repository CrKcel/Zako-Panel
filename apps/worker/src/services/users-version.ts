import { incrementMetaStatement, META_KEYS } from '../repositories/meta';

/**
 * Bumps the global node user-set version. Agents compare `users_ver` to decide
 * whether to re-fetch `/api/v1/agent/users`, so every write that changes the
 * node-side user set must add this statement to the same D1 batch as the change.
 */
export function bumpUsersVersionStatement(db: D1Database): D1PreparedStatement {
	return incrementMetaStatement(db, META_KEYS.usersVersion);
}
