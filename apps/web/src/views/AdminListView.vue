<script setup lang="ts">
import type { AdminRole, AdminUser, CreateAdminRequest, UpdateAdminRequest } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { adminsApi } from '../api/admins';
import { showError, showSuccess } from '../utils/feedback';
import { ADMIN_ROLE_LABEL, formatTimestamp } from '../utils/format';

interface AdminForm {
	email: string;
	role: AdminRole;
	enabled: boolean;
}

const ROLE_OPTIONS: AdminRole[] = ['owner', 'admin', 'viewer'];

const ROLE_TAG: Record<AdminRole, 'warning' | 'primary' | 'info'> = {
	owner: 'warning',
	admin: 'primary',
	viewer: 'info',
};

const admins = ref<AdminUser[]>([]);
const loading = ref(true);
const saving = ref(false);
const createDialogVisible = ref(false);
const editDialogVisible = ref(false);
const editingId = ref<string | null>(null);
const createFormRef = ref<FormInstance>();
const editFormRef = ref<FormInstance>();

function emptyCreateForm(): AdminForm {
	return { email: '', role: 'admin', enabled: true };
}

const createForm = ref<AdminForm>(emptyCreateForm());
const editForm = ref<AdminForm>(emptyCreateForm());

const createRules: FormRules = {
	email: [
		{ required: true, message: '请输入邮箱', trigger: 'blur' },
		{ type: 'email', message: '邮箱格式不正确', trigger: 'blur' },
	],
	role: [{ required: true, message: '请选择角色', trigger: 'change' }],
};

const editRules: FormRules = {
	role: [{ required: true, message: '请选择角色', trigger: 'change' }],
};

const editTitle = computed(() => `编辑管理员 · ${editForm.value.email}`);

async function load(): Promise<void> {
	loading.value = true;
	try {
		const page = await adminsApi.list({ limit: 200 });
		admins.value = page.items;
	} catch (error) {
		showError(error, '管理员加载失败');
	} finally {
		loading.value = false;
	}
}

function openCreate(): void {
	createForm.value = emptyCreateForm();
	createDialogVisible.value = true;
}

async function submitCreate(): Promise<void> {
	const valid = await createFormRef.value?.validate().catch(() => false);
	if (!valid) return;
	const payload: CreateAdminRequest = {
		email: createForm.value.email.trim(),
		role: createForm.value.role,
	};
	saving.value = true;
	try {
		await adminsApi.create(payload);
		createDialogVisible.value = false;
		showSuccess('管理员已创建');
		await load();
	} catch (error) {
		showError(error, '管理员创建失败');
	} finally {
		saving.value = false;
	}
}

function openEdit(row: AdminUser): void {
	editingId.value = row.id;
	editForm.value = { email: row.email, role: row.role, enabled: row.enabled };
	editDialogVisible.value = true;
}

async function submitEdit(): Promise<void> {
	if (editingId.value === null) return;
	const valid = await editFormRef.value?.validate().catch(() => false);
	if (!valid) return;
	const payload: UpdateAdminRequest = { role: editForm.value.role, enabled: editForm.value.enabled };
	saving.value = true;
	try {
		await adminsApi.update(editingId.value, payload);
		editDialogVisible.value = false;
		showSuccess('管理员已更新');
		await load();
	} catch (error) {
		showError(error, '管理员更新失败');
	} finally {
		saving.value = false;
	}
}

onMounted(load);
</script>

<template>
	<el-card shadow="never">
		<div class="toolbar">
			<el-button :loading="loading" @click="load">刷新</el-button>
			<el-button type="primary" @click="openCreate">新增管理员</el-button>
		</div>
		<el-table v-loading="loading" :data="admins" empty-text="暂无数据">
			<el-table-column prop="email" label="邮箱" min-width="260" />
			<el-table-column label="角色" width="110">
				<template #default="{ row }">
					<el-tag :type="ROLE_TAG[row.role as AdminRole]" disable-transitions>
						{{ ADMIN_ROLE_LABEL[row.role as AdminRole] }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="启用" width="90">
				<template #default="{ row }">
					<el-tag :type="row.enabled ? 'success' : 'info'" disable-transitions>
						{{ row.enabled ? '启用' : '停用' }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="创建时间" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.created_at) }}</template>
			</el-table-column>
			<el-table-column label="更新时间" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.updated_at) }}</template>
			</el-table-column>
			<el-table-column label="操作" width="100" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" @click="openEdit(row as AdminUser)">编辑</el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog v-model="createDialogVisible" title="新增管理员" width="460px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="80px">
			<el-form-item label="邮箱" prop="email">
				<el-input v-model="createForm.email" />
			</el-form-item>
			<el-form-item label="角色" prop="role">
				<el-select v-model="createForm.role" class="full-width">
					<el-option v-for="role in ROLE_OPTIONS" :key="role" :label="ADMIN_ROLE_LABEL[role]" :value="role" />
				</el-select>
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="createDialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="saving" @click="submitCreate">创建</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="editDialogVisible" :title="editTitle" width="460px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="editFormRef" :model="editForm" :rules="editRules" label-width="80px">
			<el-form-item label="邮箱">
				<el-input :model-value="editForm.email" disabled />
			</el-form-item>
			<el-form-item label="角色" prop="role">
				<el-select v-model="editForm.role" class="full-width">
					<el-option v-for="role in ROLE_OPTIONS" :key="role" :label="ADMIN_ROLE_LABEL[role]" :value="role" />
				</el-select>
			</el-form-item>
			<el-form-item label="启用" prop="enabled">
				<el-switch v-model="editForm.enabled" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="editDialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="saving" @click="submitEdit">保存</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.toolbar {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-bottom: 16px;
}

.full-width {
	width: 100%;
}
</style>
