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
import { showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';
import { fromUnixSeconds, toUnixSeconds } from '../utils/time';

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
	onError: (error) => showError(error, '订阅用户加载失败'),
});

const { data: nodes } = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, '节点加载失败'),
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

const rules: FormRules = {
	name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
	email: [{ type: 'email', message: '邮箱格式不正确', trigger: 'blur' }],
};

const grantTitle = computed(() => `节点授权 · ${grantTarget.value?.name ?? ''}`);

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
				showSuccess('订阅用户已创建');
			} else {
				// Only suspension is an administrator decision; limited and expired are
				// derived from quota and expiry on every write.
				const update: UpdateSubscriberRequest = { ...payload, status: form.value.suspended ? 'disabled' : 'active' };
				await subscribersApi.update(subscriberId, update);
				showSuccess('订阅用户已更新');
			}
			closeDialog();
		},
		(error) => showError(error, '订阅用户保存失败'),
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
					<el-input v-model="search" placeholder="搜索名称或邮箱…" clearable class="search-input" />
					<el-select v-model="statusFilter" class="status-select">
						<el-option label="全部状态" value="all" />
						<el-option label="正常" value="active" />
						<el-option label="超限" value="limited" />
						<el-option label="已到期" value="expired" />
						<el-option label="停用" value="disabled" />
					</el-select>
				</div>
			</template>
			<el-button :loading="loading" @click="reload">刷新</el-button>
			<el-button type="primary" @click="openCreate">创建订阅用户</el-button>
		</PageToolbar>

		<el-table v-loading="loading" :data="filteredSubscribers" empty-text="暂无数据">
			<el-table-column prop="name" label="名称" min-width="150">
				<template #default="{ row }">
					<RouterLink :to="`/subscribers/${row.id}`" class="ui-link">{{ row.name }}</RouterLink>
				</template>
			</el-table-column>
			<el-table-column label="邮箱" min-width="190">
				<template #default="{ row }">{{ row.email ?? '—' }}</template>
			</el-table-column>
			<el-table-column label="状态" width="105">
				<template #default="{ row }">
					<StatusBadge :label="subscriberStatusDescriptor(row.status).label" :type="subscriberStatusDescriptor(row.status).tag" />
				</template>
			</el-table-column>
			<el-table-column label="已用 / 额度" min-width="200">
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
			<el-table-column label="周期" min-width="310">
				<template #default="{ row }">
					<span class="tnum">{{ usageCycleLabel(row as Subscriber) }}</span>
				</template>
			</el-table-column>
			<el-table-column label="到期" width="175">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.expires_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column label="授权节点" width="100">
				<template #default="{ row }">
					<RouterLink :to="`/subscribers/${row.id}`" class="ui-link tnum">
						{{ row.node_count }}
					</RouterLink>
				</template>
			</el-table-column>
			<el-table-column label="操作" width="200" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" @click="openEdit(row.id)">编辑</el-button>
					<el-button link type="primary" @click="openGrant(row as Subscriber)">节点授权</el-button>
					<RouterLink :to="`/subscribers/${row.id}`" custom v-slot="{ navigate }">
						<el-button link type="primary" @click="navigate">详情</el-button>
					</RouterLink>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog
		v-model="dialogVisible"
		:title="editingId === null ? '创建订阅用户' : '编辑订阅用户'"
		width="520px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
			<el-form-item label="名称" prop="name">
				<el-input v-model="form.name" />
			</el-form-item>
			<el-form-item label="邮箱" prop="email">
				<el-input v-model="form.email" />
			</el-form-item>
			<el-form-item label="流量额度" prop="limit_value">
				<div class="limit-input">
					<el-input-number v-model="form.limit_value" :min="0" :precision="2" :controls="false" placeholder="不限量" class="limit-value" />
					<el-select v-model="form.limit_unit" class="limit-unit">
						<el-option v-for="unit in LIMIT_UNITS" :key="unit" :label="unit" :value="unit" />
					</el-select>
				</div>
			</el-form-item>
			<el-form-item label="到期时间" prop="expires_at">
				<el-date-picker v-model="form.expires_at" type="datetime" class="full-width" />
			</el-form-item>
			<el-form-item v-if="editingId !== null" label="停用">
				<el-switch v-model="form.suspended" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="closeDialog">取消</el-button>
			<el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
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
	width: 120px;
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
