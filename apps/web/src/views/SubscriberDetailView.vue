<script setup lang="ts">
import type { Profile, Subscriber, Subscription, TrafficSummary } from '@zako/contracts';
import { computed, defineAsyncComponent } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { profilesApi } from '../api/profiles';
import { recycleBinApi } from '../api/recycle-bin';
import { subscribersApi } from '../api/subscribers';
import { subscriptionsApi } from '../api/subscriptions';
import { trafficApi } from '../api/traffic';
import AppIcon from '../components/AppIcon.vue';
import EntityHeader from '../components/EntityHeader.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SubscriberSubscriptionsTable from '../components/SubscriberSubscriptionsTable.vue';
import SubscriptionFormDialog from '../components/SubscriptionFormDialog.vue';
import SubscriptionTokenDialog from '../components/SubscriptionTokenDialog.vue';
import TrafficTotalsCard from '../components/TrafficTotalsCard.vue';
import { invalidateCachedPrefix, invalidateCachedResource } from '../composables/resourceCache';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useEntityBreadcrumb } from '../composables/useBreadcrumb';
import { useSubscriptionActions } from '../composables/useSubscriptionActions';
import { subscriberStatusDescriptor } from '../domain/status';
import { subscriberUsedBytes, trafficLimitLabel, usageCycleLabel, usageLabel } from '../domain/subscriber';
import { DAY_SECONDS, trafficChartData, trafficWindow } from '../domain/traffic';
import { useI18n } from '../i18n';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
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
} = useAsyncResource<Subscriber | null>(() => subscribersApi.get(subscriberId.value), {
	initialValue: null,
	cacheKey: () => (subscriberId.value ? `subscribers:detail:${subscriberId.value}` : null),
	onError: (error) => showError(error, t('subscribers.loadError')),
});

const {
	data: subscriptions,
	loading: subscriptionsLoading,
	refreshing: subscriptionsRefreshing,
	reload: reloadSubscriptions,
} = useAsyncResource<Subscription[]>(() => subscriptionsApi.list().then((page) => page.items), {
	initialValue: [],
	cacheKey: 'subscriptions:list',
	onError: (error) => showError(error, t('subscriptions.loadError')),
});

const { data: profiles } = useAsyncResource<Profile[]>(() => profilesApi.list().then((page) => page.items), {
	initialValue: [],
	cacheKey: 'profiles:list',
	onError: (error) => showError(error, t('subscriptions.loadProfilesError')),
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

const refreshing = computed(() => subscriberRefreshing.value || subscriptionsRefreshing.value || trafficRefreshing.value);

useEntityBreadcrumb(() => subscriber.value?.name);

const subscriberSubscriptions = computed(() => subscriptions.value.filter((item) => item.subscriber_id === subscriberId.value));

const subActions = useSubscriptionActions({
	onChanged: async () => {
		await reloadSubscriptions();
	},
});

const limitLabel = computed(() => trafficLimitLabel(subscriber.value?.traffic_limit_bytes));
const cycleLabel = computed(() => (subscriber.value === null ? '—' : usageCycleLabel(subscriber.value)));
const quotaRatio = computed(() => {
	const sub = subscriber.value;
	if (!sub || !sub.traffic_limit_bytes || sub.traffic_limit_bytes <= 0) return null;
	return Math.min(100, Math.round((subscriberUsedBytes(sub) / sub.traffic_limit_bytes) * 100));
});

const chart = computed(() => trafficChartData(traffic.value?.byNode.items));

function openCreateSubscription(): void {
	if (subscriber.value === null) return;
	subActions.openCreateFor({ id: subscriber.value.id, name: subscriber.value.name });
}

function backToList(): void {
	void router.push({ name: 'subscribers' });
}

async function refresh(): Promise<void> {
	await Promise.all([reloadSubscriber(), reloadSubscriptions(), reloadTraffic()]);
}

const disableAction = useAsyncAction(
	async (sub: Subscriber) => {
		await subscribersApi.update(sub.id, { status: 'disabled' });
		showSuccess(t('subscribers.disable.success'));
		invalidateCachedResource('subscribers:list');
		invalidateCachedResource(`subscribers:detail:${sub.id}`);
		invalidateCachedPrefix('recycle-bin:');
		invalidateCachedPrefix('nodes:clients:');
		await reloadSubscriber();
	},
	{ onError: (error) => showError(error, t('subscribers.disable.failed')) },
);

const restoreAction = useAsyncAction(
	async (sub: Subscriber) => {
		await recycleBinApi.restore('subscriber', sub.id);
		showSuccess(t('subscribers.restore.success'));
		invalidateCachedResource('subscribers:list');
		invalidateCachedResource(`subscribers:detail:${sub.id}`);
		invalidateCachedPrefix('recycle-bin:');
		invalidateCachedPrefix('nodes:clients:');
		await reloadSubscriber();
	},
	{ onError: (error) => showError(error, t('subscribers.restore.failed')) },
);

async function disableSubscriber(): Promise<void> {
	if (!subscriber.value) return;
	if (!(await confirmAction(t('subscribers.disable.confirm', { name: subscriber.value.name, days: 30 })))) return;
	await disableAction.run(subscriber.value);
}

async function restoreSubscriber(): Promise<void> {
	if (!subscriber.value) return;
	if (!(await confirmAction(t('subscribers.restore.confirm', { name: subscriber.value.name })))) return;
	await restoreAction.run(subscriber.value);
}
</script>

<template>
	<div v-loading="loading">
		<el-alert
			v-if="subscriber?.status === 'disabled'"
			type="warning"
			:closable="false"
			show-icon
			class="ui-section"
			:title="t('subscriberDetail.disabledBanner')"
		/>
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
				<el-button
					v-if="subscriber?.status === 'disabled'"
					type="primary"
					:loading="restoreAction.running.value"
					@click="restoreSubscriber"
				>
					{{ t('subscribers.actions.restore') }}
				</el-button>
				<el-button v-else-if="subscriber" type="danger" plain :loading="disableAction.running.value" @click="disableSubscriber">
					{{ t('subscribers.actions.disable') }}
				</el-button>
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
					<span class="ui-card-title">{{ t('nav.subscriptions') }} ({{ subscriberSubscriptions.length }})</span>
					<el-button type="primary" :disabled="!subscriber || subscriber.status === 'disabled'" @click="openCreateSubscription">
						<AppIcon name="plus" :size="14" class="btn-icon" />
						<span>{{ t('subscriptions.create') }}</span>
					</el-button>
				</div>
			</template>
			<SubscriberSubscriptionsTable
				:subscriptions="subscriberSubscriptions"
				:profiles="profiles"
				:loading="subscriptionsLoading"
				:is-revoking="subActions.isRevoking"
				@links="subActions.openLinks"
				@edit="subActions.openEdit"
				@revoke="subActions.revoke"
			/>
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

	<SubscriptionFormDialog
		v-model:visible="subActions.formVisible.value"
		:subscriber="subActions.formSubscriber.value"
		:subscription="subActions.editingSubscription.value"
		:profiles="profiles"
		@created="subActions.onCreated"
		@updated="subActions.onUpdated"
	/>

	<SubscriptionTokenDialog
		v-model:visible="subActions.tokenVisible.value"
		:token="subActions.token.value"
		:subscription-name="subActions.tokenName.value"
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
</style>
