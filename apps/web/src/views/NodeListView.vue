<script setup lang="ts">
import type { CreateNodeRequest, Node } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import EndpointFormFields from '../components/EndpointFormFields.vue';
import PageToolbar from '../components/PageToolbar.vue';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import { usePolling } from '../composables/usePolling';
import { emptyEndpointFormValue, endpointRequestBody, type EndpointFormValue } from '../domain/endpoint-form';
import { nodeStatusDescriptor } from '../domain/status';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatPercent, formatTimestamp } from '../utils/format';

interface CreateForm {
	name: string;
	heartbeat_interval_seconds: number;
	endpoint: EndpointFormValue;
}

interface EditForm {
	name: string;
	heartbeat_interval_seconds: number;
	enabled: boolean;
}

function emptyCreateForm(): CreateForm {
	return {
		name: '',
		heartbeat_interval_seconds: 300,
		endpoint: emptyEndpointFormValue(),
	};
}

const createForm = ref<CreateForm>(emptyCreateForm());
const editForm = ref<EditForm>({ name: '', heartbeat_interval_seconds: 300, enabled: true });
const createFormRef = ref<FormInstance>();
const editFormRef = ref<FormInstance>();
const agentToken = ref('');
const tokenVisible = ref(false);

const {
	data: nodes,
	loading,
	reload,
} = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	immediate: false,
	initialValue: [],
	onError: (error) => showError(error, '节点加载失败'),
});

const { refresh } = usePolling(reload, 30_000);

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

const {
	visible: createVisible,
	submitting: creating,
	openCreate,
	close: closeCreate,
	submit: submitCreateTask,
} = useCrudDialog({
	reset: () => {
		createForm.value = emptyCreateForm();
	},
});

const {
	visible: editVisible,
	editingId,
	submitting: saving,
	openEdit,
	close: closeEdit,
	submit: submitEditTask,
} = useCrudDialog({
	load: (id) => {
		const node = nodes.value.find((item) => item.id === id);
		if (node === undefined) return;
		editForm.value = {
			name: node.name,
			heartbeat_interval_seconds: node.heartbeat_interval_seconds,
			enabled: node.enabled,
		};
	},
});

async function submitCreate(): Promise<void> {
	if (!(await createFormRef.value?.validate().catch(() => false))) return;
	const request: CreateNodeRequest = {
		name: createForm.value.name,
		heartbeat_interval_seconds: createForm.value.heartbeat_interval_seconds,
		endpoint: endpointRequestBody(createForm.value.endpoint),
	};
	const saved = await submitCreateTask(
		async () => {
			const result = await nodesApi.create(request);
			closeCreate();
			agentToken.value = result.agent_token;
			tokenVisible.value = true;
			showSuccess('节点已创建');
		},
		(error) => showError(error, '节点创建失败'),
	);
	if (saved) await reload();
}

async function submitEdit(): Promise<void> {
	const nodeId = editingId.value;
	if (nodeId === null) return;
	if (!(await editFormRef.value?.validate().catch(() => false))) return;
	const saved = await submitEditTask(
		async () => {
			await nodesApi.update(nodeId, {
				name: editForm.value.name,
				heartbeat_interval_seconds: editForm.value.heartbeat_interval_seconds,
				enabled: editForm.value.enabled,
			});
			closeEdit();
			showSuccess('节点已更新');
		},
		(error) => showError(error, '节点更新失败'),
	);
	if (saved) await reload();
}

const rotateAction = useAsyncAction(
	async (node: Node) => {
		const result = await nodesApi.rotateAgentToken(node.id);
		agentToken.value = result.agent_token;
		tokenVisible.value = true;
		showSuccess('Agent token 已轮换');
	},
	{ onError: (error) => showError(error, 'Agent token 轮换失败') },
);

async function rotateAgentToken(node: Node): Promise<void> {
	if (!(await confirmAction(`轮换「${node.name}」的 Agent token？`))) return;
	await rotateAction.runFor(node.id, node);
}
</script>

<template>
	<el-card shadow="never">
		<PageToolbar>
			<el-button :loading="loading" @click="refresh">刷新</el-button>
			<el-button type="primary" @click="openCreate">创建节点</el-button>
		</PageToolbar>
		<el-table v-loading="loading" :data="nodes" empty-text="暂无数据">
			<el-table-column label="名称" min-width="180">
				<template #default="{ row }">
					<RouterLink :to="`/nodes/${row.id}`" class="node-link">{{ row.name }}</RouterLink>
				</template>
			</el-table-column>
			<el-table-column label="状态" width="100">
				<template #default="{ row }">
					<el-tag :type="nodeStatusDescriptor(row.status as Node['status']).tag" disable-transitions>
						{{ nodeStatusDescriptor(row.status as Node['status']).label }}
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
			<el-table-column label="CPU" width="90">
				<template #default="{ row }">{{ formatPercent(row.sys?.cpu) }}</template>
			</el-table-column>
			<el-table-column label="内存" width="90">
				<template #default="{ row }">{{ formatPercent(row.sys?.mem) }}</template>
			</el-table-column>
			<el-table-column label="负载" width="90">
				<template #default="{ row }">{{ row.sys ? row.sys.load.toFixed(2) : '—' }}</template>
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
					<el-button link type="primary" @click="openEdit(row.id)">编辑</el-button>
					<el-button link type="primary" :loading="rotateAction.isRunning(row.id)" @click="rotateAgentToken(row as Node)">
						轮换 Token
					</el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog v-model="createVisible" title="创建节点" width="640px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="140px">
			<el-form-item label="名称" prop="name">
				<el-input v-model="createForm.name" placeholder="节点名称" />
			</el-form-item>
			<el-form-item label="心跳间隔" prop="heartbeat_interval_seconds">
				<el-input-number v-model="createForm.heartbeat_interval_seconds" :min="60" :max="900" :step="30" />
			</el-form-item>
			<EndpointFormFields
				v-model="createForm.endpoint"
				prop-prefix="endpoint."
				name-label="端点名称"
				address-placeholder="203.0.113.10"
				sni-placeholder="www.example.com"
			/>
		</el-form>
		<template #footer>
			<el-button @click="closeCreate">取消</el-button>
			<el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="editVisible" title="编辑节点" width="520px" :close-on-click-modal="false" destroy-on-close>
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
			<el-button @click="closeEdit">取消</el-button>
			<el-button type="primary" :loading="saving" @click="submitEdit">保存</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="tokenVisible" title="Agent Token" width="560px" :close-on-click-modal="false" destroy-on-close>
		<el-input :model-value="agentToken" readonly>
			<template #append>
				<el-button @click="copyText(agentToken)">复制</el-button>
			</template>
		</el-input>
	</el-dialog>
</template>

<style scoped>
.node-link {
	color: #2563eb;
	text-decoration: none;
}

.node-link:hover {
	text-decoration: underline;
}
</style>
