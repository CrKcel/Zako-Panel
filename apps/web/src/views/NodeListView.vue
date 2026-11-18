<script setup lang="ts">
import type { CreateNodeEnrollmentTokenRequest, CreateNodeRequest, Node, NodeEnrollmentToken } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
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

const enrollCreateVisible = ref(false);
const enrollResultVisible = ref(false);
const enrollListVisible = ref(false);
const enrollToken = ref('');
const enrollTokens = ref<NodeEnrollmentToken[]>([]);
const enrollTokensLoading = ref(false);
const enrollForm = ref<{
	name_prefix: string;
	default_sni: string;
	default_port: number;
	default_fingerprint: NonNullable<CreateNodeEnrollmentTokenRequest['default_fingerprint']>;
	heartbeat_interval_seconds: number;
}>({
	name_prefix: '',
	default_sni: 'www.microsoft.com',
	default_port: 443,
	default_fingerprint: 'chrome',
	heartbeat_interval_seconds: 300,
});

const panelOrigin = computed(() => (typeof window !== 'undefined' ? window.location.origin : 'https://panel.example.com'));
const enrollCommand = computed(
	() => `curl -fsSL ${panelOrigin.value}/dl/agent/install.sh | sudo bash -s -- --panel ${panelOrigin.value} --token ${enrollToken.value}`,
);

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

function openEnrollCreate(): void {
	enrollForm.value = {
		name_prefix: '',
		default_sni: 'www.microsoft.com',
		default_port: 443,
		default_fingerprint: 'chrome',
		heartbeat_interval_seconds: 300,
	};
	enrollCreateVisible.value = true;
}

const createEnrollAction = useAsyncAction(
	async () => {
		const payload: CreateNodeEnrollmentTokenRequest = {
			default_sni: enrollForm.value.default_sni.trim() || 'www.microsoft.com',
			default_port: enrollForm.value.default_port,
			default_fingerprint: enrollForm.value.default_fingerprint,
			heartbeat_interval_seconds: enrollForm.value.heartbeat_interval_seconds,
			ttl_seconds: 86_400,
			...(enrollForm.value.name_prefix.trim() ? { name_prefix: enrollForm.value.name_prefix.trim() } : {}),
		};
		const result = await nodesApi.createEnrollmentToken(payload);
		enrollCreateVisible.value = false;
		enrollToken.value = result.token;
		enrollResultVisible.value = true;
		showSuccess('一次性部署命令已生成（24 小时内有效）');
	},
	{ onError: (error) => showError(error, '生成部署 Token 失败') },
);

async function loadEnrollmentTokens(): Promise<void> {
	enrollTokensLoading.value = true;
	try {
		const page = await nodesApi.listEnrollmentTokens();
		enrollTokens.value = page.items;
	} catch (error) {
		showError(error, '部署 Token 加载失败');
	} finally {
		enrollTokensLoading.value = false;
	}
}

async function openEnrollList(): Promise<void> {
	enrollListVisible.value = true;
	await loadEnrollmentTokens();
}

const revokeEnrollAction = useAsyncAction(
	async (token: NodeEnrollmentToken) => {
		await nodesApi.revokeEnrollmentToken(token.id);
		showSuccess('部署 Token 已作废');
		await loadEnrollmentTokens();
	},
	{ onError: (error) => showError(error, '作废 Token 失败') },
);

async function revokeEnrollToken(token: NodeEnrollmentToken): Promise<void> {
	if (!(await confirmAction('确定作废该一次性部署 Token？'))) return;
	await revokeEnrollAction.runFor(token.id, token);
}

function enrollStatusTag(status: NodeEnrollmentToken['status']): { label: string; type: 'success' | 'info' | 'warning' | 'danger' } {
	switch (status) {
		case 'active':
			return { label: '可用', type: 'success' };
		case 'used':
			return { label: '已使用', type: 'info' };
		case 'expired':
			return { label: '已过期', type: 'warning' };
		case 'revoked':
			return { label: '已作废', type: 'danger' };
	}
}

const deleteDialogVisible = ref(false);
const deletingNode = ref<Node | null>(null);
const deleteForce = ref(false);
const deleteRemoveXray = ref(false);

function openDeleteDialog(node: Node): void {
	deletingNode.value = node;
	deleteForce.value = node.status === 'uninstalling' || node.last_seen_at === null;
	deleteRemoveXray.value = false;
	deleteDialogVisible.value = true;
}

const deleteAction = useAsyncAction(
	async () => {
		const target = deletingNode.value;
		if (!target) return;
		const res = await nodesApi.remove(target.id, {
			force: deleteForce.value,
			removeXray: deleteRemoveXray.value,
		});
		deleteDialogVisible.value = false;
		if (res) {
			showSuccess('已下发远程卸载指令，等待节点确认');
		} else {
			showSuccess('节点已删除');
		}
		await reload();
	},
	{ onError: (error) => showError(error, '删除节点失败') },
);

async function submitDeleteNode(): Promise<void> {
	if (!deletingNode.value) return;
	await deleteAction.runFor(deletingNode.value.id);
}
</script>

<template>
	<el-card shadow="never">
		<PageToolbar>
			<el-button :loading="loading" @click="refresh">刷新</el-button>
			<el-button @click="openEnrollList">部署 Token</el-button>
			<el-button type="primary" @click="openEnrollCreate">一键部署节点</el-button>
			<el-button @click="openCreate">手动创建节点</el-button>
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
			<el-table-column label="操作" width="290" fixed="right">
				<template #default="{ row }">
					<RouterLink :to="`/nodes/${row.id}`" custom v-slot="{ navigate }">
						<el-button link type="primary" @click="navigate">详情</el-button>
					</RouterLink>
					<el-button link type="primary" @click="openEdit(row.id)">编辑</el-button>
					<el-button
						link
						type="primary"
						:disabled="row.status === 'uninstalling'"
						:loading="rotateAction.isRunning(row.id)"
						@click="rotateAgentToken(row as Node)"
					>
						轮换 Token
					</el-button>
					<el-button link type="danger" :loading="deleteAction.isRunning(row.id)" @click="openDeleteDialog(row as Node)">
						{{ row.status === 'uninstalling' ? '强制删除' : '删除' }}
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

	<el-dialog v-model="enrollCreateVisible" title="一键部署节点" width="540px" :close-on-click-modal="false" destroy-on-close>
		<el-form :model="enrollForm" label-width="120px">
			<el-form-item label="名称前缀">
				<el-input v-model="enrollForm.name_prefix" placeholder="可选，如 edge（留空则使用服务器主机名）" />
			</el-form-item>
			<el-form-item label="默认 SNI">
				<el-input v-model="enrollForm.default_sni" placeholder="www.microsoft.com" />
			</el-form-item>
			<el-form-item label="默认端口">
				<el-input-number v-model="enrollForm.default_port" :min="1" :max="65535" />
			</el-form-item>
			<el-form-item label="Fingerprint">
				<el-select v-model="enrollForm.default_fingerprint">
					<el-option v-for="fp in ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random']" :key="fp" :label="fp" :value="fp" />
				</el-select>
			</el-form-item>
			<el-form-item label="心跳间隔 (s)">
				<el-input-number v-model="enrollForm.heartbeat_interval_seconds" :min="60" :max="900" :step="30" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="enrollCreateVisible = false">取消</el-button>
			<el-button type="primary" :loading="createEnrollAction.isRunning('create')" @click="createEnrollAction.runFor('create')"
				>生成部署命令</el-button
			>
		</template>
	</el-dialog>

	<el-dialog v-model="enrollResultVisible" title="节点一键部署命令" width="680px" :close-on-click-modal="false" destroy-on-close>
		<el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
			该一次性 Token 仅展示一次，默认 24 小时有效且使用一次后立即失效。执行后将自动安装缺失的 Xray、生成 REALITY 密钥并注册上线。
		</el-alert>
		<el-input :model-value="enrollCommand" type="textarea" :rows="3" readonly />
		<div style="margin-top: 12px; display: flex; justify-content: flex-end; gap: 8px">
			<el-button type="primary" @click="copyText(enrollCommand)">复制命令</el-button>
		</div>
	</el-dialog>

	<el-dialog v-model="enrollListVisible" title="一次性部署 Token" width="760px" destroy-on-close>
		<el-table v-loading="enrollTokensLoading" :data="enrollTokens" empty-text="暂无部署 Token">
			<el-table-column label="状态" width="90">
				<template #default="{ row }">
					<el-tag :type="enrollStatusTag(row.status).type" disable-transitions>
						{{ enrollStatusTag(row.status).label }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="名称前缀" width="110">
				<template #default="{ row }">{{ row.name_prefix ?? '—' }}</template>
			</el-table-column>
			<el-table-column label="默认 SNI / 端口" min-width="180">
				<template #default="{ row }">{{ row.default_sni }}:{{ row.default_port }}</template>
			</el-table-column>
			<el-table-column label="过期时间" width="170">
				<template #default="{ row }">{{ formatTimestamp(row.expires_at) }}</template>
			</el-table-column>
			<el-table-column label="操作" width="90" fixed="right">
				<template #default="{ row }">
					<el-button
						v-if="row.status === 'active'"
						link
						type="danger"
						:loading="revokeEnrollAction.isRunning(row.id)"
						@click="revokeEnrollToken(row as NodeEnrollmentToken)"
					>
						作废
					</el-button>
					<span v-else>—</span>
				</template>
			</el-table-column>
		</el-table>
	</el-dialog>

	<el-dialog v-model="deleteDialogVisible" title="删除节点" width="480px" destroy-on-close>
		<p>
			确认删除节点「<strong>{{ deletingNode?.name }}</strong
			>」？该操作不可恢复。
		</p>
		<el-form label-width="180px" style="margin-top: 16px">
			<el-form-item v-if="deletingNode?.last_seen_at !== null && deletingNode?.status !== 'uninstalling'" label="仅从面板强制删除">
				<el-switch v-model="deleteForce" />
			</el-form-item>
			<el-form-item v-if="!deleteForce" label="同时卸载 Xray-core">
				<el-switch v-model="deleteRemoveXray" />
			</el-form-item>
		</el-form>
		<el-alert
			v-if="!deleteForce"
			type="info"
			:closable="false"
			show-icon
			title="节点将在下次心跳时收到卸载指令，自动停止并清理本机 Agent 后从面板移除。"
		/>
		<el-alert v-else type="warning" :closable="false" show-icon title="将立即从控制面板删除该节点记录，不会等待节点回传卸载确认。" />
		<template #footer>
			<el-button @click="deleteDialogVisible = false">取消</el-button>
			<el-button type="danger" :loading="deletingNode ? deleteAction.isRunning(deletingNode.id) : false" @click="submitDeleteNode">
				{{ deleteForce ? '强制删除' : '确认卸载并删除' }}
			</el-button>
		</template>
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
