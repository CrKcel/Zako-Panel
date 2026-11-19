<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { useI18n, type Locale, type MessageKey } from '../i18n';
import { syncDocumentTitle } from '../router';
import { isThemePreference, useTheme, type ThemePreference } from '../theme';
import AppIcon, { type IconName } from './AppIcon.vue';

const route = useRoute();
const mobileOpen = ref(false);
const { locale, localeOptions, setLocale, t } = useI18n();
const { preference, themeOptions, setTheme } = useTheme();

const items = computed<Array<{ path: string; label: string; icon: IconName }>>(() => [
	{ path: '/', label: t('nav.overview'), icon: 'overview' },
	{ path: '/nodes', label: t('nav.nodes'), icon: 'nodes' },
	{ path: '/subscribers', label: t('nav.subscribers'), icon: 'subscribers' },
	{ path: '/profiles', label: t('nav.profiles'), icon: 'profiles' },
	{ path: '/subscriptions', label: t('nav.subscriptions'), icon: 'subscriptions' },
	{ path: '/traffic', label: t('nav.traffic'), icon: 'traffic' },
]);

const activeMenu = computed(() => {
	if (route.path.startsWith('/nodes')) return '/nodes';
	if (route.path.startsWith('/subscribers')) return '/subscribers';
	return route.path;
});

const title = computed(() => (route.meta.titleKey ? t(route.meta.titleKey as MessageKey) : ''));

const currentLocaleLabel = computed(() => localeOptions.find((option) => option.value === locale.value)?.label ?? locale.value);

const THEME_ICONS: Record<ThemePreference, IconName> = {
	system: 'monitor',
	light: 'sun',
	dark: 'moon',
};

const currentThemeIcon = computed<IconName>(() => THEME_ICONS[preference.value]);
const currentThemeLabel = computed(() => {
	const option = themeOptions.find((item) => item.value === preference.value);
	return option ? t(option.labelKey) : '';
});

function handleLocaleCommand(command: string | number | Record<string, unknown>): void {
	if (command === 'zh-CN' || command === 'en-US') {
		setLocale(command as Locale);
	}
}

function handleThemeCommand(command: string | number | Record<string, unknown>): void {
	if (typeof command === 'string' && isThemePreference(command)) {
		setTheme(command);
	}
}

watch(
	locale,
	() => {
		syncDocumentTitle(route.meta.titleKey);
	},
	{ immediate: true },
);

watch(
	() => route.path,
	() => {
		mobileOpen.value = false;
	},
);
</script>

<template>
	<div class="shell">
		<div v-if="mobileOpen" class="mobile-backdrop" @click="mobileOpen = false" />

		<aside class="aside" :class="{ 'is-open': mobileOpen }">
			<div class="brand">
				<span class="brand-mark" aria-hidden="true">Z</span>
				<span class="brand-name">Zako Panel</span>
			</div>

			<nav class="nav" :aria-label="t('nav.mainNavigation')">
				<RouterLink
					v-for="item in items"
					:key="item.path"
					:to="item.path"
					class="nav-item"
					:class="{ 'is-active': activeMenu === item.path }"
				>
					<AppIcon :name="item.icon" :size="16" />
					<span>{{ item.label }}</span>
				</RouterLink>
			</nav>

			<div class="aside-footer">
				<span class="aside-meta">{{ t('nav.controlPanel') }}</span>
			</div>
		</aside>

		<div class="workspace">
			<header class="header">
				<div class="header-inner">
					<div class="header-left">
						<button type="button" class="menu-trigger" :aria-label="t('nav.openNavigation')" @click="mobileOpen = !mobileOpen">
							<AppIcon name="menu" :size="18" />
						</button>
						<h1 class="page-title">{{ title }}</h1>
					</div>
					<div class="header-right">
						<el-dropdown trigger="click" @command="handleThemeCommand">
							<button type="button" class="header-trigger" :aria-label="t('nav.switchTheme')">
								<AppIcon :name="currentThemeIcon" :size="15" />
								<span class="trigger-label">{{ currentThemeLabel }}</span>
							</button>
							<template #dropdown>
								<el-dropdown-menu>
									<el-dropdown-item
										v-for="option in themeOptions"
										:key="option.value"
										:command="option.value"
										:class="{ 'is-selected-option': preference === option.value }"
									>
										<span class="dropdown-option">
											<AppIcon :name="THEME_ICONS[option.value]" :size="14" />
											<span>{{ t(option.labelKey) }}</span>
										</span>
									</el-dropdown-item>
								</el-dropdown-menu>
							</template>
						</el-dropdown>
						<el-dropdown trigger="click" @command="handleLocaleCommand">
							<button type="button" class="header-trigger" :aria-label="t('nav.switchLanguage')">
								<AppIcon name="globe" :size="15" />
								<span class="trigger-label">{{ currentLocaleLabel }}</span>
							</button>
							<template #dropdown>
								<el-dropdown-menu>
									<el-dropdown-item
										v-for="option in localeOptions"
										:key="option.value"
										:command="option.value"
										:class="{ 'is-selected-option': locale === option.value }"
									>
										{{ option.label }}
									</el-dropdown-item>
								</el-dropdown-menu>
							</template>
						</el-dropdown>
					</div>
				</div>
			</header>

			<main class="main">
				<div class="main-inner">
					<RouterView />
				</div>
			</main>
		</div>
	</div>
</template>

<style scoped>
.shell {
	min-height: 100vh;
	display: flex;
	background: var(--bg-canvas);
}

.aside {
	width: 232px;
	flex: none;
	background: var(--bg-surface);
	border-right: 1px solid var(--border-color);
	display: flex;
	flex-direction: column;
	position: sticky;
	top: 0;
	height: 100vh;
	z-index: 30;
}

.brand {
	height: 56px;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 0 18px;
	border-bottom: 1px solid var(--border-subtle);
}

.brand-mark {
	width: 26px;
	height: 26px;
	border-radius: 7px;
	background: var(--brand-mark-bg);
	color: var(--brand-mark-fg);
	font-size: 13px;
	font-weight: 700;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	letter-spacing: 0.02em;
}

.brand-name {
	font-size: 14.5px;
	font-weight: 600;
	color: var(--text-primary);
	letter-spacing: -0.01em;
}

.nav {
	flex: 1;
	padding: 14px 10px;
	display: flex;
	flex-direction: column;
	gap: 3px;
	overflow-y: auto;
}

.nav-item {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 9px 12px;
	border-radius: 8px;
	color: var(--text-secondary);
	text-decoration: none;
	font-size: 13.5px;
	font-weight: 500;
	transition:
		background-color 0.15s ease,
		color 0.15s ease;
}

.nav-item:hover {
	background: var(--bg-subtle);
	color: var(--text-primary);
}

.nav-item.is-active {
	background: var(--accent-primary-soft);
	color: var(--accent-primary);
	font-weight: 600;
}

.aside-footer {
	padding: 12px 18px;
	border-top: 1px solid var(--border-subtle);
}

.aside-meta {
	font-size: 12px;
	color: var(--text-placeholder);
}

.workspace {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
}

.header {
	height: 56px;
	background: var(--bg-surface);
	border-bottom: 1px solid var(--border-color);
	position: sticky;
	top: 0;
	z-index: 20;
	display: flex;
	align-items: center;
}

.header-inner {
	width: 100%;
	max-width: 1320px;
	margin: 0 auto;
	padding: 0 24px;
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.header-left {
	display: flex;
	align-items: center;
	gap: 12px;
}

.header-right {
	display: flex;
	align-items: center;
	gap: 10px;
}

.header-trigger {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 32px;
	padding: 0 10px;
	border: 1px solid var(--border-color);
	border-radius: 7px;
	background: var(--bg-surface);
	color: var(--text-secondary);
	font-family: inherit;
	font-size: 12.5px;
	font-weight: 500;
	cursor: pointer;
	transition:
		background-color 0.15s ease,
		border-color 0.15s ease,
		color 0.15s ease;
}

.header-trigger:hover {
	background: var(--bg-subtle);
	border-color: var(--border-hover);
	color: var(--text-primary);
}

.dropdown-option {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}

:deep(.is-selected-option) {
	color: var(--accent-primary);
	font-weight: 600;
}

.menu-trigger {
	display: none;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border: 1px solid var(--border-color);
	border-radius: 7px;
	background: var(--bg-surface);
	color: var(--text-secondary);
	cursor: pointer;
}

.menu-trigger:hover {
	background: var(--bg-subtle);
	color: var(--text-primary);
}

.page-title {
	margin: 0;
	font-size: 16px;
	font-weight: 600;
	color: var(--text-primary);
	letter-spacing: -0.01em;
}

.main {
	flex: 1;
	padding: 24px;
}

.main-inner {
	max-width: 1272px;
	margin: 0 auto;
}

.mobile-backdrop {
	display: none;
}

@media (max-width: 900px) {
	.aside {
		position: fixed;
		left: 0;
		top: 0;
		bottom: 0;
		transform: translateX(-100%);
		transition: transform 0.2s ease;
	}

	.aside.is-open {
		transform: translateX(0);
	}

	.mobile-backdrop {
		display: block;
		position: fixed;
		inset: 0;
		background: var(--backdrop-color);
		z-index: 25;
	}

	.menu-trigger {
		display: inline-flex;
	}

	.header-inner {
		padding: 0 16px;
	}

	.main {
		padding: 16px;
	}
}

@media (max-width: 520px) {
	.trigger-label {
		display: none;
	}
}
</style>
