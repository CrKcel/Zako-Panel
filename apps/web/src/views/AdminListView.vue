<script setup lang="ts">
import type { AdminRole, AdminUser, CreateAdminRequest, UpdateAdminRequest } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
import { adminsApi } from '../api/admins';
import PageToolbar from '../components/PageToolbar.vue';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import { adminRoleDescriptor } from '../domain/status';
import { showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

interface AdminForm {
	email: string;
	role: AdminRole;
	enabled: boolean;
}

const ROLE_OPTIONS: AdminRole[] = ['owner', 'admin', 'viewer'];

function emptyAdminForm(): AdminForm {
	return { email: '', role: 'admin', enabled: true };
}

const createForm = ref<AdminForm>(emptyAdminForm());
const editForm = ref<AdminForm>(emptyAdminForm());
const createFormRef = ref<FormInstance>();
const editFormRef = ref<FormInstance>();

const {
	data: admins,
	loading,
	reload,
} = useAsyncResource<AdminUser[]>(() => adminsApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, '管理员加载失败'),
});

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

const {
	visible: createVisible,
	submitting: createSubmitting,
	openCreate,
	close: closeCreate,
	submit: submitCreateTask,
} = useCrudDialog({
	reset: () => {
		createForm.value = emptyAdminForm();
	},
});

const {
	visible: editVisible,
	editingId: editingAdminId,
	submitting: editSubmitting,
	openEdit,
	close: closeEdit,
	submit: submitEditTask,
} = useCrudDialog({
	load: (id) => {
		const admin = admins.value.find((item) => item.id === id);
		if (admin === undefined) return;
		editForm.value = { email: admin.email, role: admin.role, enabled: admin.enabled };
	},
});

async function submitCreate(): Promise<void> {
	if (!(await createFormRef.value?.validate().catch(() => false))) return;
	const payload: CreateAdminRequest = {
		email: createForm.value.email.trim(),
		role: createForm.value.role,
	};
	const saved = await submitCreateTask(
		async () => {
			await adminsApi.create(payload);
			closeCreate();
			showSuccess('管理员已创建');
		},
		(error) => showError(error, '管理员创建失败'),
	);
	if (saved) await reload();
}

async function submitEdit(): Promise<void> {
	const adminId = editingAdminId.value;
	if (adminId === null) return;
	if (!(await editFormRef.value?.validate().catch(() => false))) return;
	const payload: UpdateAdminRequest = { role: editForm.value.role, enabled: editForm.value.enabled };
	const saved = await submitEditTask(
		async () => {
			await adminsApi.update(adminId, payload);
			closeEdit();
			showSuccess('管理员已更新');
		},
		(error) => showError(error, '管理员更新失败'),
	);
	if (saved) await reload();
}
</script>

<template>
	<el-card shadow="never">
		<PageToolbar>
			<el-button :loading="loading" @click="reload">刷新</el-button>
			<el-button type="primary" @click="openCreate">新增管理员</el-button>
		</PageToolbar>
		<el-table v-loading="loading" :data="admins" empty-text="暂无数据">
			<el-table-column prop="email" label="邮箱" min-width="260" />
			<el-table-column label="角色" width="110">
				<template #default="{ row }">
					<el-tag :type="adminRoleDescriptor(row.role as AdminRole).tag" disable-transitions>
						{{ adminRoleDescriptor(row.role as AdminRole).label }}
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
					<el-button link type="primary" @click="openEdit(row.id)">编辑</el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog v-model="createVisible" title="新增管理员" width="460px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="80px">
			<el-form-item label="邮箱" prop="email">
				<el-input v-model="createForm.email" />
			</el-form-item>
			<el-form-item label="角色" prop="role">
				<el-select v-model="createForm.role" class="full-width">
					<el-option v-for="role in ROLE_OPTIONS" :key="role" :label="adminRoleDescriptor(role).label" :value="role" />
				</el-select>
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="closeCreate">取消</el-button>
			<el-button type="primary" :loading="createSubmitting" @click="submitCreate">创建</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="editVisible" :title="editTitle" width="460px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="editFormRef" :model="editForm" :rules="editRules" label-width="80px">
			<el-form-item label="邮箱">
				<el-input :model-value="editForm.email" disabled />
			</el-form-item>
			<el-form-item label="角色" prop="role">
				<el-select v-model="editForm.role" class="full-width">
					<el-option v-for="role in ROLE_OPTIONS" :key="role" :label="adminRoleDescriptor(role).label" :value="role" />
				</el-select>
			</el-form-item>
			<el-form-item label="启用" prop="enabled">
				<el-switch v-model="editForm.enabled" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="closeEdit">取消</el-button>
			<el-button type="primary" :loading="editSubmitting" @click="submitEdit">保存</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.full-width {
	width: 100%;
}
</style>
