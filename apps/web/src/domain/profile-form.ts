import type { CreateProfileRequest, ProfileDetail, ProxyGroup, UpdateProfileRequest } from '@zako/contracts';

export type ProfilePayload = CreateProfileRequest & UpdateProfileRequest;

/** JSON documents are edited as text, so the form keeps the raw serialized values. */
export interface ProfileFormState {
	name: string;
	description: string;
	node_selection: 'all' | 'selected';
	node_ids: string[];
	online_only: boolean;
	clash_base: string;
	proxy_groups: string;
	rules: string;
}

export type ProfileFormError = 'clash_base' | 'proxy_groups';

export type ProfilePayloadResult = { ok: true; payload: ProfilePayload } | { ok: false; error: ProfileFormError };

export function emptyProfileForm(): ProfileFormState {
	return {
		name: '',
		description: '',
		node_selection: 'all',
		node_ids: [],
		online_only: true,
		clash_base: '{}',
		proxy_groups: '[]',
		rules: '',
	};
}

export function profileFormFrom(detail: ProfileDetail): ProfileFormState {
	return {
		name: detail.name,
		description: detail.description ?? '',
		node_selection: detail.node_selection,
		node_ids: [...detail.node_ids],
		online_only: detail.online_only,
		clash_base: JSON.stringify(detail.clash_base, null, 2),
		proxy_groups: JSON.stringify(detail.proxy_groups, null, 2),
		rules: detail.rules.join('\n'),
	};
}

function parseClashBase(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text || '{}');
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function parseProxyGroups(text: string): ProxyGroup[] | null {
	try {
		const parsed: unknown = JSON.parse(text || '[]');
		if (!Array.isArray(parsed)) return null;
		return parsed as ProxyGroup[];
	} catch {
		return null;
	}
}

/** Blank selection is dropped from the node allow-list. */
export function buildProfilePayload(form: ProfileFormState): ProfilePayloadResult {
	const clash_base = parseClashBase(form.clash_base);
	if (clash_base === null) return { ok: false, error: 'clash_base' };
	const proxy_groups = parseProxyGroups(form.proxy_groups);
	if (proxy_groups === null) return { ok: false, error: 'proxy_groups' };

	return {
		ok: true,
		payload: {
			name: form.name,
			description: form.description.trim() === '' ? null : form.description.trim(),
			node_selection: form.node_selection,
			online_only: form.online_only,
			clash_base,
			proxy_groups,
			rules: form.rules
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
			node_ids: form.node_selection === 'selected' ? form.node_ids : [],
		},
	};
}
