<script setup lang="ts">
import type { Node, Subscriber } from '@zako/contracts';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { subscribersApi } from '../api/subscribers';
import { nodeStatusDescriptor, subscriberStatusDescriptor } from '../domain/status';
import { useI18n } from '../i18n';
import AppIcon, { type IconName } from './AppIcon.vue';
import StatusBadge from './StatusBadge.vue';

const props = defineProps<{
	visible: boolean;
}>();

const emit = defineEmits<{
	'update:visible': [value: boolean];
}>();

const { t } = useI18n();
const router = useRouter();

const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);
const loading = ref(false);
const nodes = ref<Node[]>([]);
const subscribers = ref<Subscriber[]>([]);
let loadedOnce = false;

interface PaletteItem {
	id: string;
	kind: 'page' | 'node' | 'subscriber';
	label: string;
	sublabel?: string;
	icon: IconName;
	to: string;
	badge?: { label: string; type: 'primary' | 'success' | 'info' | 'warning' | 'danger' };
}

const pageItems = computed<PaletteItem[]>(() => [
	{ id: 'page-overview', kind: 'page', label: t('nav.overview'), icon: 'overview', to: '/' },
	{ id: 'page-nodes', kind: 'page', label: t('nav.nodes'), icon: 'nodes', to: '/nodes' },
	{ id: 'page-subscribers', kind: 'page', label: t('nav.subscribers'), icon: 'subscribers', to: '/subscribers' },
	{ id: 'page-profiles', kind: 'page', label: t('nav.profiles'), icon: 'profiles', to: '/profiles' },
	{ id: 'page-subscriptions', kind: 'page', label: t('nav.subscriptions'), icon: 'subscriptions', to: '/subscriptions' },
	{ id: 'page-traffic', kind: 'page', label: t('nav.traffic'), icon: 'traffic', to: '/traffic' },
]);

const allItems = computed<PaletteItem[]>(() => {
	const nodeItems: PaletteItem[] = nodes.value.map((node) => ({
		id: `node-${node.id}`,
		kind: 'node',
		label: node.name,
		sublabel: node.agent_version ?? undefined,
		icon: 'nodes',
		to: `/nodes/${node.id}`,
		badge: {
			label: nodeStatusDescriptor(node.status).label,
			type: nodeStatusDescriptor(node.status).tag,
		},
	}));
	const subItems: PaletteItem[] = subscribers.value.map((sub) => ({
		id: `sub-${sub.id}`,
		kind: 'subscriber',
		label: sub.name,
		sublabel: sub.email ?? undefined,
		icon: 'subscribers',
		to: `/subscribers/${sub.id}`,
		badge: {
			label: subscriberStatusDescriptor(sub.status).label,
			type: subscriberStatusDescriptor(sub.status).tag,
		},
	}));
	return [...pageItems.value, ...nodeItems, ...subItems];
});

const filteredItems = computed<PaletteItem[]>(() => {
	const q = query.value.trim().toLowerCase();
	if (!q) return pageItems.value;
	return allItems.value.filter((item) => item.label.toLowerCase().includes(q) || (item.sublabel?.toLowerCase().includes(q) ?? false));
});

const groupedSections = computed(() => {
	const items = filteredItems.value;
	const groups: Array<{ key: string; title: string; items: Array<{ item: PaletteItem; index: number }> }> = [];
	const order: Array<{ kind: PaletteItem['kind']; title: string }> = [
		{ kind: 'page', title: t('nav.commandPages') },
		{ kind: 'node', title: t('nav.commandNodes') },
		{ kind: 'subscriber', title: t('nav.commandSubscribers') },
	];
	let flatIdx = 0;
	for (const group of order) {
		const matched = items.filter((item) => item.kind === group.kind);
		if (matched.length === 0) continue;
		groups.push({
			key: group.kind,
			title: group.title,
			items: matched.map((item) => ({ item, index: flatIdx++ })),
		});
	}
	return groups;
});

function close(): void {
	emit('update:visible', false);
}

function selectItem(item: PaletteItem): void {
	close();
	void router.push(item.to);
}

async function ensureEntitiesLoaded(): Promise<void> {
	if (loadedOnce || loading.value) return;
	loading.value = true;
	try {
		const [nodePage, subPage] = await Promise.all([nodesApi.list(), subscribersApi.list()]);
		nodes.value = nodePage.items;
		subscribers.value = subPage.items;
		loadedOnce = true;
	} catch {
		// Fail silently inside command palette; pages remain accessible.
	} finally {
		loading.value = false;
	}
}

watch(
	() => props.visible,
	async (open) => {
		if (!open) return;
		query.value = '';
		activeIndex.value = 0;
		void ensureEntitiesLoaded();
		await nextTick();
		inputRef.value?.focus();
	},
);

watch(filteredItems, () => {
	activeIndex.value = 0;
});

function handleKeydown(event: KeyboardEvent): void {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
		event.preventDefault();
		emit('update:visible', !props.visible);
		return;
	}
	if (!props.visible) return;
	if (event.key === 'Escape') {
		event.preventDefault();
		close();
		return;
	}
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		if (filteredItems.value.length > 0) {
			activeIndex.value = (activeIndex.value + 1) % filteredItems.value.length;
		}
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		if (filteredItems.value.length > 0) {
			activeIndex.value = (activeIndex.value - 1 + filteredItems.value.length) % filteredItems.value.length;
		}
	} else if (event.key === 'Enter') {
		const target = filteredItems.value[activeIndex.value];
		if (target) {
			event.preventDefault();
			selectItem(target);
		}
	}
}

onMounted(() => {
	window.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
	window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
	<Teleport to="body">
		<div v-if="visible" class="palette-backdrop" role="dialog" aria-modal="true" :aria-label="t('nav.commandPalette')" @click.self="close">
			<div class="palette-panel">
				<div class="palette-search">
					<AppIcon name="search" :size="16" class="search-icon" />
					<input ref="inputRef" v-model="query" type="text" class="palette-input" :placeholder="t('nav.commandPlaceholder')" />
					<button type="button" class="esc-hint mono" @click="close">ESC</button>
				</div>

				<div class="palette-body">
					<template v-if="groupedSections.length > 0">
						<div v-for="section in groupedSections" :key="section.key" class="palette-group">
							<div class="group-title">{{ section.title }}</div>
							<button
								v-for="entry in section.items"
								:key="entry.item.id"
								type="button"
								class="palette-item"
								:class="{ 'is-active': activeIndex === entry.index }"
								@mouseenter="activeIndex = entry.index"
								@click="selectItem(entry.item)"
							>
								<AppIcon :name="entry.item.icon" :size="15" class="item-icon" />
								<span class="item-main">
									<span class="item-label">{{ entry.item.label }}</span>
									<span v-if="entry.item.sublabel" class="item-sub mono">{{ entry.item.sublabel }}</span>
								</span>
								<StatusBadge v-if="entry.item.badge" :label="entry.item.badge.label" :type="entry.item.badge.type" />
								<AppIcon v-else name="chevron-right" :size="14" class="item-arrow" />
							</button>
						</div>
					</template>
					<div v-else class="palette-empty">
						{{ t('nav.commandNoResults') }}
					</div>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.palette-backdrop {
	position: fixed;
	inset: 0;
	z-index: 2000;
	background: var(--backdrop-color);
	backdrop-filter: blur(4px);
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding: 12vh 16px 24px;
}

.palette-panel {
	width: 100%;
	max-width: 560px;
	background: var(--bg-elevated);
	border: 1px solid var(--border-color);
	border-radius: var(--radius-lg);
	box-shadow: var(--shadow-dialog);
	overflow: hidden;
}

.palette-search {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 14px;
	border-bottom: 1px solid var(--border-subtle);
}

.search-icon {
	color: var(--text-muted);
}

.palette-input {
	flex: 1;
	min-width: 0;
	border: none;
	outline: none;
	background: transparent;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 14px;
}

.palette-input::placeholder {
	color: var(--text-placeholder);
}

.esc-hint {
	border: 1px solid var(--border-color);
	border-radius: var(--radius-xs);
	background: var(--bg-muted);
	color: var(--text-muted);
	padding: 2px 6px;
	font-size: 11px;
	cursor: pointer;
}

.palette-body {
	max-height: 360px;
	overflow-y: auto;
	padding: 8px;
}

.palette-group + .palette-group {
	margin-top: 8px;
}

.group-title {
	padding: 4px 10px;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.03em;
	color: var(--text-muted);
}

.palette-item {
	width: 100%;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 9px 10px;
	border: none;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-secondary);
	font-family: inherit;
	text-align: left;
	cursor: pointer;
	transition: background-color var(--duration-fast) var(--ease-standard);
}

.palette-item.is-active {
	background: var(--accent-primary-soft);
	color: var(--text-primary);
}

.item-icon {
	color: var(--text-muted);
}

.palette-item.is-active .item-icon {
	color: var(--accent-primary);
}

.item-main {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: baseline;
	gap: 8px;
}

.item-label {
	font-size: 13.5px;
	font-weight: 500;
	color: var(--text-primary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.item-sub {
	font-size: 11.5px;
	color: var(--text-muted);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.item-arrow {
	color: var(--text-placeholder);
}

.palette-empty {
	padding: 28px 16px;
	text-align: center;
	font-size: 13px;
	color: var(--text-muted);
}
</style>
