<script setup lang="ts">
import type { Node, TrafficSummary } from '@zako/contracts';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { trafficApi } from '../api/traffic';
import { usePolling } from '../composables/usePolling';
import { showError } from '../utils/feedback';
import { formatBytes, formatTimestamp, NODE_STATUS_LABEL, NODE_STATUS_TAG } from '../utils/format';

const nodes = ref<Node[]>([]);
const traffic = ref<TrafficSummary | null>(null);
const nodeLoading = ref(true);
const trafficLoading = ref(true);

const uptimeSeconds = 24 * 60 * 60;

const stats = computed(() => {
	const count = (status: Node['status']): number => nodes.value.filter((node) => node.status === status).length;
	return [
		{ label: '节点总数', value: nodes.value.length },
		{ label: '在线节点', value: count('online') },
		{ label: '异常节点', value: count('degraded') },
		{ label: '离线节点', value: count('offline') },
	];
});

const trafficTotals = computed(() => {
	const items = traffic.value?.items ?? [];
	const uplink = items.reduce((total, item) => total + item.uplink_bytes, 0);
	const downlink = items.reduce((total, item) => total + item.downlink_bytes, 0);
	return { uplink, downlink, total: uplink + downlink };
});

const anomalies = computed(() =>
	nodes.value
		.filter(
			(node) => node.status === 'degraded' || node.status === 'offline' || node.status === 'disabled' || Boolean(node.last_config_error),
		)
		.slice()
		.sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0)),
);

async function loadNodes(): Promise<void> {
	nodeLoading.value = true;
	try {
		const page = await nodesApi.list({ limit: 200 });
		nodes.value = page.items;
	} catch (error) {
		showError(error, '节点加载失败');
	} finally {
		nodeLoading.value = false;
	}
}

async function loadTraffic(): Promise<void> {
	trafficLoading.value = true;
	try {
		const to = Math.floor(Date.now() / 1000);
		traffic.value = await trafficApi.summary({ from: to - uptimeSeconds, to, groupBy: 'site' });
	} catch (error) {
		showError(error, '流量加载失败');
	} finally {
		trafficLoading.value = false;
	}
}

const { refresh } = usePolling(async () => {
	await Promise.all([loadNodes(), loadTraffic()]);
}, 30_000);
</script>

<template>
	<div v-loading="nodeLoading" class="stats">
		<el-card v-for="stat in stats" :key="stat.label" shadow="never" class="stat-card">
			<div class="stat-label">{{ stat.label }}</div>
			<div class="stat-value">{{ stat.value }}</div>
		</el-card>
	</div>

	<el-card v-loading="trafficLoading" shadow="never" class="traffic-card">
		<template #header>
			<span class="card-title">近 24 小时流量</span>
		</template>
		<div class="traffic-grid">
			<div class="traffic-item">
				<div class="stat-label">上行</div>
				<div class="traffic-value">{{ formatBytes(trafficTotals.uplink) }}</div>
			</div>
			<div class="traffic-item">
				<div class="stat-label">下行</div>
				<div class="traffic-value">{{ formatBytes(trafficTotals.downlink) }}</div>
			</div>
			<div class="traffic-item">
				<div class="stat-label">总计</div>
				<div class="traffic-value">{{ formatBytes(trafficTotals.total) }}</div>
			</div>
		</div>
	</el-card>

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
					<el-tag :type="NODE_STATUS_TAG[row.status as Node['status']]" disable-transitions>
						{{ NODE_STATUS_LABEL[row.status as Node['status']] }}
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

.traffic-card {
	margin-bottom: 16px;
}

.traffic-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 16px;
}

.traffic-value {
	margin-top: 8px;
	font-size: 22px;
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
