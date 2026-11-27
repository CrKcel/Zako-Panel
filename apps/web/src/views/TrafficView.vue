<script setup lang="ts">
import type { TrafficGroupBy, TrafficItem } from '@zako/contracts';
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { trafficApi } from '../api/traffic';
import AppIcon from '../components/AppIcon.vue';
import PageToolbar from '../components/PageToolbar.vue';
import StatCard from '../components/StatCard.vue';
import { useAsyncResource } from '../composables/useAsyncResource';
import {
	sumTrafficItems,
	trafficChartData,
	trafficItemLabel,
	trafficItemTotal,
	trafficWindow,
	TRAFFIC_WINDOWS,
	type TrafficWindowKey,
} from '../domain/traffic';
import { useI18n } from '../i18n';
import { showError } from '../utils/feedback';
import { formatBytes } from '../utils/format';

const TrafficChart = defineAsyncComponent(() => import('../components/TrafficChart.vue'));

const { t } = useI18n();
const range = ref<TrafficWindowKey>('24h');
const groupBy = ref<TrafficGroupBy>('node');
const orientation = ref<'vertical' | 'horizontal'>('vertical');

const {
	data: summary,
	loading,
	reload,
} = useAsyncResource(() => trafficApi.summary({ ...trafficWindow(TRAFFIC_WINDOWS[range.value]), groupBy: groupBy.value }), {
	initialValue: null,
	onError: (error) => showError(error, t('traffic.loadError')),
});

const sortedItems = computed(() => [...(summary.value?.items ?? [])].sort((a, b) => trafficItemTotal(b) - trafficItemTotal(a)));
const totals = computed(() => sumTrafficItems(sortedItems.value));
const chart = computed(() => trafficChartData(sortedItems.value));

function sharePercent(item: TrafficItem): number {
	if (totals.value.total <= 0) return 0;
	return Math.round((trafficItemTotal(item) / totals.value.total) * 1000) / 10;
}

watch([range, groupBy], () => {
	void reload();
});
</script>

<template>
	<PageToolbar spread>
		<template #left>
			<div class="filters">
				<el-radio-group v-model="range">
					<el-radio-button value="24h">{{ t('traffic.ranges.24h') }}</el-radio-button>
					<el-radio-button value="7d">{{ t('traffic.ranges.7d') }}</el-radio-button>
					<el-radio-button value="30d">{{ t('traffic.ranges.30d') }}</el-radio-button>
				</el-radio-group>
				<el-radio-group v-model="groupBy">
					<el-radio-button value="node">{{ t('traffic.groupBy.node') }}</el-radio-button>
					<el-radio-button value="subscriber">{{ t('traffic.groupBy.subscriber') }}</el-radio-button>
					<el-radio-button value="site">{{ t('traffic.groupBy.site') }}</el-radio-button>
				</el-radio-group>
			</div>
		</template>
		<el-radio-group v-model="orientation" size="small">
			<el-radio-button value="vertical">{{ t('traffic.chartModeVertical') }}</el-radio-button>
			<el-radio-button value="horizontal">{{ t('traffic.chartModeHorizontal') }}</el-radio-button>
		</el-radio-group>
		<el-button :loading="loading" @click="reload">
			<AppIcon name="refresh" :size="14" class="btn-icon" />
			<span>{{ t('common.refresh') }}</span>
		</el-button>
	</PageToolbar>

	<div v-loading="loading" class="stats-grid ui-section">
		<StatCard :label="t('traffic.uplink')" :value="formatBytes(totals.uplink)" icon="arrow-up" tone="primary" />
		<StatCard :label="t('traffic.downlink')" :value="formatBytes(totals.downlink)" icon="arrow-down" tone="success" />
		<StatCard :label="t('traffic.total')" :value="formatBytes(totals.total)" icon="activity" />
	</div>

	<el-card v-if="sortedItems.length > 0" shadow="never" class="ui-section">
		<template #header>
			<div class="ui-card-header">
				<span class="ui-card-title">{{ t('traffic.chartTitle') }}</span>
			</div>
		</template>
		<TrafficChart
			:categories="chart.categories"
			:series="chart.series"
			:orientation="orientation"
			:height="orientation === 'horizontal' ? `${Math.max(260, sortedItems.length * 38 + 64)}px` : '320px'"
		/>
	</el-card>

	<el-card shadow="never">
		<template #header>
			<div class="ui-card-header">
				<span class="ui-card-title">{{ t('traffic.tableTitle') }}</span>
			</div>
		</template>
		<el-table :data="sortedItems" :empty-text="t('common.noData')">
			<el-table-column :label="t('traffic.dimension')" min-width="200">
				<template #default="{ row }">{{ trafficItemLabel(row as TrafficItem) }}</template>
			</el-table-column>
			<el-table-column :label="t('traffic.uplink')" width="150">
				<template #default="{ row }">
					<span class="tnum">{{ formatBytes(row.uplink_bytes) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('traffic.downlink')" width="150">
				<template #default="{ row }">
					<span class="tnum">{{ formatBytes(row.downlink_bytes) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('traffic.tableTotal')" width="150">
				<template #default="{ row }">
					<span class="tnum total-cell">{{ formatBytes(trafficItemTotal(row as TrafficItem)) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('traffic.sharePercent')" min-width="180">
				<template #default="{ row }">
					<div class="share-cell">
						<div class="share-bar">
							<div class="share-bar-fill" :style="{ width: `${sharePercent(row as TrafficItem)}%` }" />
						</div>
						<span class="share-text tnum">{{ sharePercent(row as TrafficItem).toFixed(1) }}%</span>
					</div>
				</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>

<style scoped>
.btn-icon {
	margin-right: 5px;
}

.filters {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}

.stats-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: 14px;
}

.total-cell {
	font-weight: 600;
	color: var(--text-primary);
}

.share-cell {
	display: flex;
	align-items: center;
	gap: 10px;
}

.share-bar {
	flex: 1;
	max-width: 110px;
	height: 6px;
	border-radius: var(--radius-pill);
	background: var(--bg-subtle);
	overflow: hidden;
}

.share-bar-fill {
	height: 100%;
	border-radius: var(--radius-pill);
	background: var(--accent-primary);
}

.share-text {
	font-size: 12px;
	color: var(--text-muted);
	width: 44px;
	text-align: right;
}
</style>
