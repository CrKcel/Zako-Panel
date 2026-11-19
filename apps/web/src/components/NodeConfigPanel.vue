<script setup lang="ts">
import type { ConfigVersion, Endpoint } from '@zako/contracts';
import { computed, ref, watch } from 'vue';
import { nodesApi } from '../api/nodes';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useI18n } from '../i18n';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';
import StatusBadge from './StatusBadge.vue';

const props = defineProps<{
	nodeId: string;
	appliedVersion: number;
	desiredVersion: number;
	endpoints: Endpoint[];
}>();

const emit = defineEmits<{
	changed: [];
}>();

const { t } = useI18n();

const configs = ref<ConfigVersion[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const loadingMore = ref(false);

const publishVisible = ref(false);
const jsonInput = ref('');
const jsonError = ref('');

const detailVisible = ref(false);
const inspecting = ref<ConfigVersion | null>(null);
const compareTarget = ref<ConfigVersion | null>(null);

async function loadConfigs(): Promise<void> {
	if (!props.nodeId) return;
	loading.value = true;
	try {
		const page = await nodesApi.listConfigs(props.nodeId);
		configs.value = page.items;
		nextCursor.value = page.next_cursor;
	} catch (error) {
		showError(error, t('nodeConfig.loadError'));
	} finally {
		loading.value = false;
	}
}

async function loadMore(): Promise<void> {
	if (!nextCursor.value || loadingMore.value) return;
	loadingMore.value = true;
	try {
		const page = await nodesApi.listConfigs(props.nodeId, { cursor: nextCursor.value });
		configs.value = [...configs.value, ...page.items];
		nextCursor.value = page.next_cursor;
	} catch (error) {
		showError(error, t('nodeConfig.loadMoreError'));
	} finally {
		loadingMore.value = false;
	}
}

watch(
	() => props.nodeId,
	() => {
		void loadConfigs();
	},
	{ immediate: true },
);

function versionTag(row: ConfigVersion): { label: string; type: 'success' | 'warning' | 'danger' | 'info' } {
	if (row.version === props.appliedVersion && row.version === props.desiredVersion) {
		return { label: t('nodeConfig.tags.applied'), type: 'success' };
	}
	if (row.version === props.desiredVersion) {
		return row.last_error
			? { label: t('nodeConfig.tags.syncFailed'), type: 'danger' }
			: { label: t('nodeConfig.tags.pending'), type: 'warning' };
	}
	if (row.version === props.appliedVersion) {
		return { label: t('nodeConfig.tags.running'), type: 'success' };
	}
	if (row.last_error) {
		return { label: t('nodeConfig.tags.previouslyFailed'), type: 'danger' };
	}
	return { label: t('nodeConfig.tags.history'), type: 'info' };
}

function buildDefaultTemplate(): Record<string, unknown> {
	const first = props.endpoints[0];
	const port = first?.port ?? 443;
	const sni = first?.params.sni ?? 'www.microsoft.com';
	const shortId = first?.params.short_id ?? '0123456789abcdef';
	const fingerprint = first?.params.fingerprint ?? 'chrome';

	return {
		log: { loglevel: 'warning' },
		stats: {},
		policy: {
			levels: {
				'0': {
					statsUserUplink: true,
					statsUserDownlink: true,
				},
			},
			system: {
				statsInboundUplink: true,
				statsInboundDownlink: true,
			},
		},
		api: {
			tag: 'api',
			services: ['StatsService', 'HandlerService'],
		},
		inbounds: [
			{
				tag: 'api',
				listen: '127.0.0.1',
				port: 10085,
				protocol: 'dokodemo-door',
				settings: { address: '127.0.0.1' },
			},
			{
				tag: 'vless-reality',
				listen: '0.0.0.0',
				port,
				protocol: 'vless',
				settings: {
					clients: [],
					decryption: 'none',
				},
				streamSettings: {
					network: 'tcp',
					security: 'reality',
					realitySettings: {
						show: false,
						dest: `${sni}:443`,
						xver: 0,
						serverNames: [sni],
						shortIds: [shortId],
						fingerprint,
					},
				},
			},
		],
		outbounds: [{ protocol: 'freedom', tag: 'direct' }],
	};
}

function openPublish(): void {
	jsonError.value = '';
	const latest = configs.value[0];
	const initial = latest ? latest.definition : buildDefaultTemplate();
	jsonInput.value = JSON.stringify(initial, null, 2);
	publishVisible.value = true;
}

function fillFromLatest(): void {
	const latest = configs.value[0];
	if (!latest) return;
	jsonError.value = '';
	jsonInput.value = JSON.stringify(latest.definition, null, 2);
}

function fillDefaultTemplate(): void {
	jsonError.value = '';
	jsonInput.value = JSON.stringify(buildDefaultTemplate(), null, 2);
}

const { running: publishing, run: runPublish } = useAsyncAction(
	async () => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonInput.value);
		} catch (error) {
			jsonError.value =
				error instanceof Error
					? t('nodeConfig.publish.jsonErrorWithReason', { message: error.message })
					: t('nodeConfig.publish.jsonError');
			throw error;
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			jsonError.value = t('nodeConfig.publish.rootObjectError');
			throw new Error(jsonError.value);
		}
		jsonError.value = '';
		await nodesApi.publishConfig(props.nodeId, parsed as Record<string, unknown>);
		publishVisible.value = false;
		showSuccess(t('nodeConfig.publish.success'));
		await loadConfigs();
		emit('changed');
	},
	{ onError: (error) => (jsonError.value ? undefined : showError(error, t('nodeConfig.publish.failed'))) },
);

async function openDetail(row: ConfigVersion): Promise<void> {
	inspecting.value = row;
	compareTarget.value = null;
	detailVisible.value = true;
	if (props.appliedVersion > 0 && props.appliedVersion !== row.version) {
		const cached = configs.value.find((item) => item.version === props.appliedVersion);
		if (cached) {
			compareTarget.value = cached;
		} else {
			try {
				compareTarget.value = await nodesApi.getConfig(props.nodeId, props.appliedVersion);
			} catch {
				// 忽略对照版本加载失败，保留单版本查看
			}
		}
	}
}

async function handleRollback(row: ConfigVersion): Promise<void> {
	if (!(await confirmAction(t('nodeConfig.rollback.confirm', { version: row.version }), t('nodeConfig.rollback.title')))) return;
	try {
		const created = await nodesApi.rollbackConfig(props.nodeId, row.version);
		showSuccess(t('nodeConfig.rollback.success', { prev: row.version, next: created.version }));
		await loadConfigs();
		emit('changed');
	} catch (error) {
		showError(error, t('nodeConfig.rollback.failed'));
	}
}

const formattedInspectJson = computed(() => (inspecting.value ? JSON.stringify(inspecting.value.definition, null, 2) : ''));
const formattedCompareJson = computed(() => (compareTarget.value ? JSON.stringify(compareTarget.value.definition, null, 2) : ''));

defineExpose({ reload: loadConfigs });
</script>

<template>
	<el-card shadow="never" class="section">
		<template #header>
			<div class="card-header">
				<span class="card-title">{{ t('nodeConfig.title') }}</span>
				<div class="header-actions">
					<el-button :loading="loading" @click="loadConfigs">{{ t('nodeConfig.refreshList') }}</el-button>
					<el-button type="primary" @click="openPublish">{{ t('nodeConfig.publishNew') }}</el-button>
				</div>
			</div>
		</template>

		<el-table v-loading="loading" :data="configs" :empty-text="t('nodeConfig.empty')">
			<el-table-column :label="t('nodeConfig.columns.version')" width="90">
				<template #default="{ row }">v{{ row.version }}</template>
			</el-table-column>
			<el-table-column :label="t('common.status')" width="130">
				<template #default="{ row }">
					<StatusBadge :label="versionTag(row as ConfigVersion).label" :type="versionTag(row as ConfigVersion).type" />
				</template>
			</el-table-column>
			<el-table-column :label="t('nodeConfig.columns.sha256')" min-width="180">
				<template #default="{ row }">
					<span class="mono">{{ row.definition_sha256.slice(0, 12) }}…</span>
					<el-button link type="primary" @click="copyText(row.definition_sha256)">{{ t('common.copy') }}</el-button>
				</template>
			</el-table-column>
			<el-table-column :label="t('nodeConfig.columns.publishedAt')" min-width="165">
				<template #default="{ row }">{{ formatTimestamp(row.created_at) }}</template>
			</el-table-column>
			<el-table-column :label="t('nodeConfig.columns.appliedAt')" min-width="165">
				<template #default="{ row }">{{ formatTimestamp(row.applied_at) }}</template>
			</el-table-column>
			<el-table-column :label="t('nodeConfig.columns.error')" min-width="200" show-overflow-tooltip>
				<template #default="{ row }">{{ row.last_error ?? '—' }}</template>
			</el-table-column>
			<el-table-column :label="t('common.actions')" width="170" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" @click="openDetail(row as ConfigVersion)">{{ t('nodeConfig.actions.view') }}</el-button>
					<el-button link type="warning" :disabled="row.version === desiredVersion" @click="handleRollback(row as ConfigVersion)">{{
						t('nodeConfig.actions.rollback')
					}}</el-button>
				</template>
			</el-table-column>
		</el-table>

		<div v-if="nextCursor" class="load-more">
			<el-button :loading="loadingMore" @click="loadMore">{{ t('nodeConfig.loadEarlier') }}</el-button>
		</div>
	</el-card>

	<el-dialog v-model="publishVisible" :title="t('nodeConfig.publish.title')" width="760px" :close-on-click-modal="false" destroy-on-close>
		<div class="editor-toolbar">
			<el-button size="small" :disabled="configs.length === 0" @click="fillFromLatest">{{ t('nodeConfig.publish.fillLatest') }}</el-button>
			<el-button size="small" @click="fillDefaultTemplate">{{ t('nodeConfig.publish.loadTemplate') }}</el-button>
			<span class="hint">{{ t('nodeConfig.publish.hint') }}</span>
		</div>
		<el-input v-model="jsonInput" type="textarea" :rows="18" class="json-editor" :placeholder="t('nodeConfig.publish.placeholder')" />
		<div v-if="jsonError" class="json-error">{{ jsonError }}</div>
		<template #footer>
			<el-button @click="publishVisible = false">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="publishing" @click="runPublish">{{ t('nodeConfig.publish.submit') }}</el-button>
		</template>
	</el-dialog>

	<el-dialog
		v-model="detailVisible"
		:title="inspecting ? t('nodeConfig.detail.titleWithVersion', { version: inspecting.version }) : t('nodeConfig.detail.title')"
		width="920px"
		destroy-on-close
	>
		<div v-if="inspecting" class="detail-meta">
			<span
				>{{ t('nodeConfig.columns.sha256') }}: <code class="mono">{{ inspecting.definition_sha256 }}</code></span
			>
			<span v-if="inspecting.last_error" class="error-text">{{
				t('nodeConfig.detail.errorPrefix', { error: inspecting.last_error })
			}}</span>
		</div>
		<div class="compare-grid" :class="{ single: !compareTarget }">
			<div>
				<div class="pane-title">{{ t('nodeConfig.detail.versionPane', { version: inspecting?.version ?? '' }) }}</div>
				<pre class="json-preview">{{ formattedInspectJson }}</pre>
			</div>
			<div v-if="compareTarget">
				<div class="pane-title">{{ t('nodeConfig.detail.activePane', { version: compareTarget.version }) }}</div>
				<pre class="json-preview">{{ formattedCompareJson }}</pre>
			</div>
		</div>
		<template #footer>
			<el-button @click="detailVisible = false">{{ t('common.close') }}</el-button>
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

.header-actions {
	display: flex;
	gap: 8px;
}

.mono {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
	margin-right: 6px;
}

.load-more {
	display: flex;
	justify-content: center;
	margin-top: 12px;
}

.editor-toolbar {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
	margin-bottom: 10px;
}

.hint {
	font-size: 12px;
	color: var(--text-muted);
}

.json-editor :deep(textarea) {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
	line-height: 1.5;
}

.json-error {
	margin-top: 8px;
	font-size: 12px;
	color: var(--tone-danger);
}

.detail-meta {
	display: flex;
	flex-direction: column;
	gap: 4px;
	margin-bottom: 12px;
	font-size: 12px;
	color: var(--text-secondary);
}

.error-text {
	color: var(--tone-danger);
}

.compare-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
}

.compare-grid.single {
	grid-template-columns: 1fr;
}

.pane-title {
	margin-bottom: 6px;
	font-size: 13px;
	font-weight: 600;
	color: var(--text-secondary);
}

.json-preview {
	margin: 0;
	padding: 12px;
	max-height: 460px;
	overflow: auto;
	background: var(--bg-muted);
	border: 1px solid var(--border-color);
	border-radius: 6px;
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
	line-height: 1.45;
	color: var(--text-primary);
}
</style>
