<script setup lang="ts">
import type { RecycleBinItem, RecycleBinItemType } from '@zako/contracts';
import { computed, ref } from 'vue';
import { recycleBinApi } from '../api/recycle-bin';
import { invalidateCachedPrefix, invalidateCachedResource } from '../composables/resourceCache';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useI18n } from '../i18n';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';
import AppIcon from './AppIcon.vue';
import PageToolbar from './PageToolbar.vue';

const props = defineProps<{
	itemType: RecycleBinItemType;
	items: RecycleBinItem[];
	retentionDays: number;
	loading: boolean;
	refreshing: boolean;
}>();

const emit = defineEmits<{
	refresh: [];
	changed: [];
}>();

const { t } = useI18n();
const search = ref('');

const filteredItems = computed(() => {
	const q = search.value.trim().toLowerCase();
	if (!q) return props.items;
	return props.items.filter((item) => item.name.toLowerCase().includes(q) || (item.detail ?? '').toLowerCase().includes(q));
});

const retentionHint = computed(() => t(`recycleBin.retentionHints.${props.itemType}`, { days: props.retentionDays }));

function remainingLabel(purgeAt: number): string {
	const remainingSeconds = purgeAt - Math.floor(Date.now() / 1000);
	if (remainingSeconds <= 86_400) return t('recycleBin.dueSoon');
	const days = Math.ceil(remainingSeconds / 86_400);
	return t('recycleBin.remainingDays', { days });
}

function invalidateRelatedCaches(): void {
	invalidateCachedPrefix('recycle-bin:');
	invalidateCachedResource('subscribers:list');
	invalidateCachedResource('subscriptions:list');
	invalidateCachedResource('profiles:list');
	invalidateCachedPrefix('subscribers:detail:');
	invalidateCachedPrefix('nodes:clients:');
}

const restoreAction = useAsyncAction(
	async (item: RecycleBinItem) => {
		await recycleBinApi.restore(item.type, item.id);
		showSuccess(t('recycleBin.restore.success', { name: item.name }));
		invalidateRelatedCaches();
		emit('changed');
	},
	{ onError: (error) => showError(error, t('recycleBin.restore.failed')) },
);

const purgeAction = useAsyncAction(
	async (item: RecycleBinItem) => {
		await recycleBinApi.purge(item.type, item.id);
		showSuccess(t('recycleBin.purge.success', { name: item.name }));
		invalidateRelatedCaches();
		emit('changed');
	},
	{ onError: (error) => showError(error, t('recycleBin.purge.failed')) },
);

const emptyAction = useAsyncAction(
	async () => {
		const result = await recycleBinApi.empty(props.itemType);
		showSuccess(t('recycleBin.emptyAction.success', { count: result.deleted.total }));
		invalidateRelatedCaches();
		emit('changed');
	},
	{ onError: (error) => showError(error, t('recycleBin.emptyAction.failed')) },
);

async function restoreItem(item: RecycleBinItem): Promise<void> {
	if (!(await confirmAction(t('recycleBin.restore.confirm', { name: item.name })))) return;
	await restoreAction.runFor(item.id, item);
}

async function purgeItem(item: RecycleBinItem): Promise<void> {
	if (!(await confirmAction(t('recycleBin.purge.confirm', { name: item.name })))) return;
	await purgeAction.runFor(item.id, item);
}

async function emptyCategory(): Promise<void> {
	if (props.items.length === 0) return;
	if (!(await confirmAction(t('recycleBin.emptyAction.confirm', { count: props.items.length })))) return;
	await emptyAction.run();
}
</script>

<template>
	<el-alert type="info" :closable="false" show-icon class="ui-section" :title="retentionHint" />

	<PageToolbar spread>
		<template #left>
			<el-input v-model="search" :placeholder="t('recycleBin.searchPlaceholder')" clearable class="search-input" />
		</template>
		<el-button :loading="refreshing" @click="emit('refresh')">
			<AppIcon name="refresh" :size="14" class="btn-icon" />
			<span>{{ t('common.refresh') }}</span>
		</el-button>
		<el-button type="danger" plain :disabled="items.length === 0" :loading="emptyAction.running.value" @click="emptyCategory">
			<AppIcon name="trash" :size="14" class="btn-icon" />
			<span>{{ t('recycleBin.emptyButton') }}</span>
		</el-button>
	</PageToolbar>

	<el-card shadow="never">
		<el-table v-loading="loading" :data="filteredItems" :empty-text="t('recycleBin.empty')">
			<el-table-column :label="t('recycleBin.columns.item')" min-width="240">
				<template #default="{ row }">
					<div class="item-cell">
						<span class="item-name">{{ row.name }}</span>
						<span v-if="row.detail" class="item-detail">{{ row.detail }}</span>
					</div>
				</template>
			</el-table-column>
			<el-table-column :label="t('recycleBin.columns.deletedAt')" width="190">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.deleted_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('recycleBin.columns.purgeAt')" width="220">
				<template #default="{ row }">
					<div class="purge-cell">
						<span class="tnum">{{ formatTimestamp(row.purge_at) }}</span>
						<span class="purge-remaining">{{ remainingLabel(row.purge_at) }}</span>
					</div>
				</template>
			</el-table-column>
			<el-table-column :label="t('common.actions')" width="180" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" :loading="restoreAction.isRunning(row.id)" @click="restoreItem(row as RecycleBinItem)">
						{{ t('recycleBin.actions.restore') }}
					</el-button>
					<el-button link type="danger" :loading="purgeAction.isRunning(row.id)" @click="purgeItem(row as RecycleBinItem)">
						{{ t('recycleBin.actions.purge') }}
					</el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>

<style scoped>
.btn-icon {
	margin-right: 5px;
}

.search-input {
	width: 240px;
}

.item-cell {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.item-name {
	font-weight: 600;
	color: var(--text-primary);
}

.item-detail {
	font-size: 12px;
	color: var(--text-muted);
}

.purge-cell {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.purge-remaining {
	font-size: 12px;
	color: var(--text-muted);
}
</style>
