<script setup lang="ts">
import type { ClashPreview, DistributionSkipReason, Node, Profile } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { ref } from 'vue';
import { nodesApi } from '../api/nodes';
import { profilesApi } from '../api/profiles';
import PageToolbar from '../components/PageToolbar.vue';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import {
	buildProfilePayload,
	emptyProfileForm,
	profileFormFrom,
	type ProfileFormError,
	type ProfileFormState,
} from '../domain/profile-form';
import { distributionSkipReasonLabel, subscriberBlockReasonLabel } from '../domain/status';
import { confirmAction, showError, showSuccess, showValidationError } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

const PARSE_ERROR_MESSAGE: Record<ProfileFormError, string> = {
	clash_base: 'clash_base 必须是合法的 JSON 对象',
	proxy_groups: 'proxy_groups 必须是合法的 JSON 数组',
};

const form = ref<ProfileFormState>(emptyProfileForm());
const formRef = ref<FormInstance>();
const previewVisible = ref(false);
const preview = ref<ClashPreview | null>(null);
const previewName = ref('');

const {
	data: profiles,
	loading,
	reload,
} = useAsyncResource<Profile[]>(() => profilesApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, '订阅档案加载失败'),
});

const { data: nodes } = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, '节点加载失败'),
});

const rules: FormRules = {
	name: [{ required: true, message: '请输入档案名称', trigger: 'blur' }],
};

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
		form.value = emptyProfileForm();
	},
	load: async (id) => {
		form.value = profileFormFrom(await profilesApi.get(id));
	},
	onError: (error) => showError(error, '订阅档案加载失败'),
});

async function submit(): Promise<void> {
	if (!(await formRef.value?.validate().catch(() => false))) return;
	const result = buildProfilePayload(form.value);
	if (!result.ok) {
		showValidationError(PARSE_ERROR_MESSAGE[result.error]);
		return;
	}
	const profileId = editingId.value;
	const saved = await submitDialog(
		async () => {
			if (profileId === null) {
				await profilesApi.create(result.payload);
				showSuccess('订阅档案已创建');
			} else {
				await profilesApi.update(profileId, result.payload);
				showSuccess('订阅档案已更新');
			}
			closeDialog();
		},
		(error) => showError(error, '订阅档案保存失败'),
	);
	if (saved) await reload();
}

const { running: previewLoading, run: runPreview } = useAsyncAction(
	async (profile: Profile) => {
		preview.value = await profilesApi.preview(profile.id);
	},
	{
		onError: (error) => {
			previewVisible.value = false;
			showError(error, '预览失败');
		},
	},
);

async function openPreview(profile: Profile): Promise<void> {
	previewName.value = profile.name;
	preview.value = null;
	previewVisible.value = true;
	await runPreview(profile);
}

const removeAction = useAsyncAction(
	async (profile: Profile) => {
		await profilesApi.remove(profile.id);
		showSuccess('订阅档案已删除');
		await reload();
	},
	{ onError: (error) => showError(error, '订阅档案删除失败') },
);

async function remove(profile: Profile): Promise<void> {
	if (!(await confirmAction(`删除订阅档案「${profile.name}」？`))) return;
	await removeAction.run(profile);
}
</script>

<template>
	<el-card shadow="never">
		<PageToolbar>
			<el-button :loading="loading" @click="reload">刷新</el-button>
			<el-button type="primary" @click="openCreate">创建档案</el-button>
		</PageToolbar>
		<el-table v-loading="loading" :data="profiles" empty-text="暂无数据">
			<el-table-column prop="name" label="名称" min-width="160" />
			<el-table-column label="描述" min-width="200">
				<template #default="{ row }">{{ row.description ?? '—' }}</template>
			</el-table-column>
			<el-table-column label="节点选择" width="110">
				<template #default="{ row }">{{ row.node_selection === 'all' ? '全部' : '指定' }}</template>
			</el-table-column>
			<el-table-column label="在线过滤" width="100">
				<template #default="{ row }">{{ row.online_only ? '启用' : '关闭' }}</template>
			</el-table-column>
			<el-table-column label="代理组" width="90">
				<template #default="{ row }">{{ row.proxy_groups.length }}</template>
			</el-table-column>
			<el-table-column label="规则数" width="90">
				<template #default="{ row }">{{ row.rules.length }}</template>
			</el-table-column>
			<el-table-column label="修订" width="80">
				<template #default="{ row }">{{ row.revision }}</template>
			</el-table-column>
			<el-table-column label="更新时间" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.updated_at) }}</template>
			</el-table-column>
			<el-table-column label="操作" width="190" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" @click="openPreview(row as Profile)">预览</el-button>
					<el-button link type="primary" @click="openEdit(row.id)">编辑</el-button>
					<el-button link type="danger" @click="remove(row as Profile)">删除</el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog
		v-model="dialogVisible"
		:title="editingId === null ? '创建档案' : '编辑档案'"
		width="720px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
			<el-form-item label="名称" prop="name">
				<el-input v-model="form.name" />
			</el-form-item>
			<el-form-item label="描述" prop="description">
				<el-input v-model="form.description" />
			</el-form-item>
			<el-form-item label="节点选择" prop="node_selection">
				<el-radio-group v-model="form.node_selection">
					<el-radio value="all">全部</el-radio>
					<el-radio value="selected">指定</el-radio>
				</el-radio-group>
			</el-form-item>
			<el-form-item v-if="form.node_selection === 'selected'" label="节点" prop="node_ids">
				<el-select v-model="form.node_ids" multiple filterable class="full-width">
					<el-option v-for="node in nodes" :key="node.id" :label="node.name" :value="node.id" />
				</el-select>
			</el-form-item>
			<el-form-item label="在线过滤" prop="online_only">
				<el-switch v-model="form.online_only" />
			</el-form-item>
			<el-form-item label="clash_base" prop="clash_base">
				<el-input v-model="form.clash_base" type="textarea" :rows="5" />
			</el-form-item>
			<el-form-item label="proxy_groups" prop="proxy_groups">
				<el-input v-model="form.proxy_groups" type="textarea" :rows="6" />
			</el-form-item>
			<el-form-item label="rules" prop="rules">
				<el-input v-model="form.rules" type="textarea" :rows="6" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="closeDialog">取消</el-button>
			<el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="previewVisible" :title="`Clash 预览 · ${previewName}`" width="820px" destroy-on-close>
		<div v-loading="previewLoading">
			<template v-if="preview">
				<el-alert
					v-if="preview.subscriber.blocked_reason !== null"
					:title="`订阅用户当前不可用：${subscriberBlockReasonLabel(preview.subscriber.blocked_reason)}`"
					type="warning"
					:closable="false"
					show-icon
					class="preview-alert"
				/>
				<el-descriptions :column="3" border size="small">
					<el-descriptions-item label="订阅用户">{{ preview.subscriber.name }}</el-descriptions-item>
					<el-descriptions-item label="节点数">{{ preview.proxies.length }}</el-descriptions-item>
					<el-descriptions-item label="跳过节点">{{ preview.skipped.length }}</el-descriptions-item>
				</el-descriptions>
				<el-input class="preview-document" type="textarea" :model-value="preview.document" :rows="16" readonly />
				<el-table v-if="preview.skipped.length > 0" :data="preview.skipped" size="small" class="preview-skipped">
					<el-table-column prop="node_name" label="节点" min-width="160" />
					<el-table-column label="原因" min-width="160">
						<template #default="{ row }">{{ distributionSkipReasonLabel(row.reason as DistributionSkipReason) }}</template>
					</el-table-column>
				</el-table>
			</template>
		</div>
	</el-dialog>
</template>

<style scoped>
.preview-alert {
	margin-bottom: 12px;
}

.preview-document {
	margin: 12px 0;
}

.preview-skipped {
	margin-top: 4px;
}

.full-width {
	width: 100%;
}
</style>
