<script setup lang="ts">
import type { Node, SubscriberDetail, TrafficSummary } from '@zako/contracts';
import { computed, defineAsyncComponent, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { subscribersApi } from '../api/subscribers';
import { trafficApi } from '../api/traffic';
import NodeGrantDialog from '../components/NodeGrantDialog.vue';
import PageToolbar from '../components/PageToolbar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TrafficTotalsCard from '../components/TrafficTotalsCard.vue';
import { useAsyncResource } from '../composables/useAsyncResource';
import { trafficLimitLabel, usageCycleLabel } from '../domain/subscriber';
import { subscriberStatusDescriptor } from '../domain/status';
import { DAY_SECONDS, trafficChartData, trafficWindow } from '../domain/traffic';
import { useI18n } from '../i18n';
import { showError } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

const TrafficChart = defineAsyncComponent(() => import('../components/TrafficChart.vue'));

const { t } = useI18n();

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
	onError: (error) => showError(error, t('subscribers.loadError')),
});

const { data: nodes } = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, t('subscribers.loadNodesError')),
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
	{ initialValue: null, onError: (error) => showError(error, t('traffic.loadError')) },
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
			<template #left>
				<el-button @click="backToList">{{ t('subscriberDetail.backToList') }}</el-button>
			</template>
			<el-button :loading="loading" @click="refresh">{{ t('common.refresh') }}</el-button>
		</PageToolbar>

		<el-card shadow="never" class="ui-section">
			<template #header>
				<div class="ui-card-header">
					<span class="ui-card-title">{{ subscriber?.name ?? '—' }}</span>
					<StatusBadge
						v-if="subscriber"
						:label="subscriberStatusDescriptor(subscriber.status).label"
						:type="subscriberStatusDescriptor(subscriber.status).tag"
					/>
				</div>
			</template>
			<el-descriptions :column="3" border>
				<el-descriptions-item :label="t('common.status')">
					<StatusBadge
						v-if="subscriber"
						:label="subscriberStatusDescriptor(subscriber.status).label"
						:type="subscriberStatusDescriptor(subscriber.status).tag"
					/>
					<span v-else>—</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('subscriberDetail.email')">{{ subscriber?.email ?? '—' }}</el-descriptions-item>
				<el-descriptions-item :label="t('subscriberDetail.quota')">
					<span class="tnum">{{ limitLabel }}</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('subscriberDetail.cycle')">
					<span class="tnum">{{ cycleLabel }}</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('subscriberDetail.expiresAt')">
					<span class="tnum">{{ formatTimestamp(subscriber?.expires_at) }}</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('subscriberDetail.createdAt')">
					<span class="tnum">{{ formatTimestamp(subscriber?.created_at) }}</span>
				</el-descriptions-item>
			</el-descriptions>
		</el-card>

		<el-card shadow="never" class="ui-section">
			<template #header>
				<div class="ui-card-header">
					<span class="ui-card-title">{{ t('subscriberDetail.grantedNodes') }}</span>
					<el-button type="primary" @click="openGrant">{{ t('common.edit') }}</el-button>
				</div>
			</template>
			<div v-if="grantedNodes.length > 0" class="node-tags">
				<RouterLink v-for="node in grantedNodes" :key="node.id" :to="`/nodes/${node.id}`" class="node-pill">
					{{ node.name }}
				</RouterLink>
			</div>
			<span v-else class="empty-muted">{{ t('subscriberDetail.noGrantedNodes') }}</span>
		</el-card>

		<TrafficTotalsCard :summary="traffic?.totals ?? null" :loading="trafficLoading" :title="t('subscriberDetail.trafficLast24h')">
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
.chart {
	margin-top: 16px;
}

.node-tags {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.node-pill {
	display: inline-flex;
	align-items: center;
	padding: 4px 11px;
	border-radius: 9999px;
	border: 1px solid var(--border-color);
	background: var(--bg-muted);
	color: var(--text-primary);
	font-size: 13px;
	font-weight: 500;
	text-decoration: none;
	transition:
		background-color 0.15s ease,
		border-color 0.15s ease,
		color 0.15s ease;
}

.node-pill:hover {
	background: var(--accent-primary-soft);
	border-color: var(--accent-primary-border);
	color: var(--accent-primary);
}

.empty-muted {
	font-size: 13px;
	color: var(--text-muted);
}
</style>
