<script setup lang="ts">
import type {
	CreateEndpointRequest,
	Endpoint,
	Node,
	NodeClient,
	NodeStatusDetail,
	TrafficSummary,
	UpdateEndpointRequest,
} from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { trafficApi } from '../api/traffic';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatBytes, formatDuration, formatPercent, formatTimestamp, NODE_STATUS_LABEL, NODE_STATUS_TAG } from '../utils/format';

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

const route = useRoute();
const router = useRouter();
const nodeId = computed(() => String(route.params.nodeId ?? ''));

const node = ref<Node | null>(null);
const status = ref<NodeStatusDetail | null>(null);
const endpoints = ref<Endpoint[]>([]);
const clients = ref<NodeClient[]>([]);
const traffic = ref<TrafficSummary | null>(null);
const loading = ref(true);
const trafficLoading = ref(true);
const saving = ref(false);
const endpointSaving = ref(false);
const endpointDialogVisible = ref(false);
const editingEndpointId = ref<string | null>(null);
const endpointFormRef = ref<FormInstance>();

function emptyEndpointForm(): EndpointForm {
	return {
		name: '',
		host: '',
		port: 443,
		sni: '',
		public_key: '',
		short_id: '',
		fingerprint: 'chrome',
		flow: 'xtls-rprx-vision',
		network: 'tcp',
	};
}

const endpointForm = ref<EndpointForm>(emptyEndpointForm());

const endpointRules: FormRules = {
	name: [{ required: true, message: '请输入端点名称', trigger: 'blur' }],
	host: [{ required: true, message: '请输入地址', trigger: 'blur' }],
	sni: [{ required: true, message: '请输入 SNI', trigger: 'blur' }],
	public_key: [{ required: true, message: '请输入 Public Key', trigger: 'blur' }],
};

const trafficTotals = computed(() => {
	const items = traffic.value?.items ?? [];
	const uplink = items.reduce((total, item) => total + item.uplink_bytes, 0);
	const downlink = items.reduce((total, item) => total + item.downlink_bytes, 0);
	return { uplink, downlink, total: uplink + downlink };
});

const sys = computed(() => node.value?.sys ?? null);

async function load(): Promise<void> {
	loading.value = true;
	try {
		const [detail, nodeStatus, nodeClients] = await Promise.all([
			nodesApi.get(nodeId.value),
			nodesApi.status(nodeId.value),
			nodesApi.listClients(nodeId.value),
		]);
		node.value = detail.node;
		endpoints.value = detail.endpoints;
		status.value = nodeStatus;
		clients.value = nodeClients;
	} catch (error) {
		showError(error, '节点加载失败');
	} finally {
		loading.value = false;
	}
}

async function loadTraffic(): Promise<void> {
	trafficLoading.value = true;
	try {
		const to = Math.floor(Date.now() / 1000);
		traffic.value = await trafficApi.summary({
			from: to - 24 * 60 * 60,
			to,
			groupBy: 'node',
			nodeId: nodeId.value,
		});
	} catch (error) {
		showError(error, '流量加载失败');
	} finally {
		trafficLoading.value = false;
	}
}

function backToList(): void {
	void router.push({ name: 'nodes' });
}

async function refresh(): Promise<void> {
	await Promise.all([load(), loadTraffic()]);
}

function openCreateEndpoint(): void {
	editingEndpointId.value = null;
	endpointForm.value = emptyEndpointForm();
	endpointDialogVisible.value = true;
}

function openEditEndpoint(endpoint: Endpoint): void {
	editingEndpointId.value = endpoint.id;
	endpointForm.value = {
		name: endpoint.name,
		host: endpoint.host,
		port: endpoint.port,
		sni: endpoint.params.sni,
		public_key: endpoint.params.public_key,
		short_id: endpoint.params.short_id,
		fingerprint: endpoint.params.fingerprint,
		flow: endpoint.params.flow,
		network: endpoint.params.network,
	};
	endpointDialogVisible.value = true;
}

async function submitEndpoint(): Promise<void> {
	const valid = await endpointFormRef.value?.validate().catch(() => false);
	if (!valid) return;
	endpointSaving.value = true;
	try {
		const params = {
			sni: endpointForm.value.sni,
			public_key: endpointForm.value.public_key,
			short_id: endpointForm.value.short_id,
			fingerprint: endpointForm.value.fingerprint,
			flow: endpointForm.value.flow,
			network: endpointForm.value.network,
		};
		if (editingEndpointId.value === null) {
			const request: CreateEndpointRequest = {
				name: endpointForm.value.name,
				host: endpointForm.value.host,
				port: endpointForm.value.port,
				params,
			};
			await nodesApi.createEndpoint(nodeId.value, request);
			showSuccess('端点已创建');
		} else {
			const request: UpdateEndpointRequest = {
				name: endpointForm.value.name,
				host: endpointForm.value.host,
				port: endpointForm.value.port,
				params,
			};
			await nodesApi.updateEndpoint(nodeId.value, editingEndpointId.value, request);
			showSuccess('端点已更新');
		}
		endpointDialogVisible.value = false;
		await load();
	} catch (error) {
		showError(error, '端点保存失败');
	} finally {
		endpointSaving.value = false;
	}
}

async function disableEndpoint(endpoint: Endpoint): Promise<void> {
	const confirmed = await confirmAction(`停用端点「${endpoint.name}」？`);
	if (!confirmed) return;
	saving.value = true;
	try {
		await nodesApi.disableEndpoint(nodeId.value, endpoint.id);
		showSuccess('端点已停用');
		await load();
	} catch (error) {
		showError(error, '端点停用失败');
	} finally {
		saving.value = false;
	}
}

async function enableEndpoint(endpoint: Endpoint): Promise<void> {
	saving.value = true;
	try {
		await nodesApi.updateEndpoint(nodeId.value, endpoint.id, { enabled: true });
		showSuccess('端点已启用');
		await load();
	} catch (error) {
		showError(error, '端点启用失败');
	} finally {
		saving.value = false;
	}
}

onMounted(async () => {
	await Promise.all([load(), loadTraffic()]);
});
</script>

<template>
	<div v-loading="loading">
		<div class="toolbar">
			<el-button @click="backToList">返回列表</el-button>
			<el-button :loading="loading" @click="refresh">刷新</el-button>
		</div>

		<el-card shadow="never" class="section">
			<template #header>
				<span class="card-title">{{ node?.name ?? '—' }}</span>
			</template>
			<el-descriptions :column="3" border>
				<el-descriptions-item label="状态">
					<el-tag v-if="node" :type="NODE_STATUS_TAG[node.status]" disable-transitions>
						{{ NODE_STATUS_LABEL[node.status] }}
					</el-tag>
					<span v-else>—</span>
				</el-descriptions-item>
				<el-descriptions-item label="心跳间隔">{{ node ? `${node.heartbeat_interval_seconds}s` : '—' }}</el-descriptions-item>
				<el-descriptions-item label="最近心跳">{{ formatTimestamp(node?.last_seen_at) }}</el-descriptions-item>
				<el-descriptions-item label="Agent 版本">{{ node?.agent_version ?? '—' }}</el-descriptions-item>
				<el-descriptions-item label="Xray 版本">{{ node?.xray_version ?? '—' }}</el-descriptions-item>
				<el-descriptions-item label="配置版本">
					{{ node ? `${node.applied_config_version} / ${node.desired_config_version}` : '—' }}
				</el-descriptions-item>
				<el-descriptions-item label="Xray 健康">
					<el-tag
						:type="status?.xray_healthy === true ? 'success' : status?.xray_healthy === false ? 'danger' : 'info'"
						disable-transitions
					>
						{{ status?.xray_healthy === true ? '正常' : status?.xray_healthy === false ? '异常' : '—' }}
					</el-tag>
				</el-descriptions-item>
				<el-descriptions-item label="统计健康">
					<el-tag
						:type="status?.stats_healthy === true ? 'success' : status?.stats_healthy === false ? 'danger' : 'info'"
						disable-transitions
					>
						{{ status?.stats_healthy === true ? '正常' : status?.stats_healthy === false ? '异常' : '—' }}
					</el-tag>
				</el-descriptions-item>
				<el-descriptions-item label="配置错误">{{ status?.last_config_error ?? '—' }}</el-descriptions-item>
			</el-descriptions>
		</el-card>

		<el-card shadow="never" class="section">
			<template #header>
				<span class="card-title">系统指标</span>
			</template>
			<div class="metric-grid">
				<div class="metric">
					<div class="metric-label">CPU</div>
					<div class="metric-value">{{ formatPercent(sys?.cpu) }}</div>
				</div>
				<div class="metric">
					<div class="metric-label">内存</div>
					<div class="metric-value">{{ formatPercent(sys?.mem) }}</div>
				</div>
				<div class="metric">
					<div class="metric-label">负载</div>
					<div class="metric-value">{{ sys ? sys.load.toFixed(2) : '—' }}</div>
				</div>
				<div class="metric">
					<div class="metric-label">Uptime</div>
					<div class="metric-value">{{ formatDuration(sys?.uptime) }}</div>
				</div>
			</div>
		</el-card>

		<el-card shadow="never" class="section">
			<template #header>
				<span class="card-title">用户凭据</span>
			</template>
			<el-table :data="clients" empty-text="暂无数据">
				<el-table-column prop="subscriber_name" label="订阅用户" min-width="140" />
				<el-table-column label="Email" min-width="220">
					<template #default="{ row }">
						<span class="credential">{{ row.xray_email }}</span>
						<el-button link type="primary" @click="copyText(row.xray_email)">复制</el-button>
					</template>
				</el-table-column>
				<el-table-column label="UUID" min-width="280">
					<template #default="{ row }">
						<span class="credential">{{ row.vless_uuid }}</span>
						<el-button link type="primary" @click="copyText(row.vless_uuid)">复制</el-button>
					</template>
				</el-table-column>
				<el-table-column label="状态" width="90">
					<template #default="{ row }">
						<el-tag :type="row.enabled ? 'success' : 'info'" disable-transitions>
							{{ row.enabled ? '启用' : '停用' }}
						</el-tag>
					</template>
				</el-table-column>
			</el-table>
		</el-card>

		<el-card shadow="never" class="section">
			<template #header>
				<div class="card-header">
					<span class="card-title">端点</span>
					<el-button type="primary" @click="openCreateEndpoint">新增端点</el-button>
				</div>
			</template>
			<el-table v-loading="loading" :data="endpoints" empty-text="暂无数据">
				<el-table-column prop="name" label="名称" min-width="140" />
				<el-table-column prop="protocol" label="协议" width="140" />
				<el-table-column prop="host" label="地址" min-width="180" />
				<el-table-column prop="port" label="端口" width="90" />
				<el-table-column label="SNI" min-width="160">
					<template #default="{ row }">{{ row.params.sni }}</template>
				</el-table-column>
				<el-table-column label="Public Key" min-width="180">
					<template #default="{ row }">{{ row.params.public_key }}</template>
				</el-table-column>
				<el-table-column label="Short ID" width="120">
					<template #default="{ row }">{{ row.params.short_id || '—' }}</template>
				</el-table-column>
				<el-table-column label="Fingerprint" width="120">
					<template #default="{ row }">{{ row.params.fingerprint }}</template>
				</el-table-column>
				<el-table-column label="状态" width="90">
					<template #default="{ row }">
						<el-tag :type="row.enabled ? 'success' : 'info'" disable-transitions>
							{{ row.enabled ? '启用' : '停用' }}
						</el-tag>
					</template>
				</el-table-column>
				<el-table-column label="操作" width="150" fixed="right">
					<template #default="{ row }">
						<el-button link type="primary" @click="openEditEndpoint(row as Endpoint)">编辑</el-button>
						<el-button v-if="row.enabled" link type="danger" :loading="saving" @click="disableEndpoint(row as Endpoint)"> 停用 </el-button>
						<el-button v-else link type="primary" :loading="saving" @click="enableEndpoint(row as Endpoint)">启用</el-button>
					</template>
				</el-table-column>
			</el-table>
		</el-card>

		<el-card v-loading="trafficLoading" shadow="never" class="section">
			<template #header>
				<span class="card-title">近 24 小时流量</span>
			</template>
			<div class="metric-grid">
				<div class="metric">
					<div class="metric-label">上行</div>
					<div class="metric-value">{{ formatBytes(trafficTotals.uplink) }}</div>
				</div>
				<div class="metric">
					<div class="metric-label">下行</div>
					<div class="metric-value">{{ formatBytes(trafficTotals.downlink) }}</div>
				</div>
				<div class="metric">
					<div class="metric-label">总计</div>
					<div class="metric-value">{{ formatBytes(trafficTotals.total) }}</div>
				</div>
			</div>
		</el-card>
	</div>

	<el-dialog
		v-model="endpointDialogVisible"
		:title="editingEndpointId === null ? '新增端点' : '编辑端点'"
		width="640px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-form ref="endpointFormRef" :model="endpointForm" :rules="endpointRules" label-width="140px">
			<el-form-item label="名称" prop="name">
				<el-input v-model="endpointForm.name" />
			</el-form-item>
			<el-form-item label="地址" prop="host">
				<el-input v-model="endpointForm.host" />
			</el-form-item>
			<el-form-item label="端口" prop="port">
				<el-input-number v-model="endpointForm.port" :min="1" :max="65535" />
			</el-form-item>
			<el-form-item label="SNI" prop="sni">
				<el-input v-model="endpointForm.sni" />
			</el-form-item>
			<el-form-item label="Public Key" prop="public_key">
				<el-input v-model="endpointForm.public_key" />
			</el-form-item>
			<el-form-item label="Short ID" prop="short_id">
				<el-input v-model="endpointForm.short_id" />
			</el-form-item>
			<el-form-item label="Fingerprint" prop="fingerprint">
				<el-input v-model="endpointForm.fingerprint" />
			</el-form-item>
			<el-form-item label="Flow">
				<el-input :model-value="endpointForm.flow" disabled />
			</el-form-item>
			<el-form-item label="Network">
				<el-input :model-value="endpointForm.network" disabled />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="endpointDialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="endpointSaving" @click="submitEndpoint">保存</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.toolbar {
	display: flex;
	justify-content: space-between;
	margin-bottom: 16px;
}

.section {
	margin-bottom: 16px;
}

.card-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.card-title {
	font-size: 14px;
	font-weight: 600;
}

.metric-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 16px;
}

.metric-label {
	font-size: 13px;
	color: #6b7280;
}

.credential {
	margin-right: 8px;
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
}

.metric-value {
	margin-top: 8px;
	font-size: 22px;
	font-weight: 600;
	color: #111827;
}
</style>
