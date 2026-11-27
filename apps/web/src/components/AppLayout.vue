<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { useEntityBreadcrumb } from '../composables/useBreadcrumb';
import { useSidebar } from '../composables/useSidebar';
import { useI18n, type Locale, type MessageKey } from '../i18n';
import { syncDocumentTitle } from '../router';
import { isThemePreference, useTheme, type ThemePreference } from '../theme';
import AppIcon, { type IconName } from './AppIcon.vue';
import CommandPalette from './CommandPalette.vue';

const route = useRoute();
const mobileOpen = ref(false);
const paletteOpen = ref(false);
const { locale, localeOptions, setLocale, t } = useI18n();
const { preference, themeOptions, setTheme } = useTheme();
const { collapsed, toggleCollapsed } = useSidebar();
const { entityTitle } = useEntityBreadcrumb();

interface NavItem {
	path: string;
	label: string;
	icon: IconName;
}

const navGroups = computed<Array<{ key: string; title: string; items: NavItem[] }>>(() => [
	{
		key: 'monitor',
		title: t('nav.groupMonitor'),
		items: [
			{ path: '/', label: t('nav.overview'), icon: 'overview' },
			{ path: '/traffic', label: t('nav.traffic'), icon: 'traffic' },
		],
	},
	{
		key: 'resources',
		title: t('nav.groupResources'),
		items: [
			{ path: '/nodes', label: t('nav.nodes'), icon: 'nodes' },
			{ path: '/subscribers', label: t('nav.subscribers'), icon: 'subscribers' },
			{ path: '/profiles', label: t('nav.profiles'), icon: 'profiles' },
			{ path: '/subscriptions', label: t('nav.subscriptions'), icon: 'subscriptions' },
		],
	},
]);

const activeMenu = computed(() => {
	if (route.path.startsWith('/nodes')) return '/nodes';
	if (route.path.startsWith('/subscribers')) return '/subscribers';
	return route.path;
});

const parentCrumb = computed<{ label: string; to: string } | null>(() => {
	if (route.name === 'node-detail') {
		return { label: t('nav.nodes'), to: '/nodes' };
	}
	if (route.name === 'subscriber-detail') {
		return { label: t('nav.subscribers'), to: '/subscribers' };
	}
	return null;
});

const title = computed(() => {
	if (parentCrumb.value && entityTitle.value) {
		return entityTitle.value;
	}
	return route.meta.titleKey ? t(route.meta.titleKey as MessageKey) : '';
});

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
	<div class="shell" :class="{ 'is-collapsed': collapsed }">
		<div v-if="mobileOpen" class="mobile-backdrop" @click="mobileOpen = false" />

		<aside class="aside" :class="{ 'is-open': mobileOpen, 'is-collapsed': collapsed }">
			<div class="brand">
				<span class="brand-mark" aria-hidden="true">
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M5 7h14L5 17h14" />
					</svg>
				</span>
				<div v-if="!collapsed" class="brand-copy">
					<span class="brand-name">Zako Panel</span>
					<span class="brand-sub mono">EDGE CTRL</span>
				</div>
			</div>

			<nav class="nav" :aria-label="t('nav.mainNavigation')">
				<div v-for="group in navGroups" :key="group.key" class="nav-group">
					<div v-if="!collapsed" class="nav-group-title">{{ group.title }}</div>
					<RouterLink
						v-for="item in group.items"
						:key="item.path"
						:to="item.path"
						class="nav-item"
						:class="{ 'is-active': activeMenu === item.path }"
						:title="collapsed ? item.label : undefined"
					>
						<AppIcon :name="item.icon" :size="17" />
						<span v-if="!collapsed" class="nav-label">{{ item.label }}</span>
					</RouterLink>
				</div>
			</nav>

			<div class="aside-footer">
				<span v-if="!collapsed" class="aside-meta">{{ t('nav.controlPanel') }}</span>
				<button
					type="button"
					class="collapse-btn"
					:aria-label="collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
					:title="collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
					@click="toggleCollapsed"
				>
					<AppIcon :name="collapsed ? 'panel-expand' : 'panel-collapse'" :size="16" />
				</button>
			</div>
		</aside>

		<div class="workspace">
			<header class="header">
				<div class="header-inner">
					<div class="header-left">
						<button type="button" class="menu-trigger" :aria-label="t('nav.openNavigation')" @click="mobileOpen = !mobileOpen">
							<AppIcon name="menu" :size="18" />
						</button>
						<div class="breadcrumb-title">
							<template v-if="parentCrumb">
								<RouterLink :to="parentCrumb.to" class="crumb-parent">{{ parentCrumb.label }}</RouterLink>
								<AppIcon name="chevron-right" :size="14" class="crumb-sep" />
							</template>
							<h1 class="page-title">{{ title }}</h1>
						</div>
					</div>
					<div class="header-right">
						<button type="button" class="header-trigger command-trigger" :aria-label="t('nav.commandPalette')" @click="paletteOpen = true">
							<AppIcon name="search" :size="14" />
							<span class="trigger-label">{{ t('nav.commandPalette') }}</span>
							<kbd class="kbd-chip mono">⌘K</kbd>
						</button>
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

		<CommandPalette v-model:visible="paletteOpen" />
	</div>
</template>

<style scoped>
.shell {
	min-height: 100vh;
	display: flex;
	background: var(--bg-canvas);
}

.aside {
	width: var(--sidebar-width);
	flex: none;
	background: var(--bg-surface);
	border-right: 1px solid var(--border-color);
	display: flex;
	flex-direction: column;
	position: sticky;
	top: 0;
	height: 100vh;
	z-index: 30;
	transition: width var(--duration-normal) var(--ease-standard);
}

.aside.is-collapsed {
	width: var(--sidebar-collapsed-width);
}

.brand {
	height: var(--header-height);
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 0 16px;
	border-bottom: 1px solid var(--border-subtle);
	overflow: hidden;
}

.aside.is-collapsed .brand {
	justify-content: center;
	padding: 0;
}

.brand-mark {
	width: 30px;
	height: 30px;
	flex: none;
	border-radius: 8px;
	background: var(--brand-mark-bg);
	color: var(--brand-mark-fg);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	box-shadow: var(--shadow-xs);
}

.brand-copy {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.brand-name {
	font-size: 14.5px;
	font-weight: 600;
	color: var(--text-primary);
	letter-spacing: -0.015em;
	line-height: 1.2;
}

.brand-sub {
	font-size: 10px;
	font-weight: 500;
	letter-spacing: 0.08em;
	color: var(--text-muted);
}

.nav {
	flex: 1;
	padding: 14px 10px;
	display: flex;
	flex-direction: column;
	gap: 16px;
	overflow-y: auto;
}

.nav-group {
	display: flex;
	flex-direction: column;
	gap: 3px;
}

.nav-group-title {
	padding: 0 12px 4px;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.04em;
	color: var(--text-placeholder);
}

.nav-item {
	display: flex;
	align-items: center;
	gap: 10px;
	height: 38px;
	padding: 0 12px;
	border-radius: 8px;
	color: var(--text-secondary);
	text-decoration: none;
	font-size: 13.5px;
	font-weight: 500;
	white-space: nowrap;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		color var(--duration-fast) var(--ease-standard);
}

.aside.is-collapsed .nav-item {
	justify-content: center;
	padding: 0;
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
	padding: 10px 14px;
	border-top: 1px solid var(--border-subtle);
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.aside.is-collapsed .aside-footer {
	justify-content: center;
	padding: 10px 0;
}

.aside-meta {
	font-size: 12px;
	color: var(--text-placeholder);
	white-space: nowrap;
	overflow: hidden;
}

.collapse-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border: 1px solid transparent;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-muted);
	cursor: pointer;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		color var(--duration-fast) var(--ease-standard);
}

.collapse-btn:hover {
	background: var(--bg-subtle);
	color: var(--text-primary);
}

.workspace {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
}

.header {
	height: var(--header-height);
	background: var(--bg-header-glass);
	backdrop-filter: blur(12px);
	-webkit-backdrop-filter: blur(12px);
	border-bottom: 1px solid var(--border-color);
	position: sticky;
	top: 0;
	z-index: 20;
	display: flex;
	align-items: center;
}

.header-inner {
	width: 100%;
	max-width: var(--content-max-width);
	margin: 0 auto;
	padding: 0 24px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.header-left {
	display: flex;
	align-items: center;
	gap: 12px;
	min-width: 0;
}

.breadcrumb-title {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
}

.crumb-parent {
	font-size: 14px;
	font-weight: 500;
	color: var(--text-muted);
	text-decoration: none;
	white-space: nowrap;
}

.crumb-parent:hover {
	color: var(--accent-primary);
}

.crumb-sep {
	color: var(--text-placeholder);
}

.header-right {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: none;
}

.header-trigger {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 32px;
	padding: 0 10px;
	border: 1px solid var(--border-color);
	border-radius: 8px;
	background: var(--bg-surface);
	color: var(--text-secondary);
	font-family: inherit;
	font-size: 12.5px;
	font-weight: 500;
	cursor: pointer;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		border-color var(--duration-fast) var(--ease-standard),
		color var(--duration-fast) var(--ease-standard);
}

.header-trigger:hover {
	background: var(--bg-subtle);
	border-color: var(--border-hover);
	color: var(--text-primary);
}

.kbd-chip {
	font-size: 11px;
	padding: 1px 5px;
	border-radius: var(--radius-xs);
	background: var(--bg-muted);
	border: 1px solid var(--border-subtle);
	color: var(--text-muted);
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
	border-radius: 8px;
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
	font-size: 15.5px;
	font-weight: 600;
	color: var(--text-primary);
	letter-spacing: -0.015em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.main {
	flex: 1;
	padding: 24px;
}

.main-inner {
	max-width: calc(var(--content-max-width) - 48px);
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
		width: var(--sidebar-width) !important;
		transform: translateX(-100%);
		transition: transform var(--duration-normal) var(--ease-standard);
	}

	.aside.is-open {
		transform: translateX(0);
	}

	.collapse-btn {
		display: none;
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

@media (max-width: 640px) {
	.trigger-label,
	.kbd-chip {
		display: none;
	}
}
</style>
