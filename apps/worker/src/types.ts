import type { AdminRole } from '@zako/contracts';
import type { Context } from 'hono';
import type { Env } from './env';

export interface AdminIdentity {
	id: string;
	email: string;
	role: AdminRole;
}

export interface AgentIdentity {
	nodeId: string;
}

export interface Variables {
	requestId: string;
	startedAt: number;
	errorCode?: string;
	admin?: AdminIdentity;
	agent?: AgentIdentity;
}

export type AppEnv = {
	Bindings: Env;
	Variables: Variables;
};

export type AppContext = Context<AppEnv>;

export interface Paginated<T> {
	items: T[];
	next_cursor: string | null;
}

/** Cursor page input shared by every list endpoint. */
export interface ListQuery {
	limit: number;
	cursor?: string;
}
