<script setup lang="ts">
import type { Node, SubscriberDetail, TrafficSummary } from '@zako/contracts';
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { subscribersApi } from '../api/subscribers';
import { trafficApi } from '../api/traffic';
import { showError, showSuccess } from '../utils/feedback';
import { formatBytes, formatTimestamp, SUBSCRIBER_STATUS_LABEL, SUBSCRIBER_STATUS_TAG } from '../utils/format';

const TrafficChart = defineAsyncComponent(() => import('../components/TrafficChart.vue'));

const route = useRoute();
const router = useRouter();
const subscriberId = computed(() => String(route.params.subscriberId ?? ''));

const subscriber = ref<SubscriberDetail | null>(null);
const nodes = ref<Node[]>([]);
const traffic = ref<TrafficSummary | null>(null);
const trafficByNode = ref<TrafficSummary | null>(null);
const loading = ref(true);
const trafficLoading = ref(true);
const grantSaving = ref(false);
const grantDialogVisible = ref(false);
const grantedNodeIds = ref<string[]>([]);

const nodeNames = computed(() => new Map(nodes.value.map((node) => [node.id, node.name])));

const grantedNodes = computed(() =>
	(subscriber.value?.node_ids ?? []).map((nodeId) => ({ id: nodeId, name: nodeNames.value.get(nodeId) ?? nodeId })),
);

const limitLabel = computed(() => {
	const limit = subscriber.value?.traffic_limit_bytes;
	if (limit === null || limit === undefined) return '不限量';
	return formatBytes(limit);
});

const cycleLabel = computed(() =>
	subscriber.value === null
		? '—'
		: `${formatTimestamp(subscriber.value.usage_cycle_start)} ~ ${formatTimestamp(subscriber.value.usage_cycle_end)}`,
);

const trafficTotals = computed(() => {
	const items = traffic.value?.items ?? [];
	const uplink = items.reduce((total, item) => total + item.uplink_bytes, 0);
	const downlink = items.reduce((total, item) => total + item.downlink_bytes, 0);
	return { uplink, downlink, total: uplink + downlink };
});

const chartItems = computed(() => trafficByNode.value?.items ?? []);
const chartCategories = computed(() => chartItems.value.map((item) => item.label ?? item.key));
const chartSeries = computed(() => [
	{ name: '上行', values: chartItems.value.map((item) => item.uplink_bytes) },
	{ name: '下行', values: chartItems.value.map((item) => item.downlink_bytes) },
]);

async function loadSubscriber(): Promise<void> {
	loading.value = true;
	try {
		subscriber.value = await subscribersApi.get(subscriberId.value);
	} catch (error) {
		showError(error, '订阅用户加载失败');
	} finally {
		loading.value = false;
	}
}

async function loadNodes(): Promise<void> {
	try {
		const page = await nodesApi.list({ limit: 200 });
		nodes.value = page.items;
	} catch (error) {
		showError(error, '节点加载失败');
	}
}

async function loadTraffic(): Promise<void> {
	trafficLoading.value = true;
	try {
		const to = Math.floor(Date.now() / 1000);
		const from = to - 24 * 60 * 60;
		const [totals, byNode] = await Promise.all([
			trafficApi.summary({ from, to, groupBy: 'subscriber', subscriberId: subscriberId.value }),
			trafficApi.summary({ from, to, groupBy: 'node', subscriberId: subscriberId.value }),
		]);
		traffic.value = totals;
		trafficByNode.value = byNode;
	} catch (error) {
		showError(error, '流量加载失败');
	} finally {
		trafficLoading.value = false;
	}
}

async function refresh(): Promise<void> {
	await Promise.all([loadSubscriber(), loadTraffic()]);
}

function backToList(): void {
	void router.push({ name: 'subscribers' });
}

function openGrant(): void {
	if (subscriber.value === null) return;
	grantedNodeIds.value = [...subscriber.value.node_ids];
	grantDialogVisible.value = true;
}

async function submitGrant(): Promise<void> {
	if (subscriber.value === null) return;
	grantSaving.value = true;
	try {
		subscriber.value = await subscribersApi.replaceNodes(subscriber.value.id, grantedNodeIds.value);
		grantDialogVisible.value = false;
		showSuccess('节点授权已更新');
	} catch (error) {
		showError(error, '节点授权保存失败');
	} finally {
		grantSaving.value = false;
	}
}

onMounted(async () => {
	await Promise.all([loadSubscriber(), loadNodes(), loadTraffic()]);
});
</script>

<template>
	<div v-loading="loading">
		<div class="toolbar">
			<el-button @click="backToList">返回列表</el-button>
			<el-button :loading="loading" @click="refresh">刷新</el-button>
		</div>

		<el-card shadow="never" class="section">
			<template #header>
				<span class="card-title">{{ subscriber?.name ?? '—' }}</span>
			</template>
			<el-descriptions :column="3" border>
				<el-descriptions-item label="状态">
					<el-tag v-if="subscriber" :type="SUBSCRIBER_STATUS_TAG[subscriber.status]" disable-transitions>
						{{ SUBSCRIBER_STATUS_LABEL[subscriber.status] }}
					</el-tag>
					<span v-else>—</span>
				</el-descriptions-item>
				<el-descriptions-item label="邮箱">{{ subscriber?.email ?? '—' }}</el-descriptions-item>
				<el-descriptions-item label="额度">{{ limitLabel }}</el-descriptions-item>
				<el-descriptions-item label="周期">{{ cycleLabel }}</el-descriptions-item>
				<el-descriptions-item label="到期">{{ formatTimestamp(subscriber?.expires_at) }}</el-descriptions-item>
				<el-descriptions-item label="创建时间">{{ formatTimestamp(subscriber?.created_at) }}</el-descriptions-item>
			</el-descriptions>
		</el-card>

		<el-card shadow="never" class="section">
			<template #header>
				<div class="card-header">
					<span class="card-title">授权节点</span>
					<el-button type="primary" @click="openGrant">编辑</el-button>
				</div>
			</template>
			<div v-if="grantedNodes.length > 0" class="node-tags">
				<el-tag v-for="node in grantedNodes" :key="node.id" disable-transitions>{{ node.name }}</el-tag>
			</div>
			<span v-else>—</span>
		</el-card>

		<el-card v-loading="trafficLoading" shadow="never" class="section">
			<template #header>
				<span class="card-title">近 24 小时流量</span>
			</template>
			<div class="metric-grid">
				<div class="metric">
					<div class="metric-label">上行</div>
					<div class="metric-value">{{ formatBytes(trafficTotals.uplink) }}</div>
				</div>
				<div class="metric">
					<div class="metric-label">下行</div>
					<div class="metric-value">{{ formatBytes(trafficTotals.downlink) }}</div>
				</div>
				<div class="metric">
					<div class="metric-label">总计</div>
					<div class="metric-value">{{ formatBytes(trafficTotals.total) }}</div>
				</div>
			</div>
			<TrafficChart v-if="chartCategories.length > 0" :categories="chartCategories" :series="chartSeries" />
		</el-card>
	</div>

	<el-dialog v-model="grantDialogVisible" title="节点授权" width="520px" :close-on-click-modal="false" destroy-on-close>
		<el-select v-model="grantedNodeIds" multiple filterable class="full-width">
			<el-option v-for="node in nodes" :key="node.id" :label="node.name" :value="node.id" />
		</el-select>
		<template #footer>
			<el-button @click="grantDialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="grantSaving" @click="submitGrant">保存</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.toolbar {
	display: flex;
	justify-content: space-between;
	margin-bottom: 16px;
}

.section {
	margin-bottom: 16px;
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

.node-tags {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.metric-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 16px;
	margin-bottom: 16px;
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

.full-width {
	width: 100%;
}
</style>
