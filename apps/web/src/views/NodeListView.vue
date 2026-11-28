<script setup lang="ts">
import type { Node, NodeEnrollmentTokenStatus, NodeStatus } from '@zako/contracts';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { nodesApi } from '../api/nodes';
import AppIcon from '../components/AppIcon.vue';
import CodeBlock from '../components/CodeBlock.vue';
import NodeCard from '../components/NodeCard.vue';
import PageToolbar from '../components/PageToolbar.vue';
import PollingPill from '../components/PollingPill.vue';
import StatusBadge from '../components/StatusBadge.vue';
import ViewSwitch, { type ListViewMode } from '../components/ViewSwitch.vue';
import { evictCachedResource, invalidateCachedResource } from '../composables/resourceCache';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { usePolling } from '../composables/usePolling';
import { nodeStatusDescriptor } from '../domain/status';
import { useI18n } from '../i18n';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatDuration, formatPercent, formatTimestamp } from '../utils/format';

type SortKey = 'name' | 'status' | 'cpu' | 'memory' | 'heartbeat';

const { t } = useI18n();
const search = ref('');
const statusFilter = ref<'all' | NodeStatus>('all');
const sortBy = ref<SortKey>('status');
const viewMode = ref<ListViewMode>('card');

const deployDialogVisible = ref(false);
const tokenStatusLoading = ref(false);
const tokenStatus = ref<NodeEnrollmentTokenStatus>({ configured: false, rotated_at: null });
const rotatedToken = ref('');

const panelOrigin = computed(() => (typeof window !== 'undefined' ? window.location.origin : 'https://panel.example.com'));
const deployCommand = computed(
	() =>
		`curl -fsSL ${panelOrigin.value}/dl/agent/install.sh | sudo bash -s -- --panel ${panelOrigin.value} --token ${rotatedToken.value || '<ENROLLMENT_TOKEN>'}`,
);

const {
	data: nodes,
	loading,
	refreshing,
	updatedAt,
	reload,
} = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	immediate: false,
	initialValue: [],
	cacheKey: 'nodes:list',
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

const { refresh, lastUpdatedAt, paused, togglePause } = usePolling(reload, 30_000, {
	initialUpdatedAt: () => updatedAt.value,
});

async function openDeployDialog(): Promise<void> {
	rotatedToken.value = '';
	deployDialogVisible.value = true;
	tokenStatusLoading.value = true;
	try {
		tokenStatus.value = await nodesApi.getEnrollmentToken();
	} catch (error) {
		showError(error, t('nodes.enroll.loadFailed'));
	} finally {
		tokenStatusLoading.value = false;
	}
}

const rotateTokenAction = useAsyncAction(
	async () => {
		const wasConfigured = tokenStatus.value.configured;
		const result = await nodesApi.rotateEnrollmentToken();
		rotatedToken.value = result.token;
		tokenStatus.value = { configured: true, rotated_at: result.rotated_at };
		showSuccess(t(wasConfigured ? 'nodes.enroll.rotatedSuccess' : 'nodes.enroll.generatedSuccess'));
	},
	{ onError: (error) => showError(error, t('nodes.enroll.rotateFailed')) },
);

async function rotateEnrollmentToken(): Promise<void> {
	if (tokenStatus.value.configured && !(await confirmAction(t('nodes.enroll.rotateConfirm')))) return;
	await rotateTokenAction.run();
}

function resetDeployDialog(): void {
	rotatedToken.value = '';
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
		evictCachedResource(`nodes:detail:${target.id}`);
		evictCachedResource(`nodes:clients:${target.id}`);
		evictCachedResource(`nodes:configs:${target.id}`);
		evictCachedResource(`nodes:traffic:24h:${target.id}`);
		invalidateCachedResource('nodes:list');
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
		<ViewSwitch v-model="viewMode" />
		<el-button :loading="refreshing" @click="refresh">
			<AppIcon name="refresh" :size="14" class="btn-icon" />
			<span>{{ t('common.refresh') }}</span>
		</el-button>
		<el-button type="primary" @click="openDeployDialog">
			<AppIcon name="plus" :size="14" class="btn-icon" />
			<span>{{ t('nodes.deployNode') }}</span>
		</el-button>
	</PageToolbar>

	<div v-loading="loading" class="list-stage">
		<template v-if="filteredNodes.length > 0">
			<div v-if="viewMode === 'card'" class="card-grid">
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
		<el-card v-else-if="!loading" shadow="never" class="empty-stage-card">
			<el-empty :description="nodes.length === 0 ? t('nodes.empty') : t('nodes.emptyFiltered')">
				<el-button v-if="nodes.length === 0" type="primary" @click="openDeployDialog">{{ t('nodes.deployNode') }}</el-button>
				<el-button v-else @click="clearFilters">{{ t('nodes.clearFilters') }}</el-button>
			</el-empty>
		</el-card>
	</div>

	<el-dialog
		v-model="deployDialogVisible"
		:title="t('nodes.enroll.title')"
		width="680px"
		:close-on-click-modal="false"
		destroy-on-close
		@closed="resetDeployDialog"
	>
		<div v-loading="tokenStatusLoading" class="deploy-dialog-body">
			<template v-if="!tokenStatus.configured && !rotatedToken">
				<el-alert type="info" :closable="false" show-icon class="dialog-alert" :title="t('nodes.enroll.unconfiguredHint')" />
			</template>
			<template v-else>
				<el-alert
					v-if="rotatedToken"
					type="success"
					:closable="false"
					show-icon
					class="dialog-alert"
					:title="t('nodes.enroll.rotatedHint')"
				/>
				<template v-else>
					<p class="deploy-status">
						{{
							tokenStatus.rotated_at !== null
								? t('nodes.enroll.configuredStatus', { time: formatTimestamp(tokenStatus.rotated_at) })
								: t('nodes.enroll.configuredStatusNoTime')
						}}
					</p>
					<el-alert type="info" :closable="false" show-icon class="dialog-alert" :title="t('nodes.enroll.configuredHint')" />
				</template>

				<div v-if="rotatedToken" class="token-row">
					<span class="token-label">{{ t('nodes.enroll.tokenLabel') }}</span>
					<el-input :model-value="rotatedToken" readonly class="mono">
						<template #append>
							<el-button @click="copyText(rotatedToken)">{{ t('common.copy') }}</el-button>
						</template>
					</el-input>
				</div>

				<CodeBlock :code="deployCommand" label="bash" wrap />
				<p class="deploy-note">{{ t('nodes.enroll.adoptNote') }}</p>
			</template>
		</div>
		<template #footer>
			<template v-if="!tokenStatus.configured && !rotatedToken">
				<el-button @click="deployDialogVisible = false">{{ t('common.cancel') }}</el-button>
				<el-button type="primary" :loading="rotateTokenAction.running.value" @click="rotateEnrollmentToken">
					{{ t('nodes.enroll.generate') }}
				</el-button>
			</template>
			<template v-else>
				<el-button type="warning" plain :loading="rotateTokenAction.running.value" @click="rotateEnrollmentToken">
					{{ t('nodes.enroll.rotate') }}
				</el-button>
				<el-button type="primary" @click="deployDialogVisible = false">{{ t('common.close') }}</el-button>
			</template>
		</template>
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

.dialog-alert {
	margin-bottom: 12px;
}

.deploy-dialog-body {
	min-height: 72px;
}

.deploy-status {
	margin: 0 0 10px;
	font-size: 13px;
	color: var(--text-secondary);
}

.token-row {
	display: flex;
	align-items: center;
	gap: 12px;
	margin-bottom: 12px;
}

.token-label {
	flex: none;
	font-size: 13px;
	font-weight: 500;
	color: var(--text-secondary);
}

.deploy-note {
	margin: 10px 0 0;
	font-size: 12.5px;
	color: var(--text-muted);
}

.delete-confirm {
	margin: 0;
	color: var(--text-primary);
}

.delete-form {
	margin-top: 16px;
}
</style>
