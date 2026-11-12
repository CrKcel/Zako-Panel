<script setup lang="ts">
import type { TrafficItem } from '@zako/contracts';
import { defineAsyncComponent, ref } from 'vue';
import { formatBytes } from '../utils/format';

const TrafficChart = defineAsyncComponent(() => import('../components/TrafficChart.vue'));

const categories = ref<string[]>([]);
const series = ref<{ name: string; values: number[] }[]>([]);
const items = ref<TrafficItem[]>([]);
</script>

<template>
	<el-card shadow="never" class="chart-card">
		<TrafficChart :categories="categories" :series="series" />
	</el-card>

	<el-card shadow="never">
		<el-table :data="items" empty-text="暂无数据">
			<el-table-column prop="label" label="维度" min-width="200" />
			<el-table-column label="上行" width="140">
				<template #default="{ row }">{{ formatBytes(row.uplink_bytes) }}</template>
			</el-table-column>
			<el-table-column label="下行" width="140">
				<template #default="{ row }">{{ formatBytes(row.downlink_bytes) }}</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>

<style scoped>
.chart-card {
	margin-bottom: 16px;
}
</style>
