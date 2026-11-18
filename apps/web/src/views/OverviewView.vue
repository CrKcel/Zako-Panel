<script setup lang="ts">
import type { Node, TrafficSummary } from '@zako/contracts';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { trafficApi } from '../api/traffic';
import StatCard, { type StatTone } from '../components/StatCard.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TrafficTotalsCard from '../components/TrafficTotalsCard.vue';
import { useAsyncResource } from '../composables/useAsyncResource';
import { usePolling } from '../composables/usePolling';
import { nodeStatusDescriptor } from '../domain/status';
import { DAY_SECONDS, trafficWindow } from '../domain/traffic';
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

const stats = computed<Array<{ label: string; value: number; tone: StatTone }>>(() => {
	const count = (status: Node['status']): number => nodes.value.filter((node) => node.status === status).length;
	return [
		{ label: '节点总数', value: nodes.value.length, tone: 'primary' },
		{ label: '在线节点', value: count('online'), tone: 'success' },
		{ label: '异常节点', value: count('degraded'), tone: 'warning' },
		{ label: '离线节点', value: count('offline'), tone: 'danger' },
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
	<div v-loading="nodeLoading" class="stats-grid ui-section">
		<StatCard v-for="stat in stats" :key="stat.label" :label="stat.label" :value="stat.value" :tone="stat.tone" />
	</div>

	<TrafficTotalsCard :summary="traffic" :loading="trafficLoading" title="近 24 小时流量" />

	<el-card shadow="never">
		<template #header>
			<div class="ui-card-header">
				<span class="ui-card-title">最近异常</span>
				<el-button size="small" :loading="nodeLoading || trafficLoading" @click="refresh">刷新</el-button>
			</div>
		</template>
		<el-table v-loading="nodeLoading" :data="anomalies" empty-text="所有节点运行正常">
			<el-table-column label="节点" min-width="180">
				<template #default="{ row }">
					<RouterLink :to="`/nodes/${row.id}`" class="ui-link">{{ row.name }}</RouterLink>
				</template>
			</el-table-column>
			<el-table-column label="状态" width="110">
				<template #default="{ row }">
					<StatusBadge
						:label="nodeStatusDescriptor(row.status as Node['status']).label"
						:type="nodeStatusDescriptor(row.status as Node['status']).tag"
					/>
				</template>
			</el-table-column>
			<el-table-column label="最近心跳" width="180">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.last_seen_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column label="错误" min-width="260">
				<template #default="{ row }">
					<span :class="{ 'error-text': Boolean(row.last_config_error) }">{{ row.last_config_error ?? '—' }}</span>
				</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>

<style scoped>
.stats-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
	gap: 14px;
}

.error-text {
	color: var(--tone-danger);
	font-size: 13px;
}
</style>
