<script setup lang="ts">
import type { Node, TrafficSummary } from '@zako/contracts';
import { computed, defineAsyncComponent } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { trafficApi } from '../api/traffic';
import AppIcon from '../components/AppIcon.vue';
import PageToolbar from '../components/PageToolbar.vue';
import PollingPill from '../components/PollingPill.vue';
import StatCard from '../components/StatCard.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useAsyncResource } from '../composables/useAsyncResource';
import { usePolling } from '../composables/usePolling';
import { nodeStatusDescriptor } from '../domain/status';
import { DAY_SECONDS, sumTrafficItems, trafficChartData, trafficItemTotal, trafficWindow } from '../domain/traffic';
import { useI18n } from '../i18n';
import { showError } from '../utils/feedback';
import { formatBytes, formatTimestamp } from '../utils/format';

const TrafficChart = defineAsyncComponent(() => import('../components/TrafficChart.vue'));

const { t } = useI18n();

interface OverviewTraffic {
	site: TrafficSummary;
	byNode: TrafficSummary;
}

const {
	data: nodes,
	loading: nodeLoading,
	refreshing: nodeRefreshing,
	updatedAt: nodeUpdatedAt,
	reload: reloadNodes,
} = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	immediate: false,
	initialValue: [],
	cacheKey: 'nodes:list',
	onError: (error) => showError(error, t('overview.loadNodesError')),
});

const {
	data: traffic,
	loading: trafficLoading,
	refreshing: trafficRefreshing,
	updatedAt: trafficUpdatedAt,
	reload: reloadTraffic,
} = useAsyncResource<OverviewTraffic | null>(
	async () => {
		const win = trafficWindow(DAY_SECONDS);
		const [site, byNode] = await Promise.all([
			trafficApi.summary({ ...win, groupBy: 'site' }),
			trafficApi.summary({ ...win, groupBy: 'node' }),
		]);
		return { site, byNode };
	},
	{
		immediate: false,
		initialValue: null,
		cacheKey: 'overview:traffic:24h',
		onError: (error) => showError(error, t('overview.loadTrafficError')),
	},
);

const onlineCount = computed(() => nodes.value.filter((node) => node.status === 'online').length);
const degradedCount = computed(() => nodes.value.filter((node) => node.status === 'degraded').length);
const offlineCount = computed(() => nodes.value.filter((node) => node.status === 'offline').length);
const pendingConfigCount = computed(() => nodes.value.filter((node) => node.desired_config_version > node.applied_config_version).length);

const onlineRate = computed(() => {
	if (nodes.value.length === 0) return null;
	return Math.round((onlineCount.value / nodes.value.length) * 100);
});

const trafficTotals = computed(() => sumTrafficItems(traffic.value?.site.items));

const topNodeChart = computed(() => {
	const sorted = [...(traffic.value?.byNode.items ?? [])].sort((a, b) => trafficItemTotal(b) - trafficItemTotal(a)).slice(0, 6);
	return trafficChartData(sorted);
});

const anomalies = computed(() =>
	nodes.value
		.filter(
			(node) => node.status === 'degraded' || node.status === 'offline' || node.status === 'disabled' || Boolean(node.last_config_error),
		)
		.slice()
		.sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0)),
);

const { refresh, lastUpdatedAt, paused, togglePause } = usePolling(
	async () => {
		await Promise.all([reloadNodes(), reloadTraffic()]);
	},
	30_000,
	{
		initialUpdatedAt: () =>
			nodeUpdatedAt.value !== null && trafficUpdatedAt.value !== null ? Math.min(nodeUpdatedAt.value, trafficUpdatedAt.value) : null,
	},
);
</script>

<template>
	<PageToolbar>
		<PollingPill :last-updated-at="lastUpdatedAt" :paused="paused" @toggle="togglePause" />
		<el-button :loading="nodeRefreshing || trafficRefreshing" @click="refresh">
			<AppIcon name="refresh" :size="14" class="btn-icon" />
			<span>{{ t('common.refresh') }}</span>
		</el-button>
	</PageToolbar>

	<div v-loading="nodeLoading" class="stats-grid ui-section">
		<StatCard :label="t('overview.totalNodes')" :value="nodes.length" icon="nodes" tone="primary" to="/nodes" />
		<StatCard
			:label="t('overview.onlineNodes')"
			:value="onlineCount"
			:hint="onlineRate !== null ? `${t('overview.onlineRate')} ${onlineRate}%` : undefined"
			:progress="onlineRate"
			icon="activity"
			tone="success"
			to="/nodes"
		/>
		<StatCard
			:label="t('overview.degradedNodes')"
			:value="degradedCount + offlineCount"
			:hint="`${t('status.node.degraded')} ${degradedCount} · ${t('status.node.offline')} ${offlineCount}`"
			icon="alert"
			:tone="degradedCount + offlineCount > 0 ? 'warning' : 'default'"
			to="/nodes"
		/>
		<StatCard
			:label="t('overview.trafficLast24h')"
			:value="formatBytes(trafficTotals.total)"
			:hint="`↑ ${formatBytes(trafficTotals.uplink)} · ↓ ${formatBytes(trafficTotals.downlink)}`"
			icon="traffic"
			tone="primary"
			to="/traffic"
		/>
	</div>

	<div class="bento-grid ui-section">
		<el-card v-loading="trafficLoading" shadow="never" class="bento-main">
			<template #header>
				<div class="ui-card-header">
					<span class="ui-card-title">{{ t('overview.topTraffic24h') }}</span>
					<RouterLink to="/traffic" class="ui-link header-link">{{ t('nav.traffic') }}</RouterLink>
				</div>
			</template>
			<TrafficChart
				v-if="topNodeChart.categories.length > 0"
				:categories="topNodeChart.categories"
				:series="topNodeChart.series"
				orientation="horizontal"
				height="250px"
			/>
			<el-empty v-else :description="t('common.noData')" :image-size="64" />
		</el-card>

		<el-card shadow="never" class="bento-side">
			<template #header>
				<div class="ui-card-header">
					<span class="ui-card-title">{{ t('overview.clusterHealth') }}</span>
					<span v-if="pendingConfigCount > 0" class="pending-chip tnum">
						{{ t('overview.pendingConfigs') }}: {{ pendingConfigCount }}
					</span>
				</div>
			</template>
			<div class="health-summary">
				<div class="health-bar" aria-hidden="true">
					<div v-if="nodes.length > 0" class="health-seg is-success" :style="{ width: `${(onlineCount / nodes.length) * 100}%` }" />
					<div v-if="nodes.length > 0" class="health-seg is-warning" :style="{ width: `${(degradedCount / nodes.length) * 100}%` }" />
					<div v-if="nodes.length > 0" class="health-seg is-danger" :style="{ width: `${(offlineCount / nodes.length) * 100}%` }" />
				</div>

				<div class="quick-list">
					<RouterLink to="/nodes" class="quick-link">
						<span class="quick-icon is-primary"><AppIcon name="terminal" :size="15" /></span>
						<span class="quick-copy">
							<span class="quick-title">{{ t('nodes.deployNode') }}</span>
							<span class="quick-desc">{{ t('overview.deployNodeDesc') }}</span>
						</span>
						<AppIcon name="chevron-right" :size="14" class="quick-arrow" />
					</RouterLink>
					<RouterLink to="/subscribers" class="quick-link">
						<span class="quick-icon is-success"><AppIcon name="subscribers" :size="15" /></span>
						<span class="quick-copy">
							<span class="quick-title">{{ t('subscribers.create') }}</span>
							<span class="quick-desc">{{ t('overview.createSubscriberDesc') }}</span>
						</span>
						<AppIcon name="chevron-right" :size="14" class="quick-arrow" />
					</RouterLink>
					<RouterLink to="/traffic" class="quick-link">
						<span class="quick-icon is-neutral"><AppIcon name="traffic" :size="15" /></span>
						<span class="quick-copy">
							<span class="quick-title">{{ t('nav.traffic') }}</span>
							<span class="quick-desc">{{ t('overview.viewTrafficDesc') }}</span>
						</span>
						<AppIcon name="chevron-right" :size="14" class="quick-arrow" />
					</RouterLink>
				</div>
			</div>
		</el-card>
	</div>

	<el-card shadow="never">
		<template #header>
			<div class="ui-card-header">
				<span class="ui-card-title">{{ t('overview.recentIssues') }}</span>
				<RouterLink to="/nodes" class="ui-link header-link">{{ t('overview.viewAllNodes') }}</RouterLink>
			</div>
		</template>
		<el-table v-loading="nodeLoading" :data="anomalies" :empty-text="t('overview.allNodesHealthy')">
			<el-table-column :label="t('overview.node')" min-width="180">
				<template #default="{ row }">
					<RouterLink :to="`/nodes/${row.id}`" class="ui-link">{{ row.name }}</RouterLink>
				</template>
			</el-table-column>
			<el-table-column :label="t('common.status')" width="130">
				<template #default="{ row }">
					<StatusBadge
						:label="nodeStatusDescriptor(row.status as Node['status']).label"
						:type="nodeStatusDescriptor(row.status as Node['status']).tag"
					/>
				</template>
			</el-table-column>
			<el-table-column :label="t('overview.lastHeartbeat')" width="180">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.last_seen_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('overview.error')" min-width="260">
				<template #default="{ row }">
					<span :class="{ 'error-text': Boolean(row.last_config_error) }">{{ row.last_config_error ?? '—' }}</span>
				</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>

<style scoped>
.btn-icon {
	margin-right: 5px;
}

.stats-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
	gap: 14px;
}

.bento-grid {
	display: grid;
	grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
	gap: 16px;
}

.header-link {
	font-size: 12.5px;
}

.pending-chip {
	padding: 2px 8px;
	border-radius: var(--radius-pill);
	background: var(--tone-warning-soft);
	color: var(--tone-warning-text);
	border: 1px solid var(--tone-warning-border);
	font-size: 11.5px;
	font-weight: 500;
}

.health-summary {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.health-bar {
	width: 100%;
	height: 8px;
	border-radius: var(--radius-pill);
	background: var(--bg-subtle);
	overflow: hidden;
	display: flex;
}

.health-seg {
	height: 100%;
	transition: width var(--duration-normal) var(--ease-standard);
}

.health-seg.is-success {
	background: var(--tone-success);
}

.health-seg.is-warning {
	background: var(--tone-warning);
}

.health-seg.is-danger {
	background: var(--tone-danger);
}

.quick-list {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.quick-link {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 10px 12px;
	border-radius: var(--radius-md);
	border: 1px solid var(--border-subtle);
	background: var(--bg-muted);
	text-decoration: none;
	transition:
		border-color var(--duration-fast) var(--ease-standard),
		background-color var(--duration-fast) var(--ease-standard);
}

.quick-link:hover {
	border-color: var(--border-hover);
	background: var(--bg-subtle);
}

.quick-icon {
	width: 32px;
	height: 32px;
	flex: none;
	border-radius: 8px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
}

.quick-icon.is-primary {
	background: var(--accent-primary-soft);
	color: var(--accent-primary);
}

.quick-icon.is-success {
	background: var(--tone-success-soft);
	color: var(--tone-success);
}

.quick-icon.is-neutral {
	background: var(--bg-surface);
	border: 1px solid var(--border-color);
	color: var(--text-secondary);
}

.quick-copy {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.quick-title {
	font-size: 13px;
	font-weight: 600;
	color: var(--text-primary);
}

.quick-desc {
	font-size: 11.5px;
	color: var(--text-muted);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.quick-arrow {
	color: var(--text-placeholder);
}

.error-text {
	color: var(--tone-danger-text);
	font-size: 13px;
}

@media (max-width: 960px) {
	.bento-grid {
		grid-template-columns: 1fr;
	}
}
</style>
