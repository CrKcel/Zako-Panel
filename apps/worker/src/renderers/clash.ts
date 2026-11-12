import type { ProxyGroup } from '@zako/contracts';
import { stringify } from 'yaml';

export interface RenderProxy {
	name: string;
	[key: string]: unknown;
}

export const DEFAULT_PROXY_GROUP = 'PROXY';
export const DEFAULT_AUTO_GROUP = 'AUTO';
export const DEFAULT_RULES = ['MATCH,PROXY'];

function defaultProxyGroups(proxyNames: string[]): ProxyGroup[] {
	return [
		{ name: DEFAULT_PROXY_GROUP, type: 'select', proxies: [DEFAULT_AUTO_GROUP, ...proxyNames] },
		{
			name: DEFAULT_AUTO_GROUP,
			type: 'url-test',
			proxies: proxyNames,
			url: 'https://www.gstatic.com/generate_204',
			interval: 300,
		},
	];
}

/**
 * Serializes a Clash.Meta document. Base fields come from the profile, while
 * proxies, proxy-groups and rules are overwritten with validated values so a
 * stale base cannot point at proxies that were not rendered.
 */
export function renderClashDocument(
	base: Record<string, unknown>,
	proxies: RenderProxy[],
	proxyGroups: ProxyGroup[],
	rules: string[],
): string {
	const proxyNames = proxies.map((proxy) => proxy.name);
	const document: Record<string, unknown> = { ...base };
	document.proxies = proxies;
	document['proxy-groups'] = proxyGroups.length > 0 ? proxyGroups : defaultProxyGroups(proxyNames);
	document.rules = rules.length > 0 ? rules : DEFAULT_RULES;
	return stringify(document, { lineWidth: 0 });
}
