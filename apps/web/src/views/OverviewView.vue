<script setup lang="ts">
import type { Node } from '@zako/contracts';
import { computed, ref } from 'vue';

const nodes = ref<Node[]>([]);

const stats = computed(() => [
	{ label: '节点总数', value: nodes.value.length },
	{ label: '在线节点', value: nodes.value.filter((node) => node.status === 'online').length },
	{ label: '异常节点', value: nodes.value.filter((node) => node.status === 'degraded').length },
	{ label: '今日流量', value: '—' },
]);
</script>

<template>
	<div class="stats">
		<el-card v-for="stat in stats" :key="stat.label" shadow="never" class="stat-card">
			<div class="stat-label">{{ stat.label }}</div>
			<div class="stat-value">{{ stat.value }}</div>
		</el-card>
	</div>

	<el-card shadow="never">
		<template #header>
			<span class="card-title">最近异常</span>
		</template>
		<el-table :data="[]" empty-text="暂无数据">
			<el-table-column prop="node" label="节点" min-width="160" />
			<el-table-column prop="message" label="错误" min-width="320" />
			<el-table-column prop="at" label="时间" width="180" />
		</el-table>
	</el-card>
</template>

<style scoped>
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
	font-size: 26px;
	font-weight: 600;
	color: #111827;
}

.card-title {
	font-size: 14px;
	font-weight: 600;
}
</style>
