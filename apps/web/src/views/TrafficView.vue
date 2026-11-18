<script setup lang="ts">
import type { TrafficGroupBy, TrafficItem } from '@zako/contracts';
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { trafficApi } from '../api/traffic';
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
import { showError } from '../utils/feedback';
import { formatBytes } from '../utils/format';

const TrafficChart = defineAsyncComponent(() => import('../components/TrafficChart.vue'));

const range = ref<TrafficWindowKey>('24h');
const groupBy = ref<TrafficGroupBy>('node');

const {
	data: summary,
	loading,
	reload,
} = useAsyncResource(() => trafficApi.summary({ ...trafficWindow(TRAFFIC_WINDOWS[range.value]), groupBy: groupBy.value }), {
	initialValue: null,
	onError: (error) => showError(error, '流量加载失败'),
});

const items = computed(() => summary.value?.items ?? []);
const totals = computed(() => sumTrafficItems(items.value));
const chart = computed(() => trafficChartData(items.value));

watch([range, groupBy], () => {
	void reload();
});
</script>

<template>
	<PageToolbar spread>
		<template #left>
			<div class="filters">
				<el-radio-group v-model="range">
					<el-radio-button value="24h">24 小时</el-radio-button>
					<el-radio-button value="7d">7 天</el-radio-button>
					<el-radio-button value="30d">30 天</el-radio-button>
				</el-radio-group>
				<el-radio-group v-model="groupBy">
					<el-radio-button value="node">节点</el-radio-button>
					<el-radio-button value="subscriber">订阅用户</el-radio-button>
					<el-radio-button value="site">全站</el-radio-button>
				</el-radio-group>
			</div>
		</template>
		<el-button :loading="loading" @click="reload">刷新</el-button>
	</PageToolbar>

	<div v-loading="loading" class="stats-grid ui-section">
		<StatCard label="上行" :value="formatBytes(totals.uplink)" icon="arrow-up" tone="primary" />
		<StatCard label="下行" :value="formatBytes(totals.downlink)" icon="arrow-down" tone="success" />
		<StatCard label="总计" :value="formatBytes(totals.total)" icon="activity" />
	</div>

	<el-card v-if="items.length > 0" shadow="never" class="ui-section">
		<template #header>
			<div class="ui-card-header">
				<span class="ui-card-title">流量趋势</span>
			</div>
		</template>
		<TrafficChart :categories="chart.categories" :series="chart.series" />
	</el-card>

	<el-card shadow="never">
		<template #header>
			<div class="ui-card-header">
				<span class="ui-card-title">流量明细</span>
			</div>
		</template>
		<el-table :data="items" empty-text="暂无数据">
			<el-table-column label="维度" min-width="200">
				<template #default="{ row }">{{ trafficItemLabel(row as TrafficItem) }}</template>
			</el-table-column>
			<el-table-column label="上行" width="160">
				<template #default="{ row }">
					<span class="tnum">{{ formatBytes(row.uplink_bytes) }}</span>
				</template>
			</el-table-column>
			<el-table-column label="下行" width="160">
				<template #default="{ row }">
					<span class="tnum">{{ formatBytes(row.downlink_bytes) }}</span>
				</template>
			</el-table-column>
			<el-table-column label="合计" width="160">
				<template #default="{ row }">
					<span class="tnum total-cell">{{ formatBytes(trafficItemTotal(row as TrafficItem)) }}</span>
				</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>

<style scoped>
.filters {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
}

.stats-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
	gap: 14px;
}

.total-cell {
	font-weight: 600;
	color: var(--text-primary);
}
</style>
