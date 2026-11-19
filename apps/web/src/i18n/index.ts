import { readonly, ref } from 'vue';
import { enUS, zhCN, type Messages } from './messages';

export type Locale = 'zh-CN' | 'en-US';

const STORAGE_KEY = 'zako-panel.locale';

export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
	{ value: 'zh-CN', label: '简体中文' },
	{ value: 'en-US', label: 'English' },
];

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never;

type LeafPaths<T> = {
	[K in keyof T]: T[K] extends string ? K : Join<K, LeafPaths<T[K]>>;
}[keyof T];

export type MessageKey = LeafPaths<Messages>;

const DICTIONARIES: Record<Locale, Messages> = {
	'zh-CN': zhCN,
	'en-US': enUS,
};

function isLocale(value: string | null): value is Locale {
	return value === 'zh-CN' || value === 'en-US';
}

function detectBrowserLocale(): Locale {
	if (typeof navigator === 'undefined') return 'en-US';
	const primary = (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase();
	return primary.startsWith('zh') ? 'zh-CN' : 'en-US';
}

function loadInitialLocale(): Locale {
	try {
		const saved = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
		if (isLocale(saved)) return saved;
	} catch {
		// Ignore storage access errors in restricted browsing modes.
	}
	return detectBrowserLocale();
}

function syncHtmlLang(value: Locale): void {
	if (typeof document !== 'undefined') {
		document.documentElement.lang = value === 'zh-CN' ? 'zh-CN' : 'en';
	}
}

const activeLocale = ref<Locale>(loadInitialLocale());
syncHtmlLang(activeLocale.value);

export const locale = readonly(activeLocale);

export function setLocale(next: Locale): void {
	activeLocale.value = next;
	syncHtmlLang(next);
	try {
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(STORAGE_KEY, next);
		}
	} catch {
		// Ignore storage access errors in restricted browsing modes.
	}
}

function lookup(dict: Messages, key: string): string {
	let current: unknown = dict;
	for (const part of key.split('.')) {
		if (typeof current !== 'object' || current === null || !(part in current)) {
			return key;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return typeof current === 'string' ? current : key;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
	const template = lookup(DICTIONARIES[activeLocale.value], key);
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

export function useI18n() {
	return {
		locale,
		localeOptions: LOCALE_OPTIONS,
		setLocale,
		t,
	};
}
