import type { Profile, ProfileDetail, ProxyGroup } from '@zako/contracts';
import type { ProfileRow } from '../repositories/profiles';

function parseObject(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Stored profile JSON is written from validated input; an unreadable base
		// degrades to an empty document rather than failing the caller.
	}
	return {};
}

function parseProxyGroups(value: string): ProxyGroup[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? (parsed as ProxyGroup[]) : [];
	} catch {
		return [];
	}
}

function parseRules(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((rule): rule is string => typeof rule === 'string') : [];
	} catch {
		return [];
	}
}

/** Row-to-DTO mapping shared by profile management and subscription distribution. */
export function toProfile(row: ProfileRow): Profile {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		node_selection: row.node_selection,
		online_only: row.online_only === 1,
		clash_base: parseObject(row.clash_base_json),
		proxy_groups: parseProxyGroups(row.proxy_groups_json),
		rules: parseRules(row.rules_json),
		revision: row.revision,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export function toProfileDetail(row: ProfileRow, nodeIds: string[]): ProfileDetail {
	return { ...toProfile(row), node_ids: nodeIds };
}
