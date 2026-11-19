import type { CreateProfileRequest, ProfileDetail, ProxyGroup, UpdateProfileRequest } from '@zako/contracts';
import { parse, stringify } from 'yaml';

export type ProfilePayload = CreateProfileRequest & UpdateProfileRequest;

export const PROXY_GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance', 'relay', 'smart'] as const;
const PROXY_GROUP_TYPE_SET = new Set<string>(PROXY_GROUP_TYPES);

export const DEFAULT_MIHOMO_YAML_TEMPLATE = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - AUTO
    include-all: true
  - name: AUTO
    type: url-test
    include-all: true
    url: https://www.gstatic.com/generate_204
    interval: 300

rules:
  - MATCH,PROXY`;

/** Mihomo YAML config is edited as a single document matching Clash.Meta/Mihomo syntax. */
export interface ProfileFormState {
	name: string;
	description: string;
	node_selection: 'all' | 'selected';
	node_ids: string[];
	online_only: boolean;
	clash_yaml: string;
}

export type ProfileFormError =
	| { code: 'yamlSyntax'; message: string }
	| { code: 'yamlRoot' }
	| { code: 'proxyGroupsArray' }
	| { code: 'proxyGroupItem'; index: number }
	| { code: 'proxyGroupProxies'; index: number }
	| { code: 'rulesArray' }
	| { code: 'ruleEmpty'; index: number };

export type ProfilePayloadResult = { ok: true; payload: ProfilePayload } | { ok: false; error: ProfileFormError };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function emptyProfileForm(): ProfileFormState {
	return {
		name: '',
		description: '',
		node_selection: 'all',
		node_ids: [],
		online_only: true,
		clash_yaml: '',
	};
}

function serializeMihomoYaml(detail: ProfileDetail): string {
	const doc: Record<string, unknown> = { ...detail.clash_base };
	delete doc.proxies;
	if (detail.proxy_groups.length > 0) {
		doc['proxy-groups'] = detail.proxy_groups;
	}
	if (detail.rules.length > 0) {
		doc.rules = detail.rules;
	}
	if (Object.keys(doc).length === 0) return '';
	return stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
}

export function profileFormFrom(detail: ProfileDetail): ProfileFormState {
	return {
		name: detail.name,
		description: detail.description ?? '',
		node_selection: detail.node_selection,
		node_ids: [...detail.node_ids],
		online_only: detail.online_only,
		clash_yaml: serializeMihomoYaml(detail),
	};
}

function parseProxyGroups(rawGroups: unknown): { ok: true; groups: ProxyGroup[] } | { ok: false; error: ProfileFormError } {
	if (rawGroups === undefined || rawGroups === null) {
		return { ok: true, groups: [] };
	}
	if (!Array.isArray(rawGroups)) {
		return { ok: false, error: { code: 'proxyGroupsArray' } };
	}

	const groups: ProxyGroup[] = [];
	for (let i = 0; i < rawGroups.length; i += 1) {
		const item = rawGroups[i];
		const index = i + 1;
		if (!isPlainObject(item)) {
			return { ok: false, error: { code: 'proxyGroupItem', index } };
		}
		if (typeof item.name !== 'string' || item.name.trim().length === 0) {
			return { ok: false, error: { code: 'proxyGroupItem', index } };
		}
		if (typeof item.type !== 'string' || !PROXY_GROUP_TYPE_SET.has(item.type)) {
			return { ok: false, error: { code: 'proxyGroupItem', index } };
		}
		if (item.url !== undefined && item.url !== null && typeof item.url !== 'string') {
			return { ok: false, error: { code: 'proxyGroupItem', index } };
		}
		if (
			item.interval !== undefined &&
			item.interval !== null &&
			(typeof item.interval !== 'number' || !Number.isInteger(item.interval) || item.interval <= 0)
		) {
			return { ok: false, error: { code: 'proxyGroupItem', index } };
		}
		if (item.proxies !== undefined && item.proxies !== null) {
			if (!Array.isArray(item.proxies) || item.proxies.some((entry) => typeof entry !== 'string')) {
				return { ok: false, error: { code: 'proxyGroupProxies', index } };
			}
		}

		const group: Record<string, unknown> = { ...item, name: item.name.trim() };
		if (group.proxies === null || group.proxies === undefined) delete group.proxies;
		if (group.url === null || group.url === undefined) delete group.url;
		if (group.interval === null || group.interval === undefined) delete group.interval;
		groups.push(group as ProxyGroup);
	}
	return { ok: true, groups };
}

function parseRules(rawRules: unknown): { ok: true; rules: string[] } | { ok: false; error: ProfileFormError } {
	if (rawRules === undefined || rawRules === null) {
		return { ok: true, rules: [] };
	}
	if (!Array.isArray(rawRules)) {
		return { ok: false, error: { code: 'rulesArray' } };
	}

	const rules: string[] = [];
	for (let i = 0; i < rawRules.length; i += 1) {
		const entry = rawRules[i];
		if (typeof entry !== 'string') {
			return { ok: false, error: { code: 'rulesArray' } };
		}
		const trimmed = entry.trim();
		if (trimmed.length === 0) {
			return { ok: false, error: { code: 'ruleEmpty', index: i + 1 } };
		}
		rules.push(trimmed);
	}
	return { ok: true, rules };
}

function parseMihomoYaml(
	text: string,
): { ok: true; clash_base: Record<string, unknown>; proxy_groups: ProxyGroup[]; rules: string[] } | { ok: false; error: ProfileFormError } {
	if (text.trim() === '') {
		return { ok: true, clash_base: {}, proxy_groups: [], rules: [] };
	}

	let parsed: unknown;
	try {
		parsed = parse(text, { merge: true });
	} catch (error) {
		return {
			ok: false,
			error: {
				code: 'yamlSyntax',
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}

	if (parsed === null || parsed === undefined) {
		return { ok: true, clash_base: {}, proxy_groups: [], rules: [] };
	}
	if (!isPlainObject(parsed)) {
		return { ok: false, error: { code: 'yamlRoot' } };
	}

	const groupsResult = parseProxyGroups(parsed['proxy-groups']);
	if (!groupsResult.ok) return groupsResult;

	const rulesResult = parseRules(parsed.rules);
	if (!rulesResult.ok) return rulesResult;

	const clash_base: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (key === 'proxies' || key === 'proxy-groups' || key === 'rules') continue;
		clash_base[key] = value;
	}

	return {
		ok: true,
		clash_base,
		proxy_groups: groupsResult.groups,
		rules: rulesResult.rules,
	};
}

/** Blank selection is dropped from the node allow-list. */
export function buildProfilePayload(form: ProfileFormState): ProfilePayloadResult {
	const parsed = parseMihomoYaml(form.clash_yaml);
	if (!parsed.ok) return parsed;

	return {
		ok: true,
		payload: {
			name: form.name,
			description: form.description.trim() === '' ? null : form.description.trim(),
			node_selection: form.node_selection,
			online_only: form.online_only,
			clash_base: parsed.clash_base,
			proxy_groups: parsed.proxy_groups,
			rules: parsed.rules,
			node_ids: form.node_selection === 'selected' ? form.node_ids : [],
		},
	};
}
