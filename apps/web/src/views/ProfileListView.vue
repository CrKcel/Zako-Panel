<script setup lang="ts">
import type {
	ClashPreview,
	CreateProfileRequest,
	DistributionSkipReason,
	Node,
	Profile,
	ProxyGroup,
	UpdateProfileRequest,
} from '@zako/contracts';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { onMounted, ref } from 'vue';
import { nodesApi } from '../api/nodes';
import { profilesApi } from '../api/profiles';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

interface ProfileForm {
	name: string;
	description: string;
	node_selection: 'all' | 'selected';
	node_ids: string[];
	online_only: boolean;
	clash_base: string;
	proxy_groups: string;
	rules: string;
}

const SKIP_REASON_LABEL: Record<DistributionSkipReason, string> = {
	disabled: '节点停用',
	offline: '心跳过期',
	unhealthy: 'Xray 不健康',
	not_selected: '未在档案选择中',
	no_endpoint: '无可用端点',
};

const BLOCK_REASON_LABEL: Record<NonNullable<ClashPreview['subscriber']['blocked_reason']>, string> = {
	inactive: '用户未启用',
	expired: '用户已到期',
	over_quota: '流量已超额',
};

const profiles = ref<Profile[]>([]);
const nodes = ref<Node[]>([]);
const loading = ref(true);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const formRef = ref<FormInstance>();
const previewVisible = ref(false);
const previewLoading = ref(false);
const preview = ref<ClashPreview | null>(null);
const previewName = ref('');

function emptyForm(): ProfileForm {
	return {
		name: '',
		description: '',
		node_selection: 'all',
		node_ids: [],
		online_only: true,
		clash_base: '{}',
		proxy_groups: '[]',
		rules: '',
	};
}

const form = ref<ProfileForm>(emptyForm());

const rules: FormRules = {
	name: [{ required: true, message: '请输入档案名称', trigger: 'blur' }],
};

async function load(): Promise<void> {
	loading.value = true;
	try {
		const page = await profilesApi.list({ limit: 200 });
		profiles.value = page.items;
	} catch (error) {
		showError(error, '订阅档案加载失败');
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

async function openEdit(profile: Profile): Promise<void> {
	try {
		const detail = await profilesApi.get(profile.id);
		editingId.value = profile.id;
		form.value = {
			name: detail.name,
			description: detail.description ?? '',
			node_selection: detail.node_selection,
			node_ids: detail.node_ids,
			online_only: detail.online_only,
			clash_base: JSON.stringify(detail.clash_base, null, 2),
			proxy_groups: JSON.stringify(detail.proxy_groups, null, 2),
			rules: detail.rules.join('\n'),
		};
		dialogVisible.value = true;
	} catch (error) {
		showError(error, '订阅档案加载失败');
	}
}

function parseClashBase(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text || '{}');
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function parseProxyGroups(text: string): ProxyGroup[] | null {
	try {
		const parsed: unknown = JSON.parse(text || '[]');
		if (!Array.isArray(parsed)) return null;
		return parsed as ProxyGroup[];
	} catch {
		return null;
	}
}

async function submit(): Promise<void> {
	const valid = await formRef.value?.validate().catch(() => false);
	if (!valid) return;

	const clashBase = parseClashBase(form.value.clash_base);
	if (clashBase === null) {
		ElMessage.error('clash_base 必须是合法的 JSON 对象');
		return;
	}
	const proxyGroups = parseProxyGroups(form.value.proxy_groups);
	if (proxyGroups === null) {
		ElMessage.error('proxy_groups 必须是合法的 JSON 数组');
		return;
	}

	const payload: CreateProfileRequest & UpdateProfileRequest = {
		name: form.value.name,
		description: form.value.description.trim() === '' ? null : form.value.description.trim(),
		node_selection: form.value.node_selection,
		online_only: form.value.online_only,
		clash_base: clashBase,
		proxy_groups: proxyGroups,
		rules: form.value.rules
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0),
		node_ids: form.value.node_selection === 'selected' ? form.value.node_ids : [],
	};

	saving.value = true;
	try {
		if (editingId.value === null) {
			await profilesApi.create(payload);
			showSuccess('订阅档案已创建');
		} else {
			await profilesApi.update(editingId.value, payload);
			showSuccess('订阅档案已更新');
		}
		dialogVisible.value = false;
		await load();
	} catch (error) {
		showError(error, '订阅档案保存失败');
	} finally {
		saving.value = false;
	}
}

async function openPreview(profile: Profile): Promise<void> {
	previewName.value = profile.name;
	preview.value = null;
	previewVisible.value = true;
	previewLoading.value = true;
	try {
		preview.value = await profilesApi.preview(profile.id);
	} catch (error) {
		previewVisible.value = false;
		showError(error, '预览失败');
	} finally {
		previewLoading.value = false;
	}
}

async function remove(profile: Profile): Promise<void> {
	const confirmed = await confirmAction(`删除订阅档案「${profile.name}」？`);
	if (!confirmed) return;
	try {
		await profilesApi.remove(profile.id);
		showSuccess('订阅档案已删除');
		await load();
	} catch (error) {
		showError(error, '订阅档案删除失败');
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
			<el-button type="primary" @click="openCreate">创建档案</el-button>
		</div>
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
					<el-button link type="primary" @click="openEdit(row as Profile)">编辑</el-button>
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
			<el-button @click="dialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="saving" @click="submit">保存</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="previewVisible" :title="`Clash 预览 · ${previewName}`" width="820px" destroy-on-close>
		<div v-loading="previewLoading">
			<template v-if="preview">
				<el-alert
					v-if="preview.subscriber.blocked_reason !== null"
					:title="`订阅用户当前不可用：${BLOCK_REASON_LABEL[preview.subscriber.blocked_reason]}`"
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
						<template #default="{ row }">{{ SKIP_REASON_LABEL[row.reason as DistributionSkipReason] }}</template>
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
