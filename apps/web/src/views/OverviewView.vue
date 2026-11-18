<script setup lang="ts">
import type { Node, TrafficSummary } from '@zako/contracts';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { trafficApi } from '../api/traffic';
import TrafficTotalsCard from '../components/TrafficTotalsCard.vue';
import { useAsyncResource } from '../composables/useAsyncResource';
import { usePolling } from '../composables/usePolling';
import { DAY_SECONDS, trafficWindow } from '../domain/traffic';
import { nodeStatusDescriptor } from '../domain/status';
import { showError } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

const {
	data: nodes,
	loading: nodeLoading,
	reload: reloadNodes,
} = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	immediate: false,
	initialValue: [],
	onError: (error) => showError(error, '节点加载失败'),
});

const {
	data: traffic,
	loading: trafficLoading,
	reload: reloadTraffic,
} = useAsyncResource<TrafficSummary | null>(() => trafficApi.summary({ ...trafficWindow(DAY_SECONDS), groupBy: 'site' }), {
	immediate: false,
	initialValue: null,
	onError: (error) => showError(error, '流量加载失败'),
});

const stats = computed(() => {
	const count = (status: Node['status']): number => nodes.value.filter((node) => node.status === status).length;
	return [
		{ label: '节点总数', value: nodes.value.length },
		{ label: '在线节点', value: count('online') },
		{ label: '异常节点', value: count('degraded') },
		{ label: '离线节点', value: count('offline') },
	];
});

const anomalies = computed(() =>
	nodes.value
		.filter(
			(node) => node.status === 'degraded' || node.status === 'offline' || node.status === 'disabled' || Boolean(node.last_config_error),
		)
		.slice()
		.sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0)),
);

const { refresh } = usePolling(async () => {
	await Promise.all([reloadNodes(), reloadTraffic()]);
}, 30_000);
</script>

<template>
	<div v-loading="nodeLoading" class="stats">
		<el-card v-for="stat in stats" :key="stat.label" shadow="never" class="stat-card">
			<div class="stat-label">{{ stat.label }}</div>
			<div class="stat-value">{{ stat.value }}</div>
		</el-card>
	</div>

	<TrafficTotalsCard :summary="traffic" :loading="trafficLoading" title="近 24 小时流量" />

	<el-card shadow="never">
		<template #header>
			<div class="card-header">
				<span class="card-title">最近异常</span>
				<el-button link type="primary" @click="refresh">刷新</el-button>
			</div>
		</template>
		<el-table v-loading="nodeLoading" :data="anomalies" empty-text="暂无数据">
			<el-table-column label="节点" min-width="180">
				<template #default="{ row }">
					<RouterLink :to="`/nodes/${row.id}`" class="node-link">{{ row.name }}</RouterLink>
				</template>
			</el-table-column>
			<el-table-column label="状态" width="100">
				<template #default="{ row }">
					<el-tag :type="nodeStatusDescriptor(row.status as Node['status']).tag" disable-transitions>
						{{ nodeStatusDescriptor(row.status as Node['status']).label }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="最近心跳" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.last_seen_at) }}</template>
			</el-table-column>
			<el-table-column label="错误" min-width="260">
				<template #default="{ row }">{{ row.last_config_error ?? '—' }}</template>
			</el-table-column>
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

.stat-card {
	min-height: 96px;
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

.card-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.card-title {
	font-size: 14px;
	font-weight: 600;
}

.node-link {
	color: #2563eb;
	text-decoration: none;
}

.node-link:hover {
	text-decoration: underline;
}
</style>
