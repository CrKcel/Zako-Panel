<script setup lang="ts">
import type { Endpoint, NodeClient, TrafficSummary } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { trafficApi } from '../api/traffic';
import EndpointFormFields from '../components/EndpointFormFields.vue';
import PageToolbar from '../components/PageToolbar.vue';
import TrafficTotalsCard from '../components/TrafficTotalsCard.vue';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import { usePolling } from '../composables/usePolling';
import { emptyEndpointFormValue, endpointFormValueFrom, endpointRequestBody, type EndpointFormValue } from '../domain/endpoint-form';
import { healthDescriptor, nodeStatusDescriptor } from '../domain/status';
import { DAY_SECONDS, trafficWindow } from '../domain/traffic';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatDuration, formatPercent, formatTimestamp } from '../utils/format';

const route = useRoute();
const router = useRouter();
const nodeId = computed(() => String(route.params.nodeId ?? ''));

const {
	data: detail,
	loading,
	reload: reloadNode,
} = useAsyncResource(() => nodesApi.get(nodeId.value), {
	immediate: false,
	initialValue: null,
	onError: (error) => showError(error, '节点加载失败'),
});

const { data: clients, reload: reloadClients } = useAsyncResource<NodeClient[]>(() => nodesApi.listClients(nodeId.value), {
	immediate: false,
	initialValue: [],
	onError: (error) => showError(error, '节点加载失败'),
});

const {
	data: traffic,
	loading: trafficLoading,
	reload: reloadTraffic,
} = useAsyncResource<TrafficSummary | null>(
	() => trafficApi.summary({ ...trafficWindow(DAY_SECONDS), groupBy: 'node', nodeId: nodeId.value }),
	{
		immediate: false,
		initialValue: null,
		onError: (error) => showError(error, '流量加载失败'),
	},
);

const node = computed(() => detail.value?.node ?? null);
const endpoints = computed(() => detail.value?.endpoints ?? []);
const sys = computed(() => node.value?.sys ?? null);

const { refresh } = usePolling(async () => {
	await Promise.all([reloadNode(), reloadClients(), reloadTraffic()]);
}, 30_000);

const endpointForm = ref<EndpointFormValue>(emptyEndpointFormValue());
const endpointFormRef = ref<FormInstance>();

const endpointRules: FormRules = {
	name: [{ required: true, message: '请输入端点名称', trigger: 'blur' }],
	host: [{ required: true, message: '请输入地址', trigger: 'blur' }],
	sni: [{ required: true, message: '请输入 SNI', trigger: 'blur' }],
	public_key: [{ required: true, message: '请输入 Public Key', trigger: 'blur' }],
};

const {
	visible: endpointVisible,
	editingId: editingEndpointId,
	submitting: endpointSaving,
	openCreate: openCreateEndpoint,
	openEdit: openEditEndpoint,
	close: closeEndpoint,
	submit: submitEndpointForm,
} = useCrudDialog({
	reset: () => {
		endpointForm.value = emptyEndpointFormValue();
	},
	load: (id) => {
		const endpoint = endpoints.value.find((item) => item.id === id);
		if (endpoint === undefined) return;
		endpointForm.value = endpointFormValueFrom(endpoint);
	},
});

async function submitEndpoint(): Promise<void> {
	if (!(await endpointFormRef.value?.validate().catch(() => false))) return;
	const endpointId = editingEndpointId.value;
	const request = endpointRequestBody(endpointForm.value);
	const saved = await submitEndpointForm(
		async () => {
			if (endpointId === null) {
				await nodesApi.createEndpoint(nodeId.value, request);
				showSuccess('端点已创建');
			} else {
				await nodesApi.updateEndpoint(nodeId.value, endpointId, request);
				showSuccess('端点已更新');
			}
			closeEndpoint();
		},
		(error) => showError(error, '端点保存失败'),
	);
	if (saved) await reloadNode();
}

const disableAction = useAsyncAction(
	async (endpoint: Endpoint) => {
		await nodesApi.disableEndpoint(nodeId.value, endpoint.id);
		showSuccess('端点已停用');
		await reloadNode();
	},
	{ onError: (error) => showError(error, '端点停用失败') },
);

const enableAction = useAsyncAction(
	async (endpoint: Endpoint) => {
		await nodesApi.updateEndpoint(nodeId.value, endpoint.id, { enabled: true });
		showSuccess('端点已启用');
		await reloadNode();
	},
	{ onError: (error) => showError(error, '端点启用失败') },
);

async function disableEndpoint(endpoint: Endpoint): Promise<void> {
	if (!(await confirmAction(`停用端点「${endpoint.name}」？`))) return;
	await disableAction.runFor(endpoint.id, endpoint);
}

async function enableEndpoint(endpoint: Endpoint): Promise<void> {
	await enableAction.runFor(endpoint.id, endpoint);
}

function backToList(): void {
	void router.push({ name: 'nodes' });
}
</script>

<template>
	<div v-loading="loading">
		<PageToolbar spread>
			<el-button @click="backToList">返回列表</el-button>
			<el-button :loading="loading" @click="refresh">刷新</el-button>
		</PageToolbar>

		<el-card shadow="never" class="section">
			<template #header>
				<span class="card-title">{{ node?.name ?? '—' }}</span>
			</template>
			<el-descriptions :column="3" border>
				<el-descriptions-item label="状态">
					<el-tag v-if="node" :type="nodeStatusDescriptor(node.status).tag" disable-transitions>
						{{ nodeStatusDescriptor(node.status).label }}
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
					<el-tag :type="healthDescriptor(node?.xray_healthy).tag" disable-transitions>
						{{ healthDescriptor(node?.xray_healthy).label }}
					</el-tag>
				</el-descriptions-item>
				<el-descriptions-item label="统计健康">
					<el-tag :type="healthDescriptor(node?.stats_healthy).tag" disable-transitions>
						{{ healthDescriptor(node?.stats_healthy).label }}
					</el-tag>
				</el-descriptions-item>
				<el-descriptions-item label="配置错误">{{ node?.last_config_error ?? '—' }}</el-descriptions-item>
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
						<el-button link type="primary" @click="openEditEndpoint(row.id)">编辑</el-button>
						<el-button
							v-if="row.enabled"
							link
							type="danger"
							:loading="disableAction.isRunning(row.id)"
							@click="disableEndpoint(row as Endpoint)"
						>
							停用
						</el-button>
						<el-button v-else link type="primary" :loading="enableAction.isRunning(row.id)" @click="enableEndpoint(row as Endpoint)">
							启用
						</el-button>
					</template>
				</el-table-column>
			</el-table>
		</el-card>

		<TrafficTotalsCard :summary="traffic" :loading="trafficLoading" title="近 24 小时流量" />
	</div>

	<el-dialog
		v-model="endpointVisible"
		:title="editingEndpointId === null ? '新增端点' : '编辑端点'"
		width="640px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-form ref="endpointFormRef" :model="endpointForm" :rules="endpointRules" label-width="140px">
			<EndpointFormFields v-model="endpointForm" />
		</el-form>
		<template #footer>
			<el-button @click="closeEndpoint">取消</el-button>
			<el-button type="primary" :loading="endpointSaving" @click="submitEndpoint">保存</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
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
