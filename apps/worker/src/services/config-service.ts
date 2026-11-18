import type { AgentConfig, AgentConfigResult, ConfigVersion, PublishConfigRequest } from '@zako/contracts';
import { notImplemented } from '../lib/errors';
import type { ListQuery, Paginated } from '../types';

export async function listConfigs(_db: D1Database, _nodeId: string, _query: ListQuery): Promise<Paginated<ConfigVersion>> {
	throw notImplemented('configuration history');
}

export async function publishConfig(_db: D1Database, _nodeId: string, _input: PublishConfigRequest): Promise<ConfigVersion> {
	throw notImplemented('configuration publishing');
}

export async function getConfig(_db: D1Database, _nodeId: string, _version: number): Promise<ConfigVersion> {
	throw notImplemented('configuration lookup');
}

export async function rollbackConfig(_db: D1Database, _nodeId: string, _version: number): Promise<ConfigVersion> {
	throw notImplemented('configuration rollback');
}

export async function getDesiredConfig(_db: D1Database, _nodeId: string): Promise<AgentConfig | null> {
	throw notImplemented('desired configuration');
}

export async function recordConfigResult(_db: D1Database, _nodeId: string, _result: AgentConfigResult): Promise<AgentConfigResult> {
	throw notImplemented('configuration result');
}
