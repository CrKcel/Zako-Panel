<script setup lang="ts">
import type { CreateSubscriptionRequest, Profile, Subscriber, Subscription } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { profilesApi } from '../api/profiles';
import { subscribersApi } from '../api/subscribers';
import { subscriptionsApi } from '../api/subscriptions';
import AppIcon from '../components/AppIcon.vue';
import PageToolbar from '../components/PageToolbar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { invalidateCachedResource } from '../composables/resourceCache';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import { subscriptionStatusDescriptor } from '../domain/status';
import { useI18n } from '../i18n';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';
import { subscriptionLinks } from '../utils/subscription';
import { toUnixSeconds } from '../utils/time';

type SubscriptionStatusKey = 'active' | 'expired' | 'revoked';

const { t } = useI18n();

interface SubscriptionForm {
	name: string;
	subscriber_id: string;
	profile_id: string;
	expires_at: Date | null;
}

function emptySubscriptionForm(): SubscriptionForm {
	return { name: '', subscriber_id: '', profile_id: '', expires_at: null };
}

const search = ref('');
const statusFilter = ref<'all' | SubscriptionStatusKey>('all');
const form = ref<SubscriptionForm>(emptySubscriptionForm());
const formRef = ref<FormInstance>();
const token = ref('');
const tokenVisible = ref(false);

const {
	data: subscriptions,
	loading,
	refreshing,
	reload,
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

const { data: subscribers } = useAsyncResource<Subscriber[]>(() => subscribersApi.list().then((page) => page.items), {
	initialValue: [],
	cacheKey: 'subscribers:list',
	onError: (error) => showError(error, t('subscriptions.loadSubscribersError')),
});

const rules = computed<FormRules>(() => ({
	name: [{ required: true, message: t('subscriptions.form.nameRequired'), trigger: 'blur' }],
	subscriber_id: [{ required: true, message: t('subscriptions.form.subscriberRequired'), trigger: 'change' }],
	profile_id: [{ required: true, message: t('subscriptions.form.profileRequired'), trigger: 'change' }],
}));

const links = computed(() => subscriptionLinks(token.value));

const {
	visible: dialogVisible,
	submitting,
	openCreate,
	close: closeDialog,
	submit: submitDialog,
} = useCrudDialog({
	reset: () => {
		form.value = emptySubscriptionForm();
	},
});

function profileName(profileId: string): string {
	return profiles.value.find((profile) => profile.id === profileId)?.name ?? profileId;
}

function subscriberName(subscriberId: string): string {
	return subscribers.value.find((subscriber) => subscriber.id === subscriberId)?.name ?? subscriberId;
}

function resolveStatus(row: Subscription, nowMs = Date.now()): SubscriptionStatusKey {
	if (row.revoked_at !== null) return 'revoked';
	if (row.expires_at !== null && row.expires_at * 1000 <= nowMs) return 'expired';
	return 'active';
}

const statusOptions = computed<Array<{ value: 'all' | SubscriptionStatusKey; label: string; count: number }>>(() => {
	const nowMs = Date.now();
	const list = subscriptions.value;
	const countOf = (key: SubscriptionStatusKey) => list.filter((row) => resolveStatus(row, nowMs) === key).length;
	return [
		{ value: 'all', label: t('common.all'), count: list.length },
		{ value: 'active', label: t('status.subscription.active'), count: countOf('active') },
		{ value: 'expired', label: t('status.subscription.expired'), count: countOf('expired') },
		{ value: 'revoked', label: t('status.subscription.revoked'), count: countOf('revoked') },
	];
});

const filteredSubscriptions = computed(() => {
	const q = search.value.trim().toLowerCase();
	const nowMs = Date.now();
	return subscriptions.value.filter((row) => {
		if (statusFilter.value !== 'all' && resolveStatus(row, nowMs) !== statusFilter.value) return false;
		if (!q) return true;
		return (
			row.name.toLowerCase().includes(q) ||
			subscriberName(row.subscriber_id).toLowerCase().includes(q) ||
			profileName(row.profile_id).toLowerCase().includes(q)
		);
	});
});

async function submit(): Promise<void> {
	if (!(await formRef.value?.validate().catch(() => false))) return;
	const payload: CreateSubscriptionRequest = {
		name: form.value.name,
		subscriber_id: form.value.subscriber_id,
		profile_id: form.value.profile_id,
		expires_at: toUnixSeconds(form.value.expires_at),
	};
	const saved = await submitDialog(
		async () => {
			const result = await subscriptionsApi.create(payload);
			closeDialog();
			token.value = result.token;
			tokenVisible.value = true;
			showSuccess(t('subscriptions.form.created'));
		},
		(error) => showError(error, t('subscriptions.form.createFailed')),
	);
	if (saved) {
		invalidateCachedResource('subscriptions:list');
		await reload();
	}
}

const rotateAction = useAsyncAction(
	async (row: Subscription) => {
		const result = await subscriptionsApi.rotate(row.id);
		token.value = result.token;
		tokenVisible.value = true;
		showSuccess(t('subscriptions.rotate.success'));
		invalidateCachedResource('subscriptions:list');
		await reload();
	},
	{ onError: (error) => showError(error, t('subscriptions.rotate.failed')) },
);

const revokeAction = useAsyncAction(
	async (row: Subscription) => {
		await subscriptionsApi.revoke(row.id);
		showSuccess(t('subscriptions.revoke.success'));
		invalidateCachedResource('subscriptions:list');
		await reload();
	},
	{ onError: (error) => showError(error, t('subscriptions.revoke.failed')) },
);

async function rotate(row: Subscription): Promise<void> {
	if (!(await confirmAction(t('subscriptions.rotate.confirm', { name: row.name })))) return;
	await rotateAction.runFor(row.id, row);
}

async function revoke(row: Subscription): Promise<void> {
	if (!(await confirmAction(t('subscriptions.revoke.confirm', { name: row.name })))) return;
	await revokeAction.run(row);
}
</script>

<template>
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
				<el-input v-model="search" :placeholder="t('subscriptions.searchPlaceholder')" clearable class="search-input" />
			</div>
		</template>
		<el-button :loading="refreshing" @click="reload">
			<AppIcon name="refresh" :size="14" class="btn-icon" />
			<span>{{ t('common.refresh') }}</span>
		</el-button>
		<el-button type="primary" @click="openCreate">
			<AppIcon name="plus" :size="14" class="btn-icon" />
			<span>{{ t('subscriptions.create') }}</span>
		</el-button>
	</PageToolbar>

	<el-card shadow="never">
		<el-table v-loading="loading" :data="filteredSubscriptions" :empty-text="t('common.noData')">
			<el-table-column prop="name" :label="t('common.name')" min-width="160" />
			<el-table-column :label="t('subscriptions.columns.subscriber')" min-width="160">
				<template #default="{ row }">
					<RouterLink :to="`/subscribers/${row.subscriber_id}`" class="ui-link">
						{{ subscriberName(row.subscriber_id) }}
					</RouterLink>
				</template>
			</el-table-column>
			<el-table-column :label="t('subscriptions.columns.profile')" min-width="160">
				<template #default="{ row }">{{ profileName(row.profile_id) }}</template>
			</el-table-column>
			<el-table-column :label="t('common.status')" width="110">
				<template #default="{ row }">
					<StatusBadge
						:label="subscriptionStatusDescriptor(row as Subscription).label"
						:type="subscriptionStatusDescriptor(row as Subscription).tag"
						:pulse="resolveStatus(row as Subscription) === 'active'"
					/>
				</template>
			</el-table-column>
			<el-table-column :label="t('subscriptions.columns.expiresAt')" width="180">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.expires_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('subscriptions.columns.createdAt')" width="180">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.created_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('common.actions')" width="160" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" :loading="rotateAction.isRunning(row.id)" @click="rotate(row as Subscription)">{{
						t('subscriptions.actions.rotate')
					}}</el-button>
					<el-button link type="danger" :disabled="row.revoked_at !== null" @click="revoke(row as Subscription)">{{
						t('subscriptions.actions.revoke')
					}}</el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog v-model="dialogVisible" :title="t('subscriptions.create')" width="560px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="formRef" :model="form" :rules="rules" label-width="130px">
			<el-form-item :label="t('common.name')" prop="name">
				<el-input v-model="form.name" />
			</el-form-item>
			<el-form-item :label="t('subscriptions.form.subscriber')" prop="subscriber_id">
				<el-select v-model="form.subscriber_id" filterable class="full-width">
					<el-option v-for="subscriber in subscribers" :key="subscriber.id" :label="subscriber.name" :value="subscriber.id" />
				</el-select>
			</el-form-item>
			<el-form-item :label="t('subscriptions.form.profile')" prop="profile_id">
				<el-select v-model="form.profile_id" class="full-width">
					<el-option v-for="profile in profiles" :key="profile.id" :label="profile.name" :value="profile.id" />
				</el-select>
			</el-form-item>
			<el-form-item :label="t('subscriptions.form.expiresAt')" prop="expires_at">
				<el-date-picker v-model="form.expires_at" type="datetime" class="full-width" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="closeDialog">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="submitting" @click="submit">{{ t('common.create') }}</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="tokenVisible" :title="t('subscriptions.links.title')" width="720px" :close-on-click-modal="false">
		<el-alert type="info" :closable="false" show-icon class="links-alert" :title="t('subscriptions.links.oneTimeHint')" />
		<div class="link-list">
			<div class="link-row">
				<span class="link-label">{{ t('subscriptions.links.token') }}</span>
				<el-input :model-value="token" readonly class="mono">
					<template #append>
						<el-button @click="copyText(token)">{{ t('common.copy') }}</el-button>
					</template>
				</el-input>
			</div>
			<div v-for="link in links" :key="link.label" class="link-row">
				<span class="link-label">{{ link.label }}</span>
				<el-input :model-value="link.url" readonly class="mono">
					<template #append>
						<el-button @click="copyText(link.url)">{{ t('common.copy') }}</el-button>
					</template>
				</el-input>
			</div>
		</div>
	</el-dialog>
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

.full-width {
	width: 100%;
}

.links-alert {
	margin-bottom: 14px;
}

.link-list {
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.link-row {
	display: flex;
	align-items: center;
	gap: 12px;
}

.link-label {
	width: 96px;
	flex: none;
	font-size: 13px;
	font-weight: 500;
	color: var(--text-secondary);
}

@media (max-width: 640px) {
	.link-row {
		flex-direction: column;
		align-items: stretch;
		gap: 6px;
	}
}
</style>
