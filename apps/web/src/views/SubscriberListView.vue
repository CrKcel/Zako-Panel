<script setup lang="ts">
import type {
	CreateSubscriberRequest,
	Profile,
	RecycleBinList,
	Subscriber,
	SubscriberStatus,
	Subscription,
	UpdateSubscriberRequest,
} from '@zako/contracts';
import type { FormInstance, FormRules, TableInstance } from 'element-plus';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { profilesApi } from '../api/profiles';
import { recycleBinApi } from '../api/recycle-bin';
import { subscribersApi } from '../api/subscribers';
import { subscriptionsApi } from '../api/subscriptions';
import AppIcon from '../components/AppIcon.vue';
import PageToolbar from '../components/PageToolbar.vue';
import RecycleBinTab from '../components/RecycleBinTab.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SubscriberCard from '../components/SubscriberCard.vue';
import SubscriberSubscriptionsTable from '../components/SubscriberSubscriptionsTable.vue';
import SubscriptionFormDialog from '../components/SubscriptionFormDialog.vue';
import SubscriptionTokenDialog from '../components/SubscriptionTokenDialog.vue';
import ViewSwitch, { type ListViewMode } from '../components/ViewSwitch.vue';
import { invalidateCachedPrefix, invalidateCachedResource } from '../composables/resourceCache';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import { useSubscriptionActions } from '../composables/useSubscriptionActions';
import { subscriberStatusDescriptor } from '../domain/status';
import {
	LIMIT_UNITS,
	limitBytes,
	limitParts,
	subscriberUsageRatio,
	subscriberUsedBytes,
	usageCycleLabel,
	usageLabel,
	usageTone,
	type LimitUnit,
} from '../domain/subscriber';
import { useI18n } from '../i18n';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';
import { fromUnixSeconds, toUnixSeconds } from '../utils/time';

const { t } = useI18n();

interface SubscriberForm {
	name: string;
	email: string;
	limit_value: number | undefined;
	limit_unit: LimitUnit;
	expires_at: Date | null;
	suspended: boolean;
}

function emptySubscriberForm(): SubscriberForm {
	return { name: '', email: '', limit_value: undefined, limit_unit: 'GB', expires_at: null, suspended: false };
}

type SortKey = 'status' | 'name' | 'usage' | 'expires';

const activeTab = ref<'list' | 'recycle-bin'>('list');
const binCategory = ref<'subscriber' | 'subscription'>('subscriber');
const search = ref('');
const statusFilter = ref<'all' | SubscriberStatus>('all');
const sortBy = ref<SortKey>('status');
const viewMode = ref<ListViewMode>('card');

const tableRef = ref<TableInstance>();
const form = ref<SubscriberForm>(emptySubscriberForm());
const formRef = ref<FormInstance>();

const {
	data: subscribers,
	loading,
	refreshing: subscribersRefreshing,
	reload,
} = useAsyncResource<Subscriber[]>(() => subscribersApi.list().then((page) => page.items), {
	initialValue: [],
	cacheKey: 'subscribers:list',
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

const EMPTY_BIN: RecycleBinList = {
	items: [],
	retention_days: 30,
	counts: { subscriber: 0, subscription: 0, profile: 0, total: 0 },
};

const {
	data: subscriberBin,
	loading: subscriberBinLoading,
	refreshing: subscriberBinRefreshing,
	reload: reloadSubscriberBin,
} = useAsyncResource<RecycleBinList>(() => recycleBinApi.list('subscriber'), {
	initialValue: EMPTY_BIN,
	cacheKey: 'recycle-bin:subscriber',
	onError: (error) => showError(error, t('recycleBin.loadError')),
});

const {
	data: subscriptionBin,
	loading: subscriptionBinLoading,
	refreshing: subscriptionBinRefreshing,
	reload: reloadSubscriptionBin,
} = useAsyncResource<RecycleBinList>(() => recycleBinApi.list('subscription'), {
	initialValue: EMPTY_BIN,
	cacheKey: 'recycle-bin:subscription',
	onError: (error) => showError(error, t('recycleBin.loadError')),
});

const refreshing = computed(() => subscribersRefreshing.value || subscriptionsRefreshing.value);
const totalBinCount = computed(() => subscriberBin.value.items.length + subscriptionBin.value.items.length);
const activeBin = computed(() => (binCategory.value === 'subscriber' ? subscriberBin.value : subscriptionBin.value));
const activeBinLoading = computed(() => (binCategory.value === 'subscriber' ? subscriberBinLoading.value : subscriptionBinLoading.value));
const activeBinRefreshing = computed(() =>
	binCategory.value === 'subscriber' ? subscriberBinRefreshing.value : subscriptionBinRefreshing.value,
);

const subscriptionsBySubscriber = computed(() => {
	const map = new Map<string, Subscription[]>();
	for (const sub of subscriptions.value) {
		const list = map.get(sub.subscriber_id);
		if (list) list.push(sub);
		else map.set(sub.subscriber_id, [sub]);
	}
	return map;
});

function subscriptionsFor(subscriberId: string): Subscription[] {
	return subscriptionsBySubscriber.value.get(subscriberId) ?? [];
}

function toggleExpand(row: Subscriber): void {
	tableRef.value?.toggleRowExpansion(row);
}

const subActions = useSubscriptionActions({
	onChanged: async () => {
		await Promise.all([reloadSubscriptions(), reloadSubscriptionBin()]);
	},
});

async function refreshList(): Promise<void> {
	await Promise.all([reload(), reloadSubscriptions()]);
}

const statusOptions = computed<Array<{ value: 'all' | SubscriberStatus; label: string; count: number }>>(() => {
	const list = subscribers.value;
	const countOf = (status: SubscriberStatus) => list.filter((item) => item.status === status).length;
	return [
		{ value: 'all', label: t('common.all'), count: list.length },
		{ value: 'active', label: t('status.subscriber.active'), count: countOf('active') },
		{ value: 'limited', label: t('status.subscriber.limited'), count: countOf('limited') },
		{ value: 'expired', label: t('status.subscriber.expired'), count: countOf('expired') },
	];
});

const STATUS_ORDER: Record<SubscriberStatus, number> = {
	limited: 0,
	expired: 1,
	active: 2,
	disabled: 3,
};

const filteredSubscribers = computed(() => {
	const q = search.value.trim().toLowerCase();
	const list = subscribers.value.filter((row) => {
		if (statusFilter.value !== 'all' && row.status !== statusFilter.value) return false;
		if (!q) return true;
		if (row.name.toLowerCase().includes(q) || (row.email ?? '').toLowerCase().includes(q)) return true;
		return subscriptionsFor(row.id).some((sub) => sub.name.toLowerCase().includes(q) || (sub.profile_name ?? '').toLowerCase().includes(q));
	});
	return [...list].sort((a, b) => {
		switch (sortBy.value) {
			case 'name':
				return a.name.localeCompare(b.name);
			case 'status':
				return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name);
			case 'usage':
				return subscriberUsedBytes(b) - subscriberUsedBytes(a) || a.name.localeCompare(b.name);
			case 'expires':
				return (a.expires_at ?? Number.MAX_SAFE_INTEGER) - (b.expires_at ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);
		}
	});
});

function clearFilters(): void {
	search.value = '';
	statusFilter.value = 'all';
}

const rules = computed<FormRules>(() => ({
	name: [{ required: true, message: t('subscribers.form.nameRequired'), trigger: 'blur' }],
	email: [{ type: 'email', message: t('subscribers.form.invalidEmail'), trigger: 'blur' }],
}));

const {
	visible: dialogVisible,
	editingId,
	submitting,
	openCreate,
	openEdit,
	close: closeDialog,
	submit: submitDialog,
} = useCrudDialog({
	reset: () => {
		form.value = emptySubscriberForm();
	},
	load: (id) => {
		const row = subscribers.value.find((item) => item.id === id);
		if (row === undefined) return;
		form.value = {
			name: row.name,
			email: row.email ?? '',
			...limitParts(row.traffic_limit_bytes),
			expires_at: fromUnixSeconds(row.expires_at),
			suspended: row.status === 'disabled',
		};
	},
});

async function submit(): Promise<void> {
	if (!(await formRef.value?.validate().catch(() => false))) return;
	const email = form.value.email.trim();
	const payload: CreateSubscriberRequest & UpdateSubscriberRequest = {
		name: form.value.name.trim(),
		email: email === '' ? null : email,
		traffic_limit_bytes: limitBytes(form.value.limit_value, form.value.limit_unit),
		expires_at: toUnixSeconds(form.value.expires_at),
	};
	const subscriberId = editingId.value;
	const saved = await submitDialog(
		async () => {
			if (subscriberId === null) {
				await subscribersApi.create(payload);
				showSuccess(t('subscribers.form.created'));
			} else {
				// Only suspension is an administrator decision; limited and expired are
				// derived from quota and expiry on every write.
				const update: UpdateSubscriberRequest = { ...payload, status: form.value.suspended ? 'disabled' : 'active' };
				await subscribersApi.update(subscriberId, update);
				showSuccess(t('subscribers.form.updated'));
			}
			closeDialog();
		},
		(error) => showError(error, t('subscribers.form.saveFailed')),
	);
	if (saved) {
		invalidateCachedResource('subscribers:list');
		invalidateCachedPrefix('recycle-bin:');
		if (subscriberId !== null) {
			invalidateCachedResource(`subscribers:detail:${subscriberId}`);
		}
		await Promise.all([reload(), reloadSubscriberBin()]);
	}
}

const disableAction = useAsyncAction(
	async (row: Subscriber) => {
		await subscribersApi.update(row.id, { status: 'disabled' });
		showSuccess(t('subscribers.disable.success'));
		invalidateCachedResource('subscribers:list');
		invalidateCachedResource(`subscribers:detail:${row.id}`);
		invalidateCachedPrefix('recycle-bin:');
		invalidateCachedPrefix('nodes:clients:');
		await Promise.all([reload(), reloadSubscriberBin()]);
	},
	{ onError: (error) => showError(error, t('subscribers.disable.failed')) },
);

async function refreshBins(): Promise<void> {
	await Promise.all([reloadSubscriberBin(), reloadSubscriptionBin()]);
}

async function onBinChanged(): Promise<void> {
	await Promise.all([reload(), reloadSubscriptions(), refreshBins()]);
}

async function disableSubscriber(row: Subscriber): Promise<void> {
	if (!(await confirmAction(t('subscribers.disable.confirm', { name: row.name, days: 30 })))) return;
	await disableAction.runFor(row.id, row);
}
</script>

<template>
	<el-tabs v-model="activeTab">
		<el-tab-pane :label="`${t('nav.subscribers')} (${subscribers.length})`" name="list">
			<PageToolbar spread>
				<template #left>
					<div class="filters">
						<div class="filter-pills" role="group">
							<button
								v-for="opt in statusOptions"
								:key="opt.value"
								type="button"
								class="filter-pill"
								:class="{ 'is-active': statusFilter === opt.value }"
								:aria-pressed="statusFilter === opt.value"
								@click="statusFilter = opt.value"
							>
								<span>{{ opt.label }}</span>
								<span class="filter-pill-count">{{ opt.count }}</span>
							</button>
						</div>
						<el-input v-model="search" :placeholder="t('subscribers.searchPlaceholder')" clearable class="search-input" />
						<el-select v-model="sortBy" class="sort-select">
							<el-option :label="t('subscribers.sortStatus')" value="status" />
							<el-option :label="t('subscribers.sortName')" value="name" />
							<el-option :label="t('subscribers.sortUsage')" value="usage" />
							<el-option :label="t('subscribers.sortExpires')" value="expires" />
						</el-select>
					</div>
				</template>
				<ViewSwitch v-model="viewMode" />
				<el-button :loading="refreshing" @click="refreshList">
					<AppIcon name="refresh" :size="14" class="btn-icon" />
					<span>{{ t('common.refresh') }}</span>
				</el-button>
				<el-button type="primary" @click="openCreate">
					<AppIcon name="plus" :size="14" class="btn-icon" />
					<span>{{ t('subscribers.create') }}</span>
				</el-button>
			</PageToolbar>

			<div v-loading="loading" class="list-stage">
				<template v-if="filteredSubscribers.length > 0">
					<div v-if="viewMode === 'card'" class="card-grid is-align-start">
						<SubscriberCard
							v-for="row in filteredSubscribers"
							:key="row.id"
							:subscriber="row"
							:subscriptions="subscriptionsFor(row.id)"
							:profiles="profiles"
							:disabling="disableAction.isRunning(row.id)"
							:is-revoking="subActions.isRevoking"
							@edit="(item) => openEdit(item.id)"
							@disable="disableSubscriber"
							@create-subscription="(item) => subActions.openCreateFor({ id: item.id, name: item.name })"
							@show-subscription-links="subActions.openLinks"
							@edit-subscription="subActions.openEdit"
							@revoke-subscription="subActions.revoke"
						/>
					</div>
					<el-card v-else shadow="never">
						<el-table ref="tableRef" :data="filteredSubscribers" row-key="id" :empty-text="t('common.noData')">
							<el-table-column type="expand">
								<template #default="{ row }">
									<div class="expand-panel">
										<div class="expand-header">
											<span class="expand-title">
												<AppIcon name="subscriptions" :size="14" />
												<span>{{ t('nav.subscriptions') }} ({{ subscriptionsFor(row.id).length }})</span>
											</span>
											<el-button type="primary" size="small" @click="subActions.openCreateFor({ id: row.id, name: row.name })">
												<AppIcon name="plus" :size="13" class="btn-icon" />
												<span>{{ t('subscriptions.create') }}</span>
											</el-button>
										</div>
										<SubscriberSubscriptionsTable
											size="small"
											:subscriptions="subscriptionsFor(row.id)"
											:profiles="profiles"
											:loading="subscriptionsLoading"
											:is-revoking="subActions.isRevoking"
											@links="subActions.openLinks"
											@edit="subActions.openEdit"
											@revoke="subActions.revoke"
										/>
									</div>
								</template>
							</el-table-column>
							<el-table-column prop="name" :label="t('common.name')" min-width="150">
								<template #default="{ row }">
									<div class="name-cell">
										<RouterLink :to="`/subscribers/${row.id}`" class="ui-link">{{ row.name }}</RouterLink>
										<span v-if="row.email" class="email-sub">{{ row.email }}</span>
									</div>
								</template>
							</el-table-column>
							<el-table-column :label="t('common.status')" width="110">
								<template #default="{ row }">
									<StatusBadge
										:label="subscriberStatusDescriptor(row.status).label"
										:type="subscriberStatusDescriptor(row.status).tag"
										:pulse="row.status === 'active'"
									/>
								</template>
							</el-table-column>
							<el-table-column :label="t('subscribers.columns.usedQuota')" min-width="240">
								<template #default="{ row }">
									<div class="usage-cell">
										<div class="usage-top">
											<span class="tnum usage-text">{{ usageLabel(row as Subscriber) }}</span>
											<span v-if="subscriberUsageRatio(row as Subscriber) !== null" class="tnum usage-pct">
												{{ subscriberUsageRatio(row as Subscriber) }}%
											</span>
										</div>
										<div v-if="subscriberUsageRatio(row as Subscriber) !== null" class="usage-bar">
											<div
												class="usage-bar-fill"
												:class="usageTone(subscriberUsageRatio(row as Subscriber)!)"
												:style="{ width: `${subscriberUsageRatio(row as Subscriber)}%` }"
											/>
										</div>
										<span class="cycle-sub tnum">{{ usageCycleLabel(row as Subscriber) }}</span>
									</div>
								</template>
							</el-table-column>
							<el-table-column :label="t('subscribers.columns.expiresAt')" width="170">
								<template #default="{ row }">
									<span class="tnum">{{ formatTimestamp(row.expires_at) }}</span>
								</template>
							</el-table-column>
							<el-table-column :label="t('subscribers.columns.subscriptions')" width="105">
								<template #default="{ row }">
									<button type="button" class="sub-count-btn tnum" @click="toggleExpand(row as Subscriber)">
										<AppIcon name="subscriptions" :size="13" />
										<span>{{ subscriptionsFor(row.id).length }}</span>
									</button>
								</template>
							</el-table-column>
							<el-table-column :label="t('common.actions')" width="190" fixed="right">
								<template #default="{ row }">
									<el-button link type="primary" @click="openEdit(row.id)">{{ t('common.edit') }}</el-button>
									<RouterLink :to="`/subscribers/${row.id}`" custom v-slot="{ navigate }">
										<el-button link type="primary" @click="navigate">{{ t('common.details') }}</el-button>
									</RouterLink>
									<el-button link type="danger" :loading="disableAction.isRunning(row.id)" @click="disableSubscriber(row as Subscriber)">
										{{ t('subscribers.actions.disable') }}
									</el-button>
								</template>
							</el-table-column>
						</el-table>
					</el-card>
				</template>
				<el-card v-else-if="!loading" shadow="never" class="empty-stage-card">
					<el-empty :description="subscribers.length === 0 ? t('subscribers.empty') : t('subscribers.emptyFiltered')">
						<el-button v-if="subscribers.length === 0" type="primary" @click="openCreate">{{ t('subscribers.create') }}</el-button>
						<el-button v-else @click="clearFilters">{{ t('subscribers.clearFilters') }}</el-button>
					</el-empty>
				</el-card>
			</div>
		</el-tab-pane>

		<el-tab-pane :label="`${t('recycleBin.tab')} (${totalBinCount})`" name="recycle-bin">
			<div class="bin-switcher ui-section">
				<div class="filter-pills" role="group">
					<button
						type="button"
						class="filter-pill"
						:class="{ 'is-active': binCategory === 'subscriber' }"
						:aria-pressed="binCategory === 'subscriber'"
						@click="binCategory = 'subscriber'"
					>
						<span>{{ t('recycleBin.categories.subscriber') }}</span>
						<span class="filter-pill-count">{{ subscriberBin.items.length }}</span>
					</button>
					<button
						type="button"
						class="filter-pill"
						:class="{ 'is-active': binCategory === 'subscription' }"
						:aria-pressed="binCategory === 'subscription'"
						@click="binCategory = 'subscription'"
					>
						<span>{{ t('recycleBin.categories.subscription') }}</span>
						<span class="filter-pill-count">{{ subscriptionBin.items.length }}</span>
					</button>
				</div>
			</div>
			<RecycleBinTab
				:item-type="binCategory"
				:items="activeBin.items"
				:retention-days="activeBin.retention_days"
				:loading="activeBinLoading"
				:refreshing="activeBinRefreshing"
				@refresh="refreshBins"
				@changed="onBinChanged"
			/>
		</el-tab-pane>
	</el-tabs>

	<el-dialog
		v-model="dialogVisible"
		:title="editingId === null ? t('subscribers.create') : t('subscribers.edit')"
		width="540px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-form ref="formRef" :model="form" :rules="rules" label-width="130px">
			<el-form-item :label="t('common.name')" prop="name">
				<el-input v-model="form.name" />
			</el-form-item>
			<el-form-item :label="t('subscribers.form.email')" prop="email">
				<el-input v-model="form.email" />
			</el-form-item>
			<el-form-item :label="t('subscribers.form.quota')" prop="limit_value">
				<div class="limit-input">
					<el-input-number
						v-model="form.limit_value"
						:min="0"
						:precision="2"
						:controls="false"
						:placeholder="t('subscribers.form.unlimited')"
						class="limit-value"
					/>
					<el-select v-model="form.limit_unit" class="limit-unit">
						<el-option v-for="unit in LIMIT_UNITS" :key="unit" :label="unit" :value="unit" />
					</el-select>
				</div>
			</el-form-item>
			<el-form-item :label="t('subscribers.form.expiresAt')" prop="expires_at">
				<el-date-picker v-model="form.expires_at" type="datetime" class="full-width" />
			</el-form-item>
			<el-form-item v-if="editingId !== null" :label="t('common.disabled')">
				<el-switch v-model="form.suspended" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="closeDialog">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="submitting" @click="submit">{{ t('common.save') }}</el-button>
		</template>
	</el-dialog>

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

.filters {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}

.search-input {
	width: 240px;
}

.sort-select {
	width: 135px;
}

.name-cell {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.email-sub {
	font-size: 12px;
	color: var(--text-muted);
}

.usage-cell {
	display: flex;
	flex-direction: column;
	gap: 5px;
	max-width: 240px;
}

.usage-top {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.usage-text {
	font-size: 13px;
	font-weight: 500;
	color: var(--text-primary);
}

.usage-pct {
	font-size: 11.5px;
	color: var(--text-muted);
}

.usage-bar {
	width: 100%;
	height: 5px;
	background: var(--bg-subtle);
	border-radius: var(--radius-pill);
	overflow: hidden;
}

.usage-bar-fill {
	height: 100%;
	border-radius: var(--radius-pill);
	transition: width var(--duration-normal) var(--ease-standard);
}

.usage-bar-fill.is-primary {
	background: var(--accent-primary);
}

.usage-bar-fill.is-warning {
	background: var(--tone-warning);
}

.usage-bar-fill.is-danger {
	background: var(--tone-danger);
}

.cycle-sub {
	font-size: 11.5px;
	color: var(--text-muted);
}

.sub-count-btn {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 24px;
	padding: 0 9px;
	border: 1px solid var(--border-color);
	border-radius: var(--radius-pill);
	background: var(--bg-muted);
	color: var(--accent-primary);
	font-family: inherit;
	font-size: 12.5px;
	font-weight: 500;
	cursor: pointer;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		border-color var(--duration-fast) var(--ease-standard);
}

.sub-count-btn:hover {
	background: var(--accent-primary-soft);
	border-color: var(--accent-primary-border);
}

.expand-panel {
	padding: 12px 18px 16px;
	background: var(--bg-muted);
	border-top: 1px solid var(--border-subtle);
}

.expand-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 10px;
}

.expand-title {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 13px;
	font-weight: 600;
	color: var(--text-primary);
}

.bin-switcher {
	display: flex;
	align-items: center;
}

.full-width {
	width: 100%;
}

.limit-input {
	display: flex;
	gap: 8px;
	width: 100%;
}

.limit-value {
	flex: 1;
}

.limit-unit {
	width: 90px;
	flex: none;
}
</style>
