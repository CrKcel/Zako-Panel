<script setup lang="ts">
import type { CreateNodeEnrollmentTokenRequest, Node, NodeEnrollmentToken, NodeStatus } from '@zako/contracts';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import AppIcon from '../components/AppIcon.vue';
import CodeBlock from '../components/CodeBlock.vue';
import NodeCard from '../components/NodeCard.vue';
import PageToolbar from '../components/PageToolbar.vue';
import PollingPill from '../components/PollingPill.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { usePolling } from '../composables/usePolling';
import { nodeStatusDescriptor } from '../domain/status';
import { useI18n } from '../i18n';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatDuration, formatPercent, formatTimestamp } from '../utils/format';

type SortKey = 'name' | 'status' | 'cpu' | 'memory' | 'heartbeat';

const { t } = useI18n();
const search = ref('');
const statusFilter = ref<'all' | NodeStatus>('all');
const sortBy = ref<SortKey>('status');
const viewMode = ref<'card' | 'table'>('card');

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

const STATUS_ORDER: Record<NodeStatus, number> = {
	degraded: 0,
	offline: 1,
	uninstalling: 2,
	online: 3,
	disabled: 4,
};

const statusOptions = computed<Array<{ value: 'all' | NodeStatus; label: string; count: number }>>(() => {
	const list = nodes.value;
	const countOf = (status: NodeStatus) => list.filter((item) => item.status === status).length;
	const items: Array<{ value: 'all' | NodeStatus; label: string; count: number }> = [
		{ value: 'all', label: t('common.all'), count: list.length },
		{ value: 'online', label: t('status.node.online'), count: countOf('online') },
		{ value: 'degraded', label: t('status.node.degraded'), count: countOf('degraded') },
		{ value: 'offline', label: t('status.node.offline'), count: countOf('offline') },
		{ value: 'disabled', label: t('status.node.disabled'), count: countOf('disabled') },
	];
	const uninstallingCount = countOf('uninstalling');
	if (uninstallingCount > 0) {
		items.push({ value: 'uninstalling', label: t('status.node.uninstalling'), count: uninstallingCount });
	}
	return items;
});

const filteredNodes = computed(() => {
	const q = search.value.trim().toLowerCase();
	const list = nodes.value.filter((node) => {
		if (statusFilter.value !== 'all' && node.status !== statusFilter.value) return false;
		if (q && !node.name.toLowerCase().includes(q)) return false;
		return true;
	});
	return [...list].sort((a, b) => {
		switch (sortBy.value) {
			case 'name':
				return a.name.localeCompare(b.name);
			case 'status':
				return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name);
			case 'cpu':
				return (b.sys?.cpu ?? -1) - (a.sys?.cpu ?? -1);
			case 'memory':
				return (b.sys?.mem ?? -1) - (a.sys?.mem ?? -1);
			case 'heartbeat':
				return (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0);
		}
	});
});

function clearFilters(): void {
	search.value = '';
	statusFilter.value = 'all';
}

const { refresh, lastUpdatedAt, paused, togglePause } = usePolling(reload, 30_000);

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
				<div class="filter-pills" role="group">
					<button
						v-for="opt in statusOptions"
						:key="opt.value"
						type="button"
						class="filter-pill"
						:class="{ 'is-active': statusFilter === opt.value }"
						:aria-pressed="statusFilter === opt.value"
						@click="statusFilter = opt.value"
					>
						<span>{{ opt.label }}</span>
						<span class="filter-pill-count">{{ opt.count }}</span>
					</button>
				</div>
				<el-input v-model="search" :placeholder="t('nodes.searchPlaceholder')" clearable class="search-input" />
				<el-select v-model="sortBy" class="sort-select">
					<el-option :label="t('nodes.sortStatus')" value="status" />
					<el-option :label="t('nodes.sortName')" value="name" />
					<el-option :label="t('nodes.sortCpu')" value="cpu" />
					<el-option :label="t('nodes.sortMemory')" value="memory" />
					<el-option :label="t('nodes.sortHeartbeat')" value="heartbeat" />
				</el-select>
			</div>
		</template>
		<PollingPill :last-updated-at="lastUpdatedAt" :paused="paused" @toggle="togglePause" />
		<div class="view-switch" role="group">
			<button
				type="button"
				class="view-btn"
				:class="{ 'is-active': viewMode === 'card' }"
				:title="t('nodes.viewCard')"
				:aria-label="t('nodes.viewCard')"
				@click="viewMode = 'card'"
			>
				<AppIcon name="grid" :size="14" />
			</button>
			<button
				type="button"
				class="view-btn"
				:class="{ 'is-active': viewMode === 'table' }"
				:title="t('nodes.viewTable')"
				:aria-label="t('nodes.viewTable')"
				@click="viewMode = 'table'"
			>
				<AppIcon name="list" :size="14" />
			</button>
		</div>
		<el-button :loading="loading" @click="refresh">
			<AppIcon name="refresh" :size="14" class="btn-icon" />
			<span>{{ t('common.refresh') }}</span>
		</el-button>
		<el-button @click="openEnrollList">{{ t('nodes.enrollmentTokens') }}</el-button>
		<el-button type="primary" @click="openEnrollCreate">
			<AppIcon name="plus" :size="14" class="btn-icon" />
			<span>{{ t('nodes.deployNode') }}</span>
		</el-button>
	</PageToolbar>

	<div v-loading="loading" class="nodes-stage">
		<template v-if="filteredNodes.length > 0">
			<div v-if="viewMode === 'card'" class="nodes-grid">
				<NodeCard
					v-for="node in filteredNodes"
					:key="node.id"
					:node="node"
					:deleting="deleteAction.isRunning(node.id)"
					@delete="openDeleteDialog"
				/>
			</div>
			<el-card v-else shadow="never">
				<el-table :data="filteredNodes">
					<el-table-column :label="t('common.name')" min-width="170">
						<template #default="{ row }">
							<RouterLink :to="`/nodes/${row.id}`" class="ui-link">{{ row.name }}</RouterLink>
						</template>
					</el-table-column>
					<el-table-column :label="t('common.status')" width="120">
						<template #default="{ row }">
							<StatusBadge
								:label="nodeStatusDescriptor(row.status).label"
								:type="nodeStatusDescriptor(row.status).tag"
								:pulse="row.status === 'online'"
							/>
						</template>
					</el-table-column>
					<el-table-column :label="t('nodes.columns.cpu')" width="95">
						<template #default="{ row }">
							<span class="tnum">{{ formatPercent(row.sys?.cpu) }}</span>
						</template>
					</el-table-column>
					<el-table-column :label="t('nodes.columns.memory')" width="95">
						<template #default="{ row }">
							<span class="tnum">{{ formatPercent(row.sys?.mem) }}</span>
						</template>
					</el-table-column>
					<el-table-column :label="t('nodes.columns.uptime')" width="130">
						<template #default="{ row }">
							<span class="tnum">{{ formatDuration(row.sys?.uptime) }}</span>
						</template>
					</el-table-column>
					<el-table-column :label="t('nodes.columns.configVersion')" width="130">
						<template #default="{ row }">
							<span class="tnum">v{{ row.applied_config_version }} / v{{ row.desired_config_version }}</span>
						</template>
					</el-table-column>
					<el-table-column :label="t('nodes.columns.lastHeartbeat')" width="175">
						<template #default="{ row }">
							<span class="tnum">{{ row.last_seen_at ? formatTimestamp(row.last_seen_at) : t('nodes.neverConnected') }}</span>
						</template>
					</el-table-column>
					<el-table-column :label="t('common.actions')" width="140" fixed="right">
						<template #default="{ row }">
							<RouterLink :to="`/nodes/${row.id}`" custom v-slot="{ navigate }">
								<el-button link type="primary" @click="navigate">{{ t('common.details') }}</el-button>
							</RouterLink>
							<el-button link type="danger" :loading="deleteAction.isRunning(row.id)" @click="openDeleteDialog(row as Node)">
								{{ row.status === 'uninstalling' ? t('common.forceDelete') : t('common.delete') }}
							</el-button>
						</template>
					</el-table-column>
				</el-table>
			</el-card>
		</template>
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
		<CodeBlock :code="enrollCommand" label="bash" wrap />
		<template #footer>
			<el-button type="primary" @click="enrollResultVisible = false">{{ t('common.close') }}</el-button>
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
.btn-icon {
	margin-right: 5px;
}

.filters {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}

.search-input {
	width: 200px;
}

.sort-select {
	width: 130px;
}

.view-switch {
	display: inline-flex;
	align-items: center;
	padding: 2px;
	border: 1px solid var(--border-color);
	border-radius: var(--radius-sm);
	background: var(--bg-muted);
}

.view-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 26px;
	border: none;
	border-radius: var(--radius-xs);
	background: transparent;
	color: var(--text-muted);
	cursor: pointer;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		color var(--duration-fast) var(--ease-standard);
}

.view-btn:hover {
	color: var(--text-primary);
}

.view-btn.is-active {
	background: var(--bg-surface);
	color: var(--text-primary);
	box-shadow: var(--shadow-xs);
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

.delete-confirm {
	margin: 0;
	color: var(--text-primary);
}

.delete-form {
	margin-top: 16px;
}
</style>
