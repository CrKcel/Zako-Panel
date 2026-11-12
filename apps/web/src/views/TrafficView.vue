<script setup lang="ts">
import type { TrafficGroupBy, TrafficSummary } from '@zako/contracts';
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue';
import { trafficApi } from '../api/traffic';
import { showError } from '../utils/feedback';
import { formatBytes } from '../utils/format';

const TrafficChart = defineAsyncComponent(() => import('../components/TrafficChart.vue'));

type RangeKey = '24h' | '7d' | '30d';

const RANGE_SECONDS: Record<RangeKey, number> = {
	'24h': 24 * 60 * 60,
	'7d': 7 * 24 * 60 * 60,
	'30d': 30 * 24 * 60 * 60,
};

const range = ref<RangeKey>('24h');
const groupBy = ref<TrafficGroupBy>('node');
const summary = ref<TrafficSummary | null>(null);
const loading = ref(true);

const items = computed(() => summary.value?.items ?? []);

const totals = computed(() => {
	const uplink = items.value.reduce((total, item) => total + item.uplink_bytes, 0);
	const downlink = items.value.reduce((total, item) => total + item.downlink_bytes, 0);
	return { uplink, downlink, total: uplink + downlink };
});

const categories = computed(() => items.value.map((item) => item.label ?? item.key));
const series = computed(() => [
	{ name: '上行', values: items.value.map((item) => item.uplink_bytes) },
	{ name: '下行', values: items.value.map((item) => item.downlink_bytes) },
]);

async function load(): Promise<void> {
	loading.value = true;
	try {
		const to = Math.floor(Date.now() / 1000);
		summary.value = await trafficApi.summary({
			from: to - RANGE_SECONDS[range.value],
			to,
			groupBy: groupBy.value,
		});
	} catch (error) {
		showError(error, '流量加载失败');
	} finally {
		loading.value = false;
	}
}

watch([range, groupBy], () => {
	void load();
});

onMounted(load);
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
			<el-button :loading="loading" @click="load">刷新</el-button>
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
		<TrafficChart :categories="categories" :series="series" />
	</el-card>

	<el-card shadow="never">
		<el-table :data="items" empty-text="暂无数据">
			<el-table-column label="维度" min-width="200">
				<template #default="{ row }">{{ row.label ?? row.key }}</template>
			</el-table-column>
			<el-table-column label="上行" width="160">
				<template #default="{ row }">{{ formatBytes(row.uplink_bytes) }}</template>
			</el-table-column>
			<el-table-column label="下行" width="160">
				<template #default="{ row }">{{ formatBytes(row.downlink_bytes) }}</template>
			</el-table-column>
			<el-table-column label="合计" width="160">
				<template #default="{ row }">{{ formatBytes(row.uplink_bytes + row.downlink_bytes) }}</template>
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
