<script setup lang="ts">
import type { Endpoint, NodeClient, TrafficSummary } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { nodesApi } from '../api/nodes';
import { trafficApi } from '../api/traffic';
import EndpointFormFields from '../components/EndpointFormFields.vue';
import NodeConfigPanel from '../components/NodeConfigPanel.vue';
import PageToolbar from '../components/PageToolbar.vue';
import StatCard from '../components/StatCard.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TrafficTotalsCard from '../components/TrafficTotalsCard.vue';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import { usePolling } from '../composables/usePolling';
import {
	emptyEndpointFormValue,
	endpointFormValueFrom,
	endpointParamsSummary,
	endpointRequestBody,
	type EndpointFormValue,
} from '../domain/endpoint-form';
import { healthDescriptor, nodeStatusDescriptor } from '../domain/status';
import { DAY_SECONDS, trafficWindow } from '../domain/traffic';
import { useI18n } from '../i18n';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatDuration, formatPercent, formatTimestamp } from '../utils/format';

const { t } = useI18n();
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
	onError: (error) => showError(error, t('nodeDetail.loadNodeError')),
});

const { data: clients, reload: reloadClients } = useAsyncResource<NodeClient[]>(() => nodesApi.listClients(nodeId.value), {
	immediate: false,
	initialValue: [],
	onError: (error) => showError(error, t('nodeDetail.loadNodeError')),
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
		onError: (error) => showError(error, t('nodeDetail.loadTrafficError')),
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

const vlessRealitySelected = computed(() => endpointForm.value.protocol === 'vless-reality');

/** vless-reality, trojan and hysteria2 always run TLS; vmess only when its security is tls. */
const sniRequired = computed(() => {
	const { protocol, security } = endpointForm.value;
	if (protocol === 'shadowsocks') return false;
	if (protocol === 'vmess') return security !== 'none';
	return true;
});

const obfsPasswordRequired = computed(() => endpointForm.value.protocol === 'hysteria2' && endpointForm.value.obfs === 'salamander');

const endpointRules = computed<FormRules>(() => ({
	name: [{ required: true, message: t('nodeDetail.endpoints.nameRequired'), trigger: 'blur' }],
	host: [{ required: true, message: t('nodeDetail.endpoints.hostRequired'), trigger: 'blur' }],
	sni: sniRequired.value ? [{ required: true, message: t('nodeDetail.endpoints.sniRequired'), trigger: 'blur' }] : [],
	public_key: vlessRealitySelected.value ? [{ required: true, message: t('nodeDetail.endpoints.publicKeyRequired'), trigger: 'blur' }] : [],
	obfs_password: obfsPasswordRequired.value
		? [{ required: true, message: t('nodeDetail.endpoints.obfsPasswordRequired'), trigger: 'blur' }]
		: [],
}));

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
				showSuccess(t('nodeDetail.endpoints.created'));
			} else {
				await nodesApi.updateEndpoint(nodeId.value, endpointId, request);
				showSuccess(t('nodeDetail.endpoints.updated'));
			}
			closeEndpoint();
		},
		(error) => showError(error, t('nodeDetail.endpoints.saveFailed')),
	);
	if (saved) await reloadNode();
}

const disableAction = useAsyncAction(
	async (endpoint: Endpoint) => {
		await nodesApi.disableEndpoint(nodeId.value, endpoint.id);
		showSuccess(t('nodeDetail.endpoints.disabled'));
		await reloadNode();
	},
	{ onError: (error) => showError(error, t('nodeDetail.endpoints.disableFailed')) },
);

const enableAction = useAsyncAction(
	async (endpoint: Endpoint) => {
		await nodesApi.updateEndpoint(nodeId.value, endpoint.id, { enabled: true });
		showSuccess(t('nodeDetail.endpoints.enabled'));
		await reloadNode();
	},
	{ onError: (error) => showError(error, t('nodeDetail.endpoints.enableFailed')) },
);

async function disableEndpoint(endpoint: Endpoint): Promise<void> {
	if (!(await confirmAction(t('nodeDetail.endpoints.disableConfirm', { name: endpoint.name })))) return;
	await disableAction.runFor(endpoint.id, endpoint);
}

async function enableEndpoint(endpoint: Endpoint): Promise<void> {
	await enableAction.runFor(endpoint.id, endpoint);
}

function backToList(): void {
	void router.push({ name: 'nodes' });
}

interface NodeEditForm {
	name: string;
	heartbeat_interval_seconds: number;
	enabled: boolean;
}

const editForm = ref<NodeEditForm>({ name: '', heartbeat_interval_seconds: 300, enabled: true });
const editFormRef = ref<FormInstance>();

const editRules = computed<FormRules>(() => ({
	name: [{ required: true, message: t('nodes.editDialog.nameRequired'), trigger: 'blur' }],
}));

const {
	visible: editVisible,
	submitting: nodeSaving,
	openEdit: openEditNodeDialog,
	close: closeEditNode,
	submit: submitEditNodeTask,
} = useCrudDialog({
	load: () => {
		if (!node.value) return;
		editForm.value = {
			name: node.value.name,
			heartbeat_interval_seconds: node.value.heartbeat_interval_seconds,
			enabled: node.value.enabled,
		};
	},
});

function openEditNode(): void {
	if (!node.value) return;
	void openEditNodeDialog(node.value.id);
}

async function submitEditNode(): Promise<void> {
	if (!node.value) return;
	if (!(await editFormRef.value?.validate().catch(() => false))) return;
	const id = node.value.id;
	const saved = await submitEditNodeTask(
		async () => {
			await nodesApi.update(id, {
				name: editForm.value.name,
				heartbeat_interval_seconds: editForm.value.heartbeat_interval_seconds,
				enabled: editForm.value.enabled,
			});
			closeEditNode();
			showSuccess(t('nodes.editDialog.updated'));
		},
		(error) => showError(error, t('nodes.editDialog.updateFailed')),
	);
	if (saved) await reloadNode();
}

const deleteDialogVisible = ref(false);
const deleteForce = ref(false);
const deleteRemoveXray = ref(false);

function openDeleteDialog(): void {
	if (!node.value) return;
	deleteForce.value = node.value.status === 'uninstalling' || node.value.last_seen_at === null;
	deleteRemoveXray.value = false;
	deleteDialogVisible.value = true;
}

const deleteNodeAction = useAsyncAction(
	async () => {
		if (!node.value) return;
		const res = await nodesApi.remove(node.value.id, {
			force: deleteForce.value,
			removeXray: deleteRemoveXray.value,
		});
		deleteDialogVisible.value = false;
		if (res) {
			showSuccess(t('nodes.delete.uninstallQueued'));
			await reloadNode();
		} else {
			showSuccess(t('nodes.delete.deleted'));
			backToList();
		}
	},
	{ onError: (error) => showError(error, t('nodes.delete.failed')) },
);

async function submitDeleteNode(): Promise<void> {
	await deleteNodeAction.runFor('delete');
}
</script>

<template>
	<div v-loading="loading">
		<PageToolbar spread>
			<template #left>
				<el-button @click="backToList">{{ t('nodeDetail.backToList') }}</el-button>
			</template>
			<el-button v-if="node" type="primary" plain @click="openEditNode">{{ t('nodes.editDialog.title') }}</el-button>
			<el-button v-if="node" type="danger" plain :loading="deleteNodeAction.isRunning('delete')" @click="openDeleteDialog">
				{{ node.status === 'uninstalling' ? t('nodeDetail.forceDeleteNode') : t('nodeDetail.deleteNode') }}
			</el-button>
			<el-button :loading="loading" @click="refresh">{{ t('common.refresh') }}</el-button>
		</PageToolbar>

		<el-card shadow="never" class="ui-section">
			<template #header>
				<div class="ui-card-header">
					<span class="ui-card-title">{{ node?.name ?? '—' }}</span>
					<StatusBadge v-if="node" :label="nodeStatusDescriptor(node.status).label" :type="nodeStatusDescriptor(node.status).tag" />
				</div>
			</template>
			<el-descriptions :column="3" border>
				<el-descriptions-item :label="t('common.status')">
					<StatusBadge v-if="node" :label="nodeStatusDescriptor(node.status).label" :type="nodeStatusDescriptor(node.status).tag" />
					<span v-else>—</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('nodeDetail.fields.heartbeatInterval')">
					<span class="tnum">{{ node ? `${node.heartbeat_interval_seconds}s` : '—' }}</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('nodeDetail.fields.lastHeartbeat')">
					<span class="tnum">{{ formatTimestamp(node?.last_seen_at) }}</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('nodeDetail.fields.agentVersion')">
					<span class="mono">{{ node?.agent_version ?? '—' }}</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('nodeDetail.fields.xrayVersion')">
					<span class="mono">{{ node?.xray_version ?? '—' }}</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('nodeDetail.fields.configVersion')">
					<span class="tnum">{{ node ? `${node.applied_config_version} / ${node.desired_config_version}` : '—' }}</span>
				</el-descriptions-item>
				<el-descriptions-item :label="t('nodeDetail.fields.xrayHealth')">
					<StatusBadge :label="healthDescriptor(node?.xray_healthy).label" :type="healthDescriptor(node?.xray_healthy).tag" />
				</el-descriptions-item>
				<el-descriptions-item :label="t('nodeDetail.fields.statsHealth')">
					<StatusBadge :label="healthDescriptor(node?.stats_healthy).label" :type="healthDescriptor(node?.stats_healthy).tag" />
				</el-descriptions-item>
				<el-descriptions-item :label="t('nodeDetail.fields.configError')">
					<span :class="{ 'error-text': Boolean(node?.last_config_error) }">{{ node?.last_config_error ?? '—' }}</span>
				</el-descriptions-item>
			</el-descriptions>
		</el-card>

		<div class="stats-grid ui-section">
			<StatCard :label="t('nodeDetail.stats.cpu')" :value="formatPercent(sys?.cpu)" />
			<StatCard :label="t('nodeDetail.stats.memory')" :value="formatPercent(sys?.mem)" />
			<StatCard :label="t('nodeDetail.stats.load')" :value="sys ? sys.load.toFixed(2) : '—'" />
			<StatCard :label="t('nodeDetail.stats.uptime')" :value="formatDuration(sys?.uptime)" />
		</div>

		<el-card shadow="never" class="ui-section">
			<template #header>
				<div class="ui-card-header">
					<span class="ui-card-title">{{ t('nodeDetail.clients.title') }}</span>
				</div>
			</template>
			<el-table :data="clients" :empty-text="t('common.noData')">
				<el-table-column prop="subscriber_name" :label="t('nodeDetail.clients.subscriber')" min-width="140" />
				<el-table-column :label="t('nodeDetail.clients.email')" min-width="220">
					<template #default="{ row }">
						<span class="credential">{{ row.xray_email }}</span>
						<el-button link type="primary" @click="copyText(row.xray_email)">{{ t('common.copy') }}</el-button>
					</template>
				</el-table-column>
				<el-table-column :label="t('nodeDetail.clients.uuid')" min-width="280">
					<template #default="{ row }">
						<span class="credential">{{ row.vless_uuid }}</span>
						<el-button link type="primary" @click="copyText(row.vless_uuid)">{{ t('common.copy') }}</el-button>
					</template>
				</el-table-column>
				<el-table-column :label="t('common.status')" width="105">
					<template #default="{ row }">
						<StatusBadge :label="row.enabled ? t('common.enabled') : t('common.disabled')" :type="row.enabled ? 'success' : 'info'" />
					</template>
				</el-table-column>
			</el-table>
		</el-card>

		<el-card shadow="never" class="ui-section">
			<template #header>
				<div class="ui-card-header">
					<span class="ui-card-title">{{ t('nodeDetail.endpoints.title') }}</span>
					<el-button type="primary" @click="openCreateEndpoint">{{ t('nodeDetail.endpoints.add') }}</el-button>
				</div>
			</template>
			<el-table v-loading="loading" :data="endpoints" :empty-text="t('common.noData')">
				<el-table-column prop="name" :label="t('common.name')" min-width="140" />
				<el-table-column prop="protocol" :label="t('nodeDetail.endpoints.protocol')" width="130">
					<template #default="{ row }">
						<span class="mono">{{ row.protocol }}</span>
					</template>
				</el-table-column>
				<el-table-column prop="host" :label="t('nodeDetail.endpoints.host')" min-width="180">
					<template #default="{ row }">
						<span class="mono">{{ row.host }}</span>
					</template>
				</el-table-column>
				<el-table-column prop="port" :label="t('nodeDetail.endpoints.port')" width="90">
					<template #default="{ row }">
						<span class="tnum">{{ row.port }}</span>
					</template>
				</el-table-column>
				<el-table-column :label="t('nodeDetail.endpoints.params')" min-width="260">
					<template #default="{ row }">
						<span class="mono">{{ endpointParamsSummary(row as Endpoint) }}</span>
					</template>
				</el-table-column>
				<el-table-column :label="t('common.status')" width="105">
					<template #default="{ row }">
						<StatusBadge :label="row.enabled ? t('common.enabled') : t('common.disabled')" :type="row.enabled ? 'success' : 'info'" />
					</template>
				</el-table-column>
				<el-table-column :label="t('common.actions')" width="150" fixed="right">
					<template #default="{ row }">
						<el-button link type="primary" @click="openEditEndpoint(row.id)">{{ t('common.edit') }}</el-button>
						<el-button
							v-if="row.enabled"
							link
							type="danger"
							:loading="disableAction.isRunning(row.id)"
							@click="disableEndpoint(row as Endpoint)"
						>
							{{ t('common.disabled') }}
						</el-button>
						<el-button v-else link type="primary" :loading="enableAction.isRunning(row.id)" @click="enableEndpoint(row as Endpoint)">
							{{ t('common.enabled') }}
						</el-button>
					</template>
				</el-table-column>
			</el-table>
		</el-card>

		<NodeConfigPanel
			v-if="node"
			:node-id="node.id"
			:applied-version="node.applied_config_version"
			:desired-version="node.desired_config_version"
			:endpoints="endpoints"
			@changed="reloadNode"
		/>

		<TrafficTotalsCard :summary="traffic" :loading="trafficLoading" :title="t('nodeDetail.trafficLast24h')" />
	</div>

	<el-dialog v-model="editVisible" :title="t('nodes.editDialog.title')" width="520px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="editFormRef" :model="editForm" :rules="editRules" label-width="150px">
			<el-form-item :label="t('common.name')" prop="name">
				<el-input v-model="editForm.name" />
			</el-form-item>
			<el-form-item :label="t('nodes.editDialog.heartbeatInterval')" prop="heartbeat_interval_seconds">
				<el-input-number v-model="editForm.heartbeat_interval_seconds" :min="60" :max="900" :step="30" />
			</el-form-item>
			<el-form-item :label="t('common.enabled')" prop="enabled">
				<el-switch v-model="editForm.enabled" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="closeEditNode">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="nodeSaving" @click="submitEditNode">{{ t('common.save') }}</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="deleteDialogVisible" :title="t('nodes.delete.title')" width="500px" destroy-on-close>
		<p class="delete-confirm">
			{{ t('nodes.delete.confirmPrefix') }}<strong>{{ node?.name }}</strong
			>{{ t('nodes.delete.confirmSuffix') }}
		</p>
		<el-form label-width="220px" class="delete-form">
			<el-form-item v-if="node?.last_seen_at !== null && node?.status !== 'uninstalling'" :label="t('nodes.delete.forceLabel')">
				<el-switch v-model="deleteForce" />
			</el-form-item>
			<el-form-item v-if="!deleteForce" :label="t('nodes.delete.removeXrayLabel')">
				<el-switch v-model="deleteRemoveXray" />
			</el-form-item>
		</el-form>
		<el-alert v-if="!deleteForce" type="info" :closable="false" show-icon :title="t('nodes.delete.uninstallHint')" />
		<el-alert v-else type="warning" :closable="false" show-icon :title="t('nodes.delete.forceHint')" />
		<template #footer>
			<el-button @click="deleteDialogVisible = false">{{ t('common.cancel') }}</el-button>
			<el-button type="danger" :loading="deleteNodeAction.isRunning('delete')" @click="submitDeleteNode">
				{{ deleteForce ? t('common.forceDelete') : t('nodes.delete.confirmUninstallAndDelete') }}
			</el-button>
		</template>
	</el-dialog>

	<el-dialog
		v-model="endpointVisible"
		:title="editingEndpointId === null ? t('nodeDetail.endpoints.createTitle') : t('nodeDetail.endpoints.editTitle')"
		width="640px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-form ref="endpointFormRef" :model="endpointForm" :rules="endpointRules" label-width="140px">
			<EndpointFormFields v-model="endpointForm" :editing="editingEndpointId !== null" />
		</el-form>
		<template #footer>
			<el-button @click="closeEndpoint">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="endpointSaving" @click="submitEndpoint">{{ t('common.save') }}</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.stats-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 14px;
}

.credential {
	margin-right: 8px;
	font-family: var(--font-mono);
	font-size: 12px;
	color: var(--text-primary);
}

.error-text {
	color: var(--tone-danger);
}

.delete-confirm {
	margin: 0;
	color: var(--text-primary);
}

.delete-form {
	margin-top: 16px;
}
</style>
