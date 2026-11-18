<script setup lang="ts">
import type { CreateSubscriberRequest, Node, Subscriber, SubscriberStatus, UpdateSubscriberRequest } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { subscribersApi } from '../api/subscribers';
import { showError, showSuccess } from '../utils/feedback';
import { formatBytes, formatTimestamp, SUBSCRIBER_STATUS_LABEL, SUBSCRIBER_STATUS_TAG } from '../utils/format';

type LimitUnit = 'GB' | 'MB';

interface SubscriberForm {
	name: string;
	email: string;
	limit_value: number | undefined;
	limit_unit: LimitUnit;
	expires_at: Date | null;
	suspended: boolean;
}

const UNIT_BYTES: Record<LimitUnit, number> = {
	GB: 1024 ** 3,
	MB: 1024 ** 2,
};

const LIMIT_UNITS: LimitUnit[] = ['GB', 'MB'];

const subscribers = ref<Subscriber[]>([]);
const nodes = ref<Node[]>([]);
const loading = ref(true);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const formRef = ref<FormInstance>();

const grantDialogVisible = ref(false);
const grantSubscriber = ref<Subscriber | null>(null);
const grantedNodeIds = ref<string[]>([]);
const grantLoading = ref(false);
const grantSaving = ref(false);

function emptyForm(): SubscriberForm {
	return { name: '', email: '', limit_value: undefined, limit_unit: 'GB', expires_at: null, suspended: false };
}

const form = ref<SubscriberForm>(emptyForm());

const rules: FormRules = {
	name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
	email: [{ type: 'email', message: '邮箱格式不正确', trigger: 'blur' }],
};

const dialogTitle = computed(() => (editingId.value === null ? '创建订阅用户' : '编辑订阅用户'));

function limitBytes(): number | null {
	const value = form.value.limit_value;
	if (value === undefined || value <= 0) return null;
	return Math.round(value * UNIT_BYTES[form.value.limit_unit]);
}

function limitParts(bytes: number | null | undefined): Pick<SubscriberForm, 'limit_value' | 'limit_unit'> {
	if (bytes === null || bytes === undefined) return { limit_value: undefined, limit_unit: 'GB' };
	if (bytes >= UNIT_BYTES.GB) return { limit_value: Number((bytes / UNIT_BYTES.GB).toFixed(2)), limit_unit: 'GB' };
	return { limit_value: Number((bytes / UNIT_BYTES.MB).toFixed(2)), limit_unit: 'MB' };
}

function usedBytes(row: Subscriber): number {
	if (row.usage === null || row.usage === undefined) return 0;
	return row.usage.uplink_bytes + row.usage.downlink_bytes;
}

function usedLabel(row: Subscriber): string {
	const limit = row.traffic_limit_bytes === null || row.traffic_limit_bytes === undefined ? '不限量' : formatBytes(row.traffic_limit_bytes);
	return `${formatBytes(usedBytes(row))} / ${limit}`;
}

function cycleLabel(row: Subscriber): string {
	return `${formatTimestamp(row.usage_cycle_start)} ~ ${formatTimestamp(row.usage_cycle_end)}`;
}

function expiresAtSeconds(): number | null {
	const expiresAt = form.value.expires_at;
	return expiresAt === null ? null : Math.floor(expiresAt.getTime() / 1000);
}

async function load(): Promise<void> {
	loading.value = true;
	try {
		const page = await subscribersApi.list({ limit: 200 });
		subscribers.value = page.items;
	} catch (error) {
		showError(error, '订阅用户加载失败');
	} finally {
		loading.value = false;
	}
}

async function loadNodes(): Promise<void> {
	try {
		const page = await nodesApi.list({ limit: 200 });
		nodes.value = page.items;
	} catch (error) {
		showError(error, '节点加载失败');
	}
}

function openCreate(): void {
	editingId.value = null;
	form.value = emptyForm();
	dialogVisible.value = true;
}

function openEdit(row: Subscriber): void {
	editingId.value = row.id;
	form.value = {
		name: row.name,
		email: row.email ?? '',
		...limitParts(row.traffic_limit_bytes),
		expires_at: row.expires_at === null || row.expires_at === undefined ? null : new Date(row.expires_at * 1000),
		suspended: row.status === 'disabled',
	};
	dialogVisible.value = true;
}

async function submit(): Promise<void> {
	const valid = await formRef.value?.validate().catch(() => false);
	if (!valid) return;
	const email = form.value.email.trim();
	const payload: CreateSubscriberRequest & UpdateSubscriberRequest = {
		name: form.value.name.trim(),
		email: email === '' ? null : email,
		traffic_limit_bytes: limitBytes(),
		expires_at: expiresAtSeconds(),
	};
	saving.value = true;
	try {
		if (editingId.value === null) {
			await subscribersApi.create(payload);
			showSuccess('订阅用户已创建');
		} else {
			// Only suspension is an administrator decision; limited and expired are
			// derived from quota and expiry on every write.
			const update: UpdateSubscriberRequest = { ...payload, status: form.value.suspended ? 'disabled' : 'active' };
			await subscribersApi.update(editingId.value, update);
			showSuccess('订阅用户已更新');
		}
		dialogVisible.value = false;
		await load();
	} catch (error) {
		showError(error, '订阅用户保存失败');
	} finally {
		saving.value = false;
	}
}

async function openGrant(row: Subscriber): Promise<void> {
	grantSubscriber.value = row;
	grantedNodeIds.value = [];
	grantDialogVisible.value = true;
	grantLoading.value = true;
	try {
		const detail = await subscribersApi.get(row.id);
		grantedNodeIds.value = detail.node_ids;
	} catch (error) {
		grantDialogVisible.value = false;
		showError(error, '订阅用户加载失败');
	} finally {
		grantLoading.value = false;
	}
}

async function submitGrant(): Promise<void> {
	if (grantSubscriber.value === null) return;
	grantSaving.value = true;
	try {
		await subscribersApi.replaceNodes(grantSubscriber.value.id, grantedNodeIds.value);
		grantDialogVisible.value = false;
		await load();
		showSuccess('节点授权已更新');
	} catch (error) {
		showError(error, '节点授权保存失败');
	} finally {
		grantSaving.value = false;
	}
}

onMounted(async () => {
	await Promise.all([load(), loadNodes()]);
});
</script>

<template>
	<el-card shadow="never">
		<div class="toolbar">
			<el-button :loading="loading" @click="load">刷新</el-button>
			<el-button type="primary" @click="openCreate">创建订阅用户</el-button>
		</div>
		<el-table v-loading="loading" :data="subscribers" empty-text="暂无数据">
			<el-table-column prop="name" label="名称" min-width="160" />
			<el-table-column label="邮箱" min-width="200">
				<template #default="{ row }">{{ row.email ?? '—' }}</template>
			</el-table-column>
			<el-table-column label="状态" width="100">
				<template #default="{ row }">
					<el-tag :type="SUBSCRIBER_STATUS_TAG[row.status as SubscriberStatus]" disable-transitions>
						{{ SUBSCRIBER_STATUS_LABEL[row.status as SubscriberStatus] }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="已用 / 额度" min-width="190">
				<template #default="{ row }">{{ usedLabel(row as Subscriber) }}</template>
			</el-table-column>
			<el-table-column label="周期" min-width="330">
				<template #default="{ row }">{{ cycleLabel(row as Subscriber) }}</template>
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
					<el-button link type="primary" @click="openEdit(row as Subscriber)">编辑</el-button>
					<el-button link type="primary" @click="openGrant(row as Subscriber)">节点授权</el-button>
					<RouterLink :to="`/subscribers/${row.id}`" custom v-slot="{ navigate }">
						<el-button link type="primary" @click="navigate">详情</el-button>
					</RouterLink>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog v-model="dialogVisible" :title="dialogTitle" width="520px" :close-on-click-modal="false" destroy-on-close>
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
			<el-button @click="dialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="saving" @click="submit">保存</el-button>
		</template>
	</el-dialog>

	<el-dialog
		v-model="grantDialogVisible"
		:title="`节点授权 · ${grantSubscriber?.name ?? ''}`"
		width="520px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<div v-loading="grantLoading">
			<el-select v-model="grantedNodeIds" multiple filterable class="full-width">
				<el-option v-for="node in nodes" :key="node.id" :label="node.name" :value="node.id" />
			</el-select>
		</div>
		<template #footer>
			<el-button @click="grantDialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="grantSaving" @click="submitGrant">保存</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.notice {
	margin-bottom: 16px;
}

.toolbar {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-bottom: 16px;
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

.subscriber-link {
	color: #2563eb;
	text-decoration: none;
}

.subscriber-link:hover {
	text-decoration: underline;
}
</style>
