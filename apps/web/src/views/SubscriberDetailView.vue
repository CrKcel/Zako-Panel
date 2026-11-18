<script setup lang="ts">
import type { Node, SubscriberDetail, TrafficSummary } from '@zako/contracts';
import { computed, defineAsyncComponent, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { subscribersApi } from '../api/subscribers';
import { trafficApi } from '../api/traffic';
import NodeGrantDialog from '../components/NodeGrantDialog.vue';
import PageToolbar from '../components/PageToolbar.vue';
import TrafficTotalsCard from '../components/TrafficTotalsCard.vue';
import { useAsyncResource } from '../composables/useAsyncResource';
import { trafficLimitLabel, usageCycleLabel } from '../domain/subscriber';
import { subscriberStatusDescriptor } from '../domain/status';
import { DAY_SECONDS, trafficChartData, trafficWindow } from '../domain/traffic';
import { showError } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

const TrafficChart = defineAsyncComponent(() => import('../components/TrafficChart.vue'));

interface SubscriberTraffic {
	totals: TrafficSummary;
	byNode: TrafficSummary;
}

const route = useRoute();
const router = useRouter();
const subscriberId = computed(() => String(route.params.subscriberId ?? ''));

const {
	data: subscriber,
	loading,
	reload: reloadSubscriber,
} = useAsyncResource<SubscriberDetail | null>(() => subscribersApi.get(subscriberId.value), {
	initialValue: null,
	onError: (error) => showError(error, '订阅用户加载失败'),
});

const { data: nodes } = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, '节点加载失败'),
});

const {
	data: traffic,
	loading: trafficLoading,
	reload: reloadTraffic,
} = useAsyncResource<SubscriberTraffic | null>(
	async () => {
		const window = trafficWindow(DAY_SECONDS);
		const [totals, byNode] = await Promise.all([
			trafficApi.summary({ ...window, groupBy: 'subscriber', subscriberId: subscriberId.value }),
			trafficApi.summary({ ...window, groupBy: 'node', subscriberId: subscriberId.value }),
		]);
		return { totals, byNode };
	},
	{ initialValue: null, onError: (error) => showError(error, '流量加载失败') },
);

const grantVisible = ref(false);

const nodeNames = computed(() => new Map(nodes.value.map((node) => [node.id, node.name])));

const grantedNodes = computed(() =>
	(subscriber.value?.node_ids ?? []).map((nodeId) => ({ id: nodeId, name: nodeNames.value.get(nodeId) ?? nodeId })),
);

const limitLabel = computed(() => trafficLimitLabel(subscriber.value?.traffic_limit_bytes));

const cycleLabel = computed(() => (subscriber.value === null ? '—' : usageCycleLabel(subscriber.value)));

const chart = computed(() => trafficChartData(traffic.value?.byNode.items));

function openGrant(): void {
	if (subscriber.value === null) return;
	grantVisible.value = true;
}

function onGrantSaved(detail: SubscriberDetail): void {
	subscriber.value = detail;
}

function backToList(): void {
	void router.push({ name: 'subscribers' });
}

async function refresh(): Promise<void> {
	await Promise.all([reloadSubscriber(), reloadTraffic()]);
}
</script>

<template>
	<div v-loading="loading">
		<PageToolbar spread>
			<el-button @click="backToList">返回列表</el-button>
			<el-button :loading="loading" @click="refresh">刷新</el-button>
		</PageToolbar>

		<el-card shadow="never" class="section">
			<template #header>
				<span class="card-title">{{ subscriber?.name ?? '—' }}</span>
			</template>
			<el-descriptions :column="3" border>
				<el-descriptions-item label="状态">
					<el-tag v-if="subscriber" :type="subscriberStatusDescriptor(subscriber.status).tag" disable-transitions>
						{{ subscriberStatusDescriptor(subscriber.status).label }}
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

		<TrafficTotalsCard :summary="traffic?.totals ?? null" :loading="trafficLoading" title="近 24 小时流量">
			<TrafficChart v-if="chart.categories.length > 0" :categories="chart.categories" :series="chart.series" class="chart" />
		</TrafficTotalsCard>
	</div>

	<NodeGrantDialog
		v-model:visible="grantVisible"
		:subscriber="subscriber"
		:nodes="nodes"
		:node-ids="subscriber?.node_ids ?? []"
		@saved="onGrantSaved"
	/>
</template>

<style scoped>
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

.chart {
	margin-top: 16px;
}

.node-tags {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}
</style>
