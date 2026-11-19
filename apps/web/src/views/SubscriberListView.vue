<script setup lang="ts">
import type { CreateSubscriberRequest, Node, Subscriber, UpdateSubscriberRequest } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { subscribersApi } from '../api/subscribers';
import NodeGrantDialog from '../components/NodeGrantDialog.vue';
import PageToolbar from '../components/PageToolbar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import {
	LIMIT_UNITS,
	limitBytes,
	limitParts,
	subscriberUsedBytes,
	usageCycleLabel,
	usageLabel,
	type LimitUnit,
} from '../domain/subscriber';
import { subscriberStatusDescriptor } from '../domain/status';
import { useI18n } from '../i18n';
import { showError, showSuccess } from '../utils/feedback';
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

const search = ref('');
const statusFilter = ref<'all' | Subscriber['status']>('all');

const form = ref<SubscriberForm>(emptySubscriberForm());
const formRef = ref<FormInstance>();
const grantVisible = ref(false);
const grantTarget = ref<Subscriber | null>(null);

const {
	data: subscribers,
	loading,
	reload,
} = useAsyncResource<Subscriber[]>(() => subscribersApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, t('subscribers.loadError')),
});

const { data: nodes } = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, t('subscribers.loadNodesError')),
});

const filteredSubscribers = computed(() => {
	const q = search.value.trim().toLowerCase();
	return subscribers.value.filter((row) => {
		if (statusFilter.value !== 'all' && row.status !== statusFilter.value) return false;
		if (q && !row.name.toLowerCase().includes(q) && !(row.email ?? '').toLowerCase().includes(q)) return false;
		return true;
	});
});

function usageRatio(row: Subscriber): number | null {
	if (!row.traffic_limit_bytes || row.traffic_limit_bytes <= 0) return null;
	return Math.min(100, Math.round((subscriberUsedBytes(row) / row.traffic_limit_bytes) * 100));
}

function usageTone(ratio: number): string {
	if (ratio >= 95) return 'is-danger';
	if (ratio >= 80) return 'is-warning';
	return 'is-primary';
}

const rules = computed<FormRules>(() => ({
	name: [{ required: true, message: t('subscribers.form.nameRequired'), trigger: 'blur' }],
	email: [{ type: 'email', message: t('subscribers.form.invalidEmail'), trigger: 'blur' }],
}));

const grantTitle = computed(() => t('subscribers.grant.titleWithName', { name: grantTarget.value?.name ?? '' }));

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
	if (saved) await reload();
}

function openGrant(row: Subscriber): void {
	grantTarget.value = row;
	grantVisible.value = true;
}
</script>

<template>
	<el-card shadow="never">
		<PageToolbar spread>
			<template #left>
				<div class="filters">
					<el-input v-model="search" :placeholder="t('subscribers.searchPlaceholder')" clearable class="search-input" />
					<el-select v-model="statusFilter" class="status-select">
						<el-option :label="t('common.allStatuses')" value="all" />
						<el-option :label="t('status.subscriber.active')" value="active" />
						<el-option :label="t('status.subscriber.limited')" value="limited" />
						<el-option :label="t('status.subscriber.expired')" value="expired" />
						<el-option :label="t('status.subscriber.disabled')" value="disabled" />
					</el-select>
				</div>
			</template>
			<el-button :loading="loading" @click="reload">{{ t('common.refresh') }}</el-button>
			<el-button type="primary" @click="openCreate">{{ t('subscribers.create') }}</el-button>
		</PageToolbar>

		<el-table v-loading="loading" :data="filteredSubscribers" :empty-text="t('common.noData')">
			<el-table-column prop="name" :label="t('common.name')" min-width="150">
				<template #default="{ row }">
					<RouterLink :to="`/subscribers/${row.id}`" class="ui-link">{{ row.name }}</RouterLink>
				</template>
			</el-table-column>
			<el-table-column :label="t('subscribers.columns.email')" min-width="190">
				<template #default="{ row }">{{ row.email ?? '—' }}</template>
			</el-table-column>
			<el-table-column :label="t('common.status')" width="115">
				<template #default="{ row }">
					<StatusBadge :label="subscriberStatusDescriptor(row.status).label" :type="subscriberStatusDescriptor(row.status).tag" />
				</template>
			</el-table-column>
			<el-table-column :label="t('subscribers.columns.usedQuota')" min-width="200">
				<template #default="{ row }">
					<div class="usage-cell">
						<span class="tnum">{{ usageLabel(row as Subscriber) }}</span>
						<div v-if="usageRatio(row as Subscriber) !== null" class="usage-bar">
							<div
								class="usage-bar-fill"
								:class="usageTone(usageRatio(row as Subscriber)!)"
								:style="{ width: `${usageRatio(row as Subscriber)}%` }"
							/>
						</div>
					</div>
				</template>
			</el-table-column>
			<el-table-column :label="t('subscribers.columns.cycle')" min-width="310">
				<template #default="{ row }">
					<span class="tnum">{{ usageCycleLabel(row as Subscriber) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('subscribers.columns.expiresAt')" width="180">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.expires_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('subscribers.columns.grantedNodes')" width="130">
				<template #default="{ row }">
					<RouterLink :to="`/subscribers/${row.id}`" class="ui-link tnum">
						{{ row.node_count }}
					</RouterLink>
				</template>
			</el-table-column>
			<el-table-column :label="t('common.actions')" width="220" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" @click="openEdit(row.id)">{{ t('common.edit') }}</el-button>
					<el-button link type="primary" @click="openGrant(row as Subscriber)">{{ t('subscribers.actions.nodeGrant') }}</el-button>
					<RouterLink :to="`/subscribers/${row.id}`" custom v-slot="{ navigate }">
						<el-button link type="primary" @click="navigate">{{ t('common.details') }}</el-button>
					</RouterLink>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

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

	<NodeGrantDialog v-model:visible="grantVisible" :title="grantTitle" :subscriber="grantTarget" :nodes="nodes" @saved="reload" />
</template>

<style scoped>
.filters {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}

.search-input {
	width: 220px;
}

.status-select {
	width: 140px;
}

.usage-cell {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.usage-bar {
	width: 100%;
	max-width: 160px;
	height: 5px;
	background: var(--bg-subtle);
	border-radius: 9999px;
	overflow: hidden;
}

.usage-bar-fill {
	height: 100%;
	border-radius: 9999px;
	transition: width 0.2s ease;
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
