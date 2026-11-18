<script setup lang="ts">
import type { ConfigVersion, Endpoint } from '@zako/contracts';
import { computed, ref, watch } from 'vue';
import { nodesApi } from '../api/nodes';
import { useAsyncAction } from '../composables/useAsyncAction';
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
		showError(error, '配置历史加载失败');
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
		showError(error, '加载更多配置失败');
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
		return { label: '已生效', type: 'success' };
	}
	if (row.version === props.desiredVersion) {
		return row.last_error ? { label: '同步失败', type: 'danger' } : { label: '待同步', type: 'warning' };
	}
	if (row.version === props.appliedVersion) {
		return { label: '当前运行', type: 'success' };
	}
	if (row.last_error) {
		return { label: '曾失败', type: 'danger' };
	}
	return { label: '历史版本', type: 'info' };
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
			jsonError.value = error instanceof Error ? `JSON 格式错误: ${error.message}` : 'JSON 格式错误';
			throw error;
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			jsonError.value = '配置根节点必须是 JSON 对象';
			throw new Error(jsonError.value);
		}
		jsonError.value = '';
		await nodesApi.publishConfig(props.nodeId, parsed as Record<string, unknown>);
		publishVisible.value = false;
		showSuccess('配置已发布并进入下发队列');
		await loadConfigs();
		emit('changed');
	},
	{ onError: (error) => (jsonError.value ? undefined : showError(error, '配置发布失败')) },
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
	try {
		await confirmAction(`确认基于版本 v${row.version} 创建新版本并下发回滚？`, '回滚配置');
	} catch {
		return;
	}
	try {
		const created = await nodesApi.rollbackConfig(props.nodeId, row.version);
		showSuccess(`已基于 v${row.version} 生成新版本 v${created.version}`);
		await loadConfigs();
		emit('changed');
	} catch (error) {
		showError(error, '配置回滚失败');
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
				<span class="card-title">远程配置版本</span>
				<div class="header-actions">
					<el-button :loading="loading" @click="loadConfigs">刷新列表</el-button>
					<el-button type="primary" @click="openPublish">发布新配置</el-button>
				</div>
			</div>
		</template>

		<el-table v-loading="loading" :data="configs" empty-text="暂未发布过远程配置">
			<el-table-column label="版本" width="90">
				<template #default="{ row }">v{{ row.version }}</template>
			</el-table-column>
			<el-table-column label="状态" width="110">
				<template #default="{ row }">
					<StatusBadge :label="versionTag(row as ConfigVersion).label" :type="versionTag(row as ConfigVersion).type" />
				</template>
			</el-table-column>
			<el-table-column label="SHA-256" min-width="180">
				<template #default="{ row }">
					<span class="mono">{{ row.definition_sha256.slice(0, 12) }}…</span>
					<el-button link type="primary" @click="copyText(row.definition_sha256)">复制</el-button>
				</template>
			</el-table-column>
			<el-table-column label="发布时间" min-width="160">
				<template #default="{ row }">{{ formatTimestamp(row.created_at) }}</template>
			</el-table-column>
			<el-table-column label="生效时间" min-width="160">
				<template #default="{ row }">{{ formatTimestamp(row.applied_at) }}</template>
			</el-table-column>
			<el-table-column label="错误信息" min-width="200" show-overflow-tooltip>
				<template #default="{ row }">{{ row.last_error ?? '—' }}</template>
			</el-table-column>
			<el-table-column label="操作" width="160" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" @click="openDetail(row as ConfigVersion)">查看</el-button>
					<el-button link type="warning" :disabled="row.version === desiredVersion" @click="handleRollback(row as ConfigVersion)"
						>回滚</el-button
					>
				</template>
			</el-table-column>
		</el-table>

		<div v-if="nextCursor" class="load-more">
			<el-button :loading="loadingMore" @click="loadMore">加载更早版本</el-button>
		</div>
	</el-card>

	<el-dialog v-model="publishVisible" title="发布新配置" width="760px" :close-on-click-modal="false" destroy-on-close>
		<div class="editor-toolbar">
			<el-button size="small" :disabled="configs.length === 0" @click="fillFromLatest">从最新版本填充</el-button>
			<el-button size="small" @click="fillDefaultTemplate">生成默认 Xray 模板</el-button>
			<span class="hint">请勿填写 realitySettings.privateKey，节点会在本地自动注入私钥与用户列表。</span>
		</div>
		<el-input v-model="jsonInput" type="textarea" :rows="18" class="json-editor" placeholder="输入 Xray JSON 配置" />
		<div v-if="jsonError" class="json-error">{{ jsonError }}</div>
		<template #footer>
			<el-button @click="publishVisible = false">取消</el-button>
			<el-button type="primary" :loading="publishing" @click="runPublish">发布并下发</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="detailVisible" :title="inspecting ? `配置详情 v${inspecting.version}` : '配置详情'" width="920px" destroy-on-close>
		<div v-if="inspecting" class="detail-meta">
			<span
				>SHA-256: <code class="mono">{{ inspecting.definition_sha256 }}</code></span
			>
			<span v-if="inspecting.last_error" class="error-text">错误: {{ inspecting.last_error }}</span>
		</div>
		<div class="compare-grid" :class="{ single: !compareTarget }">
			<div>
				<div class="pane-title">版本 v{{ inspecting?.version }}</div>
				<pre class="json-preview">{{ formattedInspectJson }}</pre>
			</div>
			<div v-if="compareTarget">
				<div class="pane-title">当前已生效版本 v{{ compareTarget.version }}</div>
				<pre class="json-preview">{{ formattedCompareJson }}</pre>
			</div>
		</div>
		<template #footer>
			<el-button @click="detailVisible = false">关闭</el-button>
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
	color: #6b7280;
}

.json-editor :deep(textarea) {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
	line-height: 1.5;
}

.json-error {
	margin-top: 8px;
	font-size: 12px;
	color: #dc2626;
}

.detail-meta {
	display: flex;
	flex-direction: column;
	gap: 4px;
	margin-bottom: 12px;
	font-size: 12px;
	color: #4b5563;
}

.error-text {
	color: #dc2626;
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
	color: #374151;
}

.json-preview {
	margin: 0;
	padding: 12px;
	max-height: 460px;
	overflow: auto;
	background: #f9fafb;
	border: 1px solid #e5e7eb;
	border-radius: 6px;
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
	line-height: 1.45;
}
</style>
