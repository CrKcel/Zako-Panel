<script setup lang="ts">
import type { CreateNodeRequest, Node } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatTimestamp, NODE_STATUS_LABEL, NODE_STATUS_TAG } from '../utils/format';

interface EndpointForm {
	name: string;
	host: string;
	port: number;
	sni: string;
	public_key: string;
	short_id: string;
	fingerprint: string;
	flow: 'xtls-rprx-vision';
	network: 'tcp';
}

interface CreateForm {
	name: string;
	heartbeat_interval_seconds: number;
	endpoint: EndpointForm;
}

interface EditForm {
	id: string;
	name: string;
	heartbeat_interval_seconds: number;
	enabled: boolean;
}

const nodes = ref<Node[]>([]);
const loading = ref(true);
const creating = ref(false);
const saving = ref(false);
const rotatingId = ref<string | null>(null);

const createDialogVisible = ref(false);
const editDialogVisible = ref(false);
const tokenDialogVisible = ref(false);
const agentToken = ref('');
const createFormRef = ref<FormInstance>();
const editFormRef = ref<FormInstance>();

function emptyCreateForm(): CreateForm {
	return {
		name: '',
		heartbeat_interval_seconds: 300,
		endpoint: {
			name: 'default',
			host: '',
			port: 443,
			sni: '',
			public_key: '',
			short_id: '',
			fingerprint: 'chrome',
			flow: 'xtls-rprx-vision',
			network: 'tcp',
		},
	};
}

const createForm = ref<CreateForm>(emptyCreateForm());
const editForm = ref<EditForm>({ id: '', name: '', heartbeat_interval_seconds: 300, enabled: true });

const required = (message: string): { required: true; message: string; trigger: 'blur' } => ({
	required: true,
	message,
	trigger: 'blur',
});

const createRules: FormRules = {
	name: [required('请输入节点名称')],
	'endpoint.name': [required('请输入端点名称')],
	'endpoint.host': [required('请输入地址')],
	'endpoint.sni': [required('请输入 SNI')],
	'endpoint.public_key': [required('请输入 Public Key')],
};

const editRules: FormRules = {
	name: [required('请输入节点名称')],
};

async function load(): Promise<void> {
	loading.value = true;
	try {
		const page = await nodesApi.list({ limit: 200 });
		nodes.value = page.items;
	} catch (error) {
		showError(error, '节点加载失败');
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
	creating.value = true;
	try {
		const request: CreateNodeRequest = {
			name: createForm.value.name,
			heartbeat_interval_seconds: createForm.value.heartbeat_interval_seconds,
			endpoint: {
				name: createForm.value.endpoint.name,
				host: createForm.value.endpoint.host,
				port: createForm.value.endpoint.port,
				params: {
					sni: createForm.value.endpoint.sni,
					public_key: createForm.value.endpoint.public_key,
					short_id: createForm.value.endpoint.short_id,
					fingerprint: createForm.value.endpoint.fingerprint,
					flow: createForm.value.endpoint.flow,
					network: createForm.value.endpoint.network,
				},
			},
		};
		const result = await nodesApi.create(request);
		createDialogVisible.value = false;
		agentToken.value = result.agent_token;
		tokenDialogVisible.value = true;
		showSuccess('节点已创建');
		await load();
	} catch (error) {
		showError(error, '节点创建失败');
	} finally {
		creating.value = false;
	}
}

function openEdit(node: Node): void {
	editForm.value = {
		id: node.id,
		name: node.name,
		heartbeat_interval_seconds: node.heartbeat_interval_seconds,
		enabled: node.enabled,
	};
	editDialogVisible.value = true;
}

async function submitEdit(): Promise<void> {
	const valid = await editFormRef.value?.validate().catch(() => false);
	if (!valid) return;
	saving.value = true;
	try {
		await nodesApi.update(editForm.value.id, {
			name: editForm.value.name,
			heartbeat_interval_seconds: editForm.value.heartbeat_interval_seconds,
			enabled: editForm.value.enabled,
		});
		editDialogVisible.value = false;
		showSuccess('节点已更新');
		await load();
	} catch (error) {
		showError(error, '节点更新失败');
	} finally {
		saving.value = false;
	}
}

async function rotateAgentToken(node: Node): Promise<void> {
	const confirmed = await confirmAction(`轮换「${node.name}」的 Agent token？`);
	if (!confirmed) return;
	rotatingId.value = node.id;
	try {
		const result = await nodesApi.rotateAgentToken(node.id);
		agentToken.value = result.agent_token;
		tokenDialogVisible.value = true;
		showSuccess('Agent token 已轮换');
	} catch (error) {
		showError(error, 'Agent token 轮换失败');
	} finally {
		rotatingId.value = null;
	}
}

onMounted(load);
</script>

<template>
	<el-card shadow="never">
		<div class="toolbar">
			<el-button :loading="loading" @click="load">刷新</el-button>
			<el-button type="primary" @click="openCreate">创建节点</el-button>
		</div>
		<el-table v-loading="loading" :data="nodes" empty-text="暂无数据">
			<el-table-column label="名称" min-width="180">
				<template #default="{ row }">
					<RouterLink :to="`/nodes/${row.id}`" class="node-link">{{ row.name }}</RouterLink>
				</template>
			</el-table-column>
			<el-table-column label="状态" width="100">
				<template #default="{ row }">
					<el-tag :type="NODE_STATUS_TAG[row.status as Node['status']]" disable-transitions>
						{{ NODE_STATUS_LABEL[row.status as Node['status']] }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="心跳间隔" width="110">
				<template #default="{ row }">{{ row.heartbeat_interval_seconds }}s</template>
			</el-table-column>
			<el-table-column label="最近心跳" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.last_seen_at) }}</template>
			</el-table-column>
			<el-table-column label="Agent 版本" width="130">
				<template #default="{ row }">{{ row.agent_version ?? '—' }}</template>
			</el-table-column>
			<el-table-column label="Xray 版本" width="130">
				<template #default="{ row }">{{ row.xray_version ?? '—' }}</template>
			</el-table-column>
			<el-table-column label="启用" width="90">
				<template #default="{ row }">
					<el-tag :type="row.enabled ? 'success' : 'info'" disable-transitions>
						{{ row.enabled ? '启用' : '停用' }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="操作" width="240" fixed="right">
				<template #default="{ row }">
					<RouterLink :to="`/nodes/${row.id}`" custom v-slot="{ navigate }">
						<el-button link type="primary" @click="navigate">详情</el-button>
					</RouterLink>
					<el-button link type="primary" @click="openEdit(row as Node)">编辑</el-button>
					<el-button link type="primary" :loading="rotatingId === row.id" @click="rotateAgentToken(row as Node)"> 轮换 Token </el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog v-model="createDialogVisible" title="创建节点" width="640px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="140px">
			<el-form-item label="名称" prop="name">
				<el-input v-model="createForm.name" placeholder="节点名称" />
			</el-form-item>
			<el-form-item label="心跳间隔" prop="heartbeat_interval_seconds">
				<el-input-number v-model="createForm.heartbeat_interval_seconds" :min="60" :max="900" :step="30" />
			</el-form-item>
			<el-form-item label="端点名称" prop="endpoint.name">
				<el-input v-model="createForm.endpoint.name" />
			</el-form-item>
			<el-form-item label="地址" prop="endpoint.host">
				<el-input v-model="createForm.endpoint.host" placeholder="203.0.113.10" />
			</el-form-item>
			<el-form-item label="端口" prop="endpoint.port">
				<el-input-number v-model="createForm.endpoint.port" :min="1" :max="65535" />
			</el-form-item>
			<el-form-item label="SNI" prop="endpoint.sni">
				<el-input v-model="createForm.endpoint.sni" placeholder="www.example.com" />
			</el-form-item>
			<el-form-item label="Public Key" prop="endpoint.public_key">
				<el-input v-model="createForm.endpoint.public_key" />
			</el-form-item>
			<el-form-item label="Short ID" prop="endpoint.short_id">
				<el-input v-model="createForm.endpoint.short_id" />
			</el-form-item>
			<el-form-item label="Fingerprint" prop="endpoint.fingerprint">
				<el-input v-model="createForm.endpoint.fingerprint" />
			</el-form-item>
			<el-form-item label="Flow">
				<el-input :model-value="createForm.endpoint.flow" disabled />
			</el-form-item>
			<el-form-item label="Network">
				<el-input :model-value="createForm.endpoint.network" disabled />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="createDialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="editDialogVisible" title="编辑节点" width="520px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="editFormRef" :model="editForm" :rules="editRules" label-width="120px">
			<el-form-item label="名称" prop="name">
				<el-input v-model="editForm.name" />
			</el-form-item>
			<el-form-item label="心跳间隔" prop="heartbeat_interval_seconds">
				<el-input-number v-model="editForm.heartbeat_interval_seconds" :min="60" :max="900" :step="30" />
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

	<el-dialog v-model="tokenDialogVisible" title="Agent Token" width="560px" :close-on-click-modal="false" destroy-on-close>
		<el-input :model-value="agentToken" readonly>
			<template #append>
				<el-button @click="copyText(agentToken)">复制</el-button>
			</template>
		</el-input>
	</el-dialog>
</template>

<style scoped>
.toolbar {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-bottom: 16px;
}

.node-link {
	color: #2563eb;
	text-decoration: none;
}

.node-link:hover {
	text-decoration: underline;
}
</style>
