import { computed, readonly, ref } from 'vue';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'zako-panel.theme';
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';
const THEME_COLORS: Record<ResolvedTheme, string> = {
	light: '#f7f7f7',
	dark: '#0a0a0a',
};

export const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; labelKey: 'nav.themeSystem' | 'nav.themeLight' | 'nav.themeDark' }> = [
	{ value: 'system', labelKey: 'nav.themeSystem' },
	{ value: 'light', labelKey: 'nav.themeLight' },
	{ value: 'dark', labelKey: 'nav.themeDark' },
];

export function isThemePreference(value: string | null): value is ThemePreference {
	return value === 'system' || value === 'light' || value === 'dark';
}

function loadInitialPreference(): ThemePreference {
	try {
		const saved = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
		if (isThemePreference(saved)) return saved;
	} catch {
		// Ignore storage access errors in restricted browsing modes.
	}
	return 'system';
}

function readSystemDark(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
	return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

const activePreference = ref<ThemePreference>(loadInitialPreference());
const systemDark = ref<boolean>(readSystemDark());

const activeResolvedTheme = computed<ResolvedTheme>(() => {
	if (activePreference.value === 'system') {
		return systemDark.value ? 'dark' : 'light';
	}
	return activePreference.value;
});

function syncDocumentTheme(theme: ResolvedTheme): void {
	if (typeof document === 'undefined') return;
	document.documentElement.classList.toggle('dark', theme === 'dark');
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		meta.setAttribute('content', THEME_COLORS[theme]);
	}
}

syncDocumentTheme(activeResolvedTheme.value);

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
	const media = window.matchMedia(DARK_MEDIA_QUERY);
	media.addEventListener('change', (event) => {
		systemDark.value = event.matches;
		if (activePreference.value === 'system') {
			syncDocumentTheme(activeResolvedTheme.value);
		}
	});
}

export const themePreference = readonly(activePreference);
export const resolvedTheme = readonly(activeResolvedTheme);

export function setTheme(next: ThemePreference): void {
	activePreference.value = next;
	syncDocumentTheme(activeResolvedTheme.value);
	try {
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(STORAGE_KEY, next);
		}
	} catch {
		// Ignore storage access errors in restricted browsing modes.
	}
}

export function useTheme() {
	return {
		preference: themePreference,
		resolvedTheme,
		themeOptions: THEME_OPTIONS,
		setTheme,
	};
}
