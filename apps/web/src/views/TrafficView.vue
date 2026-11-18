<script setup lang="ts">
import type { TrafficGroupBy, TrafficItem } from '@zako/contracts';
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { trafficApi } from '../api/traffic';
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
	<el-card shadow="never" class="toolbar-card">
		<div class="toolbar">
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
			<el-button :loading="loading" @click="reload">刷新</el-button>
		</div>
	</el-card>

	<div v-loading="loading" class="stats">
		<el-card
			v-for="stat in [
				{ label: '上行', value: formatBytes(totals.uplink) },
				{ label: '下行', value: formatBytes(totals.downlink) },
				{ label: '总计', value: formatBytes(totals.total) },
			]"
			:key="stat.label"
			shadow="never"
			class="stat-card"
		>
			<div class="stat-label">{{ stat.label }}</div>
			<div class="stat-value">{{ stat.value }}</div>
		</el-card>
	</div>

	<el-card v-if="items.length > 0" shadow="never" class="chart-card">
		<TrafficChart :categories="chart.categories" :series="chart.series" />
	</el-card>

	<el-card shadow="never">
		<el-table :data="items" empty-text="暂无数据">
			<el-table-column label="维度" min-width="200">
				<template #default="{ row }">{{ trafficItemLabel(row as TrafficItem) }}</template>
			</el-table-column>
			<el-table-column label="上行" width="160">
				<template #default="{ row }">{{ formatBytes(row.uplink_bytes) }}</template>
			</el-table-column>
			<el-table-column label="下行" width="160">
				<template #default="{ row }">{{ formatBytes(row.downlink_bytes) }}</template>
			</el-table-column>
			<el-table-column label="合计" width="160">
				<template #default="{ row }">{{ formatBytes(trafficItemTotal(row as TrafficItem)) }}</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>

<style scoped>
.toolbar-card {
	margin-bottom: 16px;
}

.toolbar {
	display: flex;
	align-items: center;
	gap: 16px;
	flex-wrap: wrap;
}

.stats {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 16px;
	margin-bottom: 16px;
}

.stat-label {
	font-size: 13px;
	color: #6b7280;
}

.stat-value {
	margin-top: 8px;
	font-size: 24px;
	font-weight: 600;
	color: #111827;
}

.chart-card {
	margin-bottom: 16px;
}
</style>
