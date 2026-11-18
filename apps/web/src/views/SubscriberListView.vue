<script setup lang="ts">
import type { CreateSubscriberRequest, Node, Subscriber, UpdateSubscriberRequest } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { subscribersApi } from '../api/subscribers';
import NodeGrantDialog from '../components/NodeGrantDialog.vue';
import PageToolbar from '../components/PageToolbar.vue';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import { LIMIT_UNITS, limitBytes, limitParts, usageCycleLabel, usageLabel, type LimitUnit } from '../domain/subscriber';
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
		<PageToolbar>
			<el-button :loading="loading" @click="reload">刷新</el-button>
			<el-button type="primary" @click="openCreate">创建订阅用户</el-button>
		</PageToolbar>
		<el-table v-loading="loading" :data="subscribers" empty-text="暂无数据">
			<el-table-column prop="name" label="名称" min-width="160" />
			<el-table-column label="邮箱" min-width="200">
				<template #default="{ row }">{{ row.email ?? '—' }}</template>
			</el-table-column>
			<el-table-column label="状态" width="100">
				<template #default="{ row }">
					<el-tag :type="subscriberStatusDescriptor(row.status).tag" disable-transitions>
						{{ subscriberStatusDescriptor(row.status).label }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="已用 / 额度" min-width="190">
				<template #default="{ row }">{{ usageLabel(row as Subscriber) }}</template>
			</el-table-column>
			<el-table-column label="周期" min-width="330">
				<template #default="{ row }">{{ usageCycleLabel(row as Subscriber) }}</template>
			</el-table-column>
			<el-table-column label="到期" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.expires_at) }}</template>
			</el-table-column>
			<el-table-column label="授权节点" width="110">
				<template #default="{ row }">
					<RouterLink :to="`/subscribers/${row.id}`" class="subscriber-link">
						{{ row.node_count }}
					</RouterLink>
				</template>
			</el-table-column>
			<el-table-column label="操作" width="210" fixed="right">
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

.subscriber-link {
	color: #2563eb;
	text-decoration: none;
}

.subscriber-link:hover {
	text-decoration: underline;
}
</style>
