<script setup lang="ts">
import type { Node, Subscriber, SubscriberDetail, TrafficSummary } from '@zako/contracts';
import { computed, defineAsyncComponent, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { subscribersApi } from '../api/subscribers';
import { trafficApi } from '../api/traffic';
import AppIcon from '../components/AppIcon.vue';
import EntityHeader from '../components/EntityHeader.vue';
import NodeGrantDialog from '../components/NodeGrantDialog.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TrafficTotalsCard from '../components/TrafficTotalsCard.vue';
import { getCachedResource, invalidateCachedPrefix, invalidateCachedResource, setCachedResource } from '../composables/resourceCache';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useEntityBreadcrumb } from '../composables/useBreadcrumb';
import { nodeStatusDescriptor, subscriberStatusDescriptor } from '../domain/status';
import { subscriberUsedBytes, trafficLimitLabel, usageCycleLabel, usageLabel } from '../domain/subscriber';
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
	refreshing: subscriberRefreshing,
	reload: reloadSubscriber,
} = useAsyncResource<SubscriberDetail | null>(() => subscribersApi.get(subscriberId.value), {
	initialValue: null,
	cacheKey: () => (subscriberId.value ? `subscribers:detail:${subscriberId.value}` : null),
	onError: (error) => showError(error, t('subscribers.loadError')),
});

const { data: nodes } = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	initialValue: [],
	cacheKey: 'nodes:list',
	onError: (error) => showError(error, t('subscribers.loadNodesError')),
});

const {
	data: traffic,
	loading: trafficLoading,
	refreshing: trafficRefreshing,
	reload: reloadTraffic,
} = useAsyncResource<SubscriberTraffic | null>(
	async () => {
		const win = trafficWindow(DAY_SECONDS);
		const [totals, byNode] = await Promise.all([
			trafficApi.summary({ ...win, groupBy: 'subscriber', subscriberId: subscriberId.value }),
			trafficApi.summary({ ...win, groupBy: 'node', subscriberId: subscriberId.value }),
		]);
		return { totals, byNode };
	},
	{
		initialValue: null,
		cacheKey: () => (subscriberId.value ? `subscribers:traffic:24h:${subscriberId.value}` : null),
		onError: (error) => showError(error, t('traffic.loadError')),
	},
);

const refreshing = computed(() => subscriberRefreshing.value || trafficRefreshing.value);

const grantVisible = ref(false);

useEntityBreadcrumb(() => subscriber.value?.name);

const nodeMap = computed(() => new Map(nodes.value.map((node) => [node.id, node])));

const grantedNodes = computed(() =>
	(subscriber.value?.node_ids ?? []).map((nodeId) => {
		const node = nodeMap.value.get(nodeId);
		return {
			id: nodeId,
			name: node?.name ?? nodeId,
			tag: node ? nodeStatusDescriptor(node.status).tag : 'info',
		};
	}),
);

const limitLabel = computed(() => trafficLimitLabel(subscriber.value?.traffic_limit_bytes));
const cycleLabel = computed(() => (subscriber.value === null ? '—' : usageCycleLabel(subscriber.value)));
const quotaRatio = computed(() => {
	const sub = subscriber.value;
	if (!sub || !sub.traffic_limit_bytes || sub.traffic_limit_bytes <= 0) return null;
	return Math.min(100, Math.round((subscriberUsedBytes(sub) / sub.traffic_limit_bytes) * 100));
});

const chart = computed(() => trafficChartData(traffic.value?.byNode.items));

function openGrant(): void {
	if (subscriber.value === null) return;
	grantVisible.value = true;
}

function onGrantSaved(detail: SubscriberDetail): void {
	subscriber.value = detail;
	const cachedList = getCachedResource<Subscriber[]>('subscribers:list');
	if (cachedList) {
		setCachedResource(
			'subscribers:list',
			cachedList.data.map((item) => (item.id === detail.id ? { ...item, node_count: detail.node_ids.length } : item)),
			cachedList.updatedAt,
		);
	}
	invalidateCachedResource('subscribers:list');
	invalidateCachedPrefix('nodes:clients:');
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
		<EntityHeader
			:title="subscriber?.name ?? '—'"
			:back-label="t('subscriberDetail.backToList')"
			:subtitle="subscriber?.email ?? undefined"
			@back="backToList"
		>
			<template #badge>
				<StatusBadge
					v-if="subscriber"
					:label="subscriberStatusDescriptor(subscriber.status).label"
					:type="subscriberStatusDescriptor(subscriber.status).tag"
					:pulse="subscriber.status === 'active'"
				/>
			</template>
			<template #actions>
				<el-button type="primary" plain @click="openGrant">{{ t('subscribers.actions.nodeGrant') }}</el-button>
				<el-button :loading="refreshing" @click="refresh">
					<AppIcon name="refresh" :size="14" class="btn-icon" />
					<span>{{ t('common.refresh') }}</span>
				</el-button>
			</template>
			<template #meta>
				<div class="meta-cell">
					<span class="meta-label">{{ t('subscribers.columns.usedQuota') }}</span>
					<span class="meta-value tnum">{{ subscriber ? usageLabel(subscriber) : limitLabel }}</span>
					<div v-if="quotaRatio !== null" class="quota-bar">
						<div
							class="quota-bar-fill"
							:class="quotaRatio >= 95 ? 'is-danger' : quotaRatio >= 80 ? 'is-warning' : 'is-primary'"
							:style="{ width: `${quotaRatio}%` }"
						/>
					</div>
				</div>
				<div class="meta-cell">
					<span class="meta-label">{{ t('subscriberDetail.cycle') }}</span>
					<span class="meta-value tnum">{{ cycleLabel }}</span>
				</div>
				<div class="meta-cell">
					<span class="meta-label">{{ t('subscriberDetail.expiresAt') }}</span>
					<span class="meta-value tnum">{{ formatTimestamp(subscriber?.expires_at) }}</span>
				</div>
				<div class="meta-cell">
					<span class="meta-label">{{ t('subscriberDetail.createdAt') }}</span>
					<span class="meta-value tnum">{{ formatTimestamp(subscriber?.created_at) }}</span>
				</div>
			</template>
		</EntityHeader>

		<el-card shadow="never" class="ui-section">
			<template #header>
				<div class="ui-card-header">
					<span class="ui-card-title">{{ t('subscriberDetail.grantedNodes') }} ({{ grantedNodes.length }})</span>
					<el-button type="primary" @click="openGrant">{{ t('common.edit') }}</el-button>
				</div>
			</template>
			<div v-if="grantedNodes.length > 0" class="node-tags">
				<RouterLink v-for="node in grantedNodes" :key="node.id" :to="`/nodes/${node.id}`" class="node-pill">
					<span class="node-dot" :class="`is-${node.tag}`" aria-hidden="true" />
					<span>{{ node.name }}</span>
				</RouterLink>
			</div>
			<span v-else class="empty-muted">{{ t('subscriberDetail.noGrantedNodes') }}</span>
		</el-card>

		<TrafficTotalsCard :summary="traffic?.totals ?? null" :loading="trafficLoading" :title="t('subscriberDetail.trafficLast24h')">
			<TrafficChart
				v-if="chart.categories.length > 0"
				:categories="chart.categories"
				:series="chart.series"
				orientation="horizontal"
				:height="`${Math.max(240, chart.categories.length * 38 + 60)}px`"
				class="chart"
			/>
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
.btn-icon {
	margin-right: 5px;
}

.meta-cell {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.meta-label {
	font-size: 11.5px;
	font-weight: 500;
	color: var(--text-muted);
}

.meta-value {
	font-size: 13px;
	font-weight: 500;
	color: var(--text-primary);
}

.quota-bar {
	width: 100%;
	max-width: 180px;
	height: 4px;
	border-radius: var(--radius-pill);
	background: var(--bg-subtle);
	overflow: hidden;
	margin-top: 2px;
}

.quota-bar-fill {
	height: 100%;
	border-radius: var(--radius-pill);
}

.quota-bar-fill.is-primary {
	background: var(--accent-primary);
}

.quota-bar-fill.is-warning {
	background: var(--tone-warning);
}

.quota-bar-fill.is-danger {
	background: var(--tone-danger);
}

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
	gap: 7px;
	padding: 5px 12px;
	border-radius: var(--radius-pill);
	border: 1px solid var(--border-color);
	background: var(--bg-muted);
	color: var(--text-primary);
	font-size: 13px;
	font-weight: 500;
	text-decoration: none;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		border-color var(--duration-fast) var(--ease-standard),
		color var(--duration-fast) var(--ease-standard);
}

.node-pill:hover {
	background: var(--accent-primary-soft);
	border-color: var(--accent-primary-border);
	color: var(--accent-primary);
}

.node-dot {
	width: 6px;
	height: 6px;
	border-radius: 9999px;
	background: var(--tone-info);
}

.node-dot.is-success {
	background: var(--tone-success);
}

.node-dot.is-warning {
	background: var(--tone-warning);
}

.node-dot.is-danger {
	background: var(--tone-danger);
}

.empty-muted {
	font-size: 13px;
	color: var(--text-muted);
}
</style>
