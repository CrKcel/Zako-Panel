<script setup lang="ts">
import type { TrafficSummary } from '@zako/contracts';
import { computed } from 'vue';
import { sumTrafficItems } from '../domain/traffic';
import { formatBytes } from '../utils/format';

const props = defineProps<{
	summary: TrafficSummary | null;
	title?: string;
	loading?: boolean;
}>();

const metrics = computed(() => {
	const totals = sumTrafficItems(props.summary?.items);
	return [
		{ label: '上行', value: formatBytes(totals.uplink) },
		{ label: '下行', value: formatBytes(totals.downlink) },
		{ label: '总计', value: formatBytes(totals.total) },
	];
});
</script>

<template>
	<el-card v-loading="loading" shadow="never" class="traffic-totals">
		<template v-if="title" #header>
			<span class="card-title">{{ title }}</span>
		</template>
		<div class="metric-grid">
			<div v-for="metric in metrics" :key="metric.label" class="metric">
				<div class="metric-label">{{ metric.label }}</div>
				<div class="metric-value">{{ metric.value }}</div>
			</div>
		</div>
		<slot />
	</el-card>
</template>

<style scoped>
.traffic-totals {
	margin-bottom: 16px;
}

.card-title {
	font-size: 14px;
	font-weight: 600;
}

.metric-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 16px;
}

.metric-label {
	font-size: 13px;
	color: #6b7280;
}

.metric-value {
	margin-top: 8px;
	font-size: 22px;
	font-weight: 600;
	color: #111827;
}
</style>
