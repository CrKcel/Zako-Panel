<script setup lang="ts">
import type { CreateNodeEnrollmentTokenRequest, Node, NodeEnrollmentToken } from '@zako/contracts';
import { computed, ref } from 'vue';
import { nodesApi } from '../api/nodes';
import NodeCard from '../components/NodeCard.vue';
import PageToolbar from '../components/PageToolbar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { usePolling } from '../composables/usePolling';
import { useI18n } from '../i18n';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

const { t } = useI18n();
const search = ref('');
const statusFilter = ref<'all' | Node['status']>('all');

const enrollCreateVisible = ref(false);
const enrollResultVisible = ref(false);
const enrollListVisible = ref(false);
const enrollToken = ref('');
const enrollTokens = ref<NodeEnrollmentToken[]>([]);
const enrollTokensLoading = ref(false);
const enrollForm = ref<{
	name_prefix: string;
	heartbeat_interval_seconds: number;
}>({
	name_prefix: '',
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
	onError: (error) => showError(error, t('nodes.loadError')),
});

const filteredNodes = computed(() => {
	const q = search.value.trim().toLowerCase();
	return nodes.value.filter((node) => {
		if (statusFilter.value !== 'all' && node.status !== statusFilter.value) return false;
		if (q && !node.name.toLowerCase().includes(q)) return false;
		return true;
	});
});

const onlineCount = computed(() => nodes.value.filter((node) => node.status === 'online').length);

function clearFilters(): void {
	search.value = '';
	statusFilter.value = 'all';
}

const { refresh } = usePolling(reload, 30_000);

function openEnrollCreate(): void {
	enrollForm.value = {
		name_prefix: '',
		heartbeat_interval_seconds: 300,
	};
	enrollCreateVisible.value = true;
}

const createEnrollAction = useAsyncAction(
	async () => {
		const payload: CreateNodeEnrollmentTokenRequest = {
			heartbeat_interval_seconds: enrollForm.value.heartbeat_interval_seconds,
			ttl_seconds: 86_400,
			...(enrollForm.value.name_prefix.trim() ? { name_prefix: enrollForm.value.name_prefix.trim() } : {}),
		};
		const result = await nodesApi.createEnrollmentToken(payload);
		enrollCreateVisible.value = false;
		enrollToken.value = result.token;
		enrollResultVisible.value = true;
		showSuccess(t('nodes.enroll.generatedSuccess'));
	},
	{ onError: (error) => showError(error, t('nodes.enroll.createFailed')) },
);

async function loadEnrollmentTokens(): Promise<void> {
	enrollTokensLoading.value = true;
	try {
		const page = await nodesApi.listEnrollmentTokens();
		enrollTokens.value = page.items;
	} catch (error) {
		showError(error, t('nodes.enroll.listLoadFailed'));
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
		showSuccess(t('nodes.enroll.revokeSuccess'));
		await loadEnrollmentTokens();
	},
	{ onError: (error) => showError(error, t('nodes.enroll.revokeFailed')) },
);

async function revokeEnrollToken(token: NodeEnrollmentToken): Promise<void> {
	if (!(await confirmAction(t('nodes.enroll.revokeConfirm')))) return;
	await revokeEnrollAction.runFor(token.id, token);
}

function enrollStatusTag(status: NodeEnrollmentToken['status']): { label: string; type: 'success' | 'info' | 'warning' | 'danger' } {
	switch (status) {
		case 'active':
			return { label: t('status.enrollment.active'), type: 'success' };
		case 'used':
			return { label: t('status.enrollment.used'), type: 'info' };
		case 'expired':
			return { label: t('status.enrollment.expired'), type: 'warning' };
		case 'revoked':
			return { label: t('status.enrollment.revoked'), type: 'danger' };
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
			showSuccess(t('nodes.delete.uninstallQueued'));
		} else {
			showSuccess(t('nodes.delete.deleted'));
		}
		await reload();
	},
	{ onError: (error) => showError(error, t('nodes.delete.failed')) },
);

async function submitDeleteNode(): Promise<void> {
	if (!deletingNode.value) return;
	await deleteAction.runFor(deletingNode.value.id);
}
</script>

<template>
	<PageToolbar spread>
		<template #left>
			<div class="filters">
				<el-input v-model="search" :placeholder="t('nodes.searchPlaceholder')" clearable class="search-input" />
				<el-select v-model="statusFilter" class="status-select">
					<el-option :label="t('common.allStatuses')" value="all" />
					<el-option :label="t('status.node.online')" value="online" />
					<el-option :label="t('status.node.degraded')" value="degraded" />
					<el-option :label="t('status.node.offline')" value="offline" />
					<el-option :label="t('status.node.disabled')" value="disabled" />
					<el-option :label="t('status.node.uninstalling')" value="uninstalling" />
				</el-select>
				<span v-if="nodes.length > 0" class="nodes-summary tnum">
					{{ t('nodes.summary', { total: nodes.length, online: onlineCount }) }}
				</span>
			</div>
		</template>
		<el-button :loading="loading" @click="refresh">{{ t('common.refresh') }}</el-button>
		<el-button @click="openEnrollList">{{ t('nodes.enrollmentTokens') }}</el-button>
		<el-button type="primary" @click="openEnrollCreate">{{ t('nodes.deployNode') }}</el-button>
	</PageToolbar>

	<div v-loading="loading" class="nodes-stage">
		<div v-if="filteredNodes.length > 0" class="nodes-grid">
			<NodeCard
				v-for="node in filteredNodes"
				:key="node.id"
				:node="node"
				:deleting="deleteAction.isRunning(node.id)"
				@delete="openDeleteDialog"
			/>
		</div>
		<el-card v-else-if="!loading" shadow="never" class="empty-card">
			<el-empty :description="nodes.length === 0 ? t('nodes.empty') : t('nodes.emptyFiltered')">
				<el-button v-if="nodes.length === 0" type="primary" @click="openEnrollCreate">{{ t('nodes.deployNode') }}</el-button>
				<el-button v-else @click="clearFilters">{{ t('nodes.clearFilters') }}</el-button>
			</el-empty>
		</el-card>
	</div>

	<el-dialog
		v-model="enrollCreateVisible"
		:title="t('nodes.enroll.createTitle')"
		width="560px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-form :model="enrollForm" label-width="160px">
			<el-form-item :label="t('nodes.enroll.namePrefix')">
				<el-input v-model="enrollForm.name_prefix" :placeholder="t('nodes.enroll.namePrefixPlaceholder')" />
			</el-form-item>
			<el-form-item :label="t('nodes.enroll.heartbeatIntervalSec')">
				<el-input-number v-model="enrollForm.heartbeat_interval_seconds" :min="60" :max="900" :step="30" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="enrollCreateVisible = false">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="createEnrollAction.isRunning('create')" @click="createEnrollAction.runFor('create')">
				{{ t('nodes.enroll.generateCommand') }}
			</el-button>
		</template>
	</el-dialog>

	<el-dialog
		v-model="enrollResultVisible"
		:title="t('nodes.enroll.resultTitle')"
		width="680px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-alert type="info" :closable="false" show-icon class="dialog-alert">
			{{ t('nodes.enroll.resultAlert') }}
		</el-alert>
		<pre class="command-box mono">{{ enrollCommand }}</pre>
		<template #footer>
			<el-button @click="enrollResultVisible = false">{{ t('common.close') }}</el-button>
			<el-button type="primary" @click="copyText(enrollCommand)">{{ t('nodes.enroll.copyCommand') }}</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="enrollListVisible" :title="t('nodes.enroll.listTitle')" width="780px" destroy-on-close>
		<el-table v-loading="enrollTokensLoading" :data="enrollTokens" :empty-text="t('nodes.enroll.listEmpty')">
			<el-table-column :label="t('common.status')" width="110">
				<template #default="{ row }">
					<StatusBadge :label="enrollStatusTag(row.status).label" :type="enrollStatusTag(row.status).type" />
				</template>
			</el-table-column>
			<el-table-column :label="t('nodes.enroll.colPrefix')" width="120">
				<template #default="{ row }">{{ row.name_prefix ?? '—' }}</template>
			</el-table-column>
			<el-table-column :label="t('nodes.enroll.colHeartbeatInterval')" min-width="140">
				<template #default="{ row }">
					<span class="tnum">{{ row.heartbeat_interval_seconds }}s</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('nodes.enroll.colExpiresAt')" width="180">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.expires_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('common.actions')" width="100" fixed="right">
				<template #default="{ row }">
					<el-button
						v-if="row.status === 'active'"
						link
						type="danger"
						:loading="revokeEnrollAction.isRunning(row.id)"
						@click="revokeEnrollToken(row as NodeEnrollmentToken)"
					>
						{{ t('nodes.actions.revoke') }}
					</el-button>
					<span v-else>—</span>
				</template>
			</el-table-column>
		</el-table>
	</el-dialog>

	<el-dialog v-model="deleteDialogVisible" :title="t('nodes.delete.title')" width="500px" destroy-on-close>
		<p class="delete-confirm">
			{{ t('nodes.delete.confirmPrefix') }}<strong>{{ deletingNode?.name }}</strong
			>{{ t('nodes.delete.confirmSuffix') }}
		</p>
		<el-form label-width="220px" class="delete-form">
			<el-form-item
				v-if="deletingNode?.last_seen_at !== null && deletingNode?.status !== 'uninstalling'"
				:label="t('nodes.delete.forceLabel')"
			>
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
			<el-button type="danger" :loading="deletingNode ? deleteAction.isRunning(deletingNode.id) : false" @click="submitDeleteNode">
				{{ deleteForce ? t('common.forceDelete') : t('nodes.delete.confirmUninstallAndDelete') }}
			</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.filters {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}

.search-input {
	width: 220px;
}

.status-select {
	width: 140px;
}

.nodes-summary {
	font-size: 12.5px;
	color: var(--text-muted);
	margin-left: 4px;
}

.nodes-stage {
	min-height: 200px;
}

.nodes-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr));
	gap: 16px;
}

.empty-card {
	padding: 12px 0;
}

.dialog-alert {
	margin-bottom: 12px;
}

.command-box {
	margin: 0;
	padding: 14px 16px;
	background: var(--bg-muted);
	border: 1px solid var(--border-color);
	border-radius: var(--radius-md);
	font-size: 12.5px;
	line-height: 1.6;
	color: var(--text-primary);
	white-space: pre-wrap;
	word-break: break-all;
}

.delete-confirm {
	margin: 0;
	color: var(--text-primary);
}

.delete-form {
	margin-top: 16px;
}
</style>
