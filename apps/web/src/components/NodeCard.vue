<script setup lang="ts">
import type { Node } from '@zako/contracts';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { healthDescriptor, nodeStatusDescriptor } from '../domain/status';
import { useI18n } from '../i18n';
import { formatDuration, formatPercent, formatTimestamp } from '../utils/format';
import StatusBadge from './StatusBadge.vue';

const props = defineProps<{
	node: Node;
	deleting?: boolean;
}>();

const emit = defineEmits<{
	delete: [node: Node];
}>();

const { t } = useI18n();

const statusDescriptor = computed(() => nodeStatusDescriptor(props.node.status));
const xrayHealth = computed(() => healthDescriptor(props.node.xray_healthy));
const statsHealth = computed(() => healthDescriptor(props.node.stats_healthy));

const cpuPercent = computed(() => clampPercent(props.node.sys?.cpu));
const memPercent = computed(() => clampPercent(props.node.sys?.mem));

const configPending = computed(() => props.node.desired_config_version > props.node.applied_config_version);
const errorMessage = computed(() => props.node.last_config_error || props.node.last_update_error || null);

const lastHeartbeatLabel = computed(() => (props.node.last_seen_at ? formatTimestamp(props.node.last_seen_at) : t('nodes.neverConnected')));

function clampPercent(ratio: number | null | undefined): number | null {
	if (ratio === null || ratio === undefined) return null;
	return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

function usageTone(percent: number): string {
	if (percent >= 95) return 'is-danger';
	if (percent >= 80) return 'is-warning';
	return 'is-primary';
}
</script>

<template>
	<article class="node-card" :class="{ 'is-disabled': !node.enabled, 'has-error': Boolean(errorMessage) }">
		<header class="card-header">
			<div class="header-main">
				<div class="title-row">
					<RouterLink :to="`/nodes/${node.id}`" class="node-name" :title="node.name">
						{{ node.name }}
					</RouterLink>
				</div>
				<div class="heartbeat-meta tnum">
					<span>{{ t('nodes.columns.lastHeartbeat') }}: {{ lastHeartbeatLabel }}</span>
					<span class="meta-sep">·</span>
					<span>{{ node.heartbeat_interval_seconds }}s</span>
				</div>
			</div>
			<StatusBadge :label="statusDescriptor.label" :type="statusDescriptor.tag" />
		</header>

		<div class="metrics-grid">
			<div class="metric-tile">
				<div class="metric-row">
					<span class="metric-label">{{ t('nodes.columns.cpu') }}</span>
					<span class="metric-value tnum">{{ formatPercent(node.sys?.cpu) }}</span>
				</div>
				<div class="usage-bar">
					<div v-if="cpuPercent !== null" class="usage-bar-fill" :class="usageTone(cpuPercent)" :style="{ width: `${cpuPercent}%` }" />
				</div>
			</div>

			<div class="metric-tile">
				<div class="metric-row">
					<span class="metric-label">{{ t('nodes.columns.memory') }}</span>
					<span class="metric-value tnum">{{ formatPercent(node.sys?.mem) }}</span>
				</div>
				<div class="usage-bar">
					<div v-if="memPercent !== null" class="usage-bar-fill" :class="usageTone(memPercent)" :style="{ width: `${memPercent}%` }" />
				</div>
			</div>

			<div class="metric-tile metric-inline">
				<span class="metric-label">{{ t('nodes.columns.load') }}</span>
				<span class="metric-value tnum">{{ node.sys ? node.sys.load.toFixed(2) : '—' }}</span>
			</div>

			<div class="metric-tile metric-inline">
				<span class="metric-label">{{ t('nodes.columns.uptime') }}</span>
				<span class="metric-value tnum">{{ formatDuration(node.sys?.uptime) }}</span>
			</div>
		</div>

		<dl class="meta-grid">
			<div class="meta-item">
				<dt>{{ t('nodes.columns.agent') }}</dt>
				<dd class="mono">{{ node.agent_version ?? '—' }}</dd>
			</div>
			<div class="meta-item">
				<dt>{{ t('nodes.columns.xray') }}</dt>
				<dd class="mono">{{ node.xray_version ?? '—' }}</dd>
			</div>
			<div class="meta-item">
				<dt>{{ t('nodes.columns.configVersion') }}</dt>
				<dd class="tnum config-version">
					<span>v{{ node.applied_config_version }} / v{{ node.desired_config_version }}</span>
					<span v-if="configPending" class="pending-pill">{{ t('nodes.configPending') }}</span>
				</dd>
			</div>
			<div class="meta-item">
				<dt>{{ t('common.enabled') }}</dt>
				<dd>
					<span class="inline-state">
						<span class="state-dot" :class="node.enabled ? 'is-success' : 'is-info'" />
						<span>{{ node.enabled ? t('common.enabled') : t('common.disabled') }}</span>
					</span>
				</dd>
			</div>
			<div class="meta-item meta-item-wide">
				<dt>{{ t('nodes.columns.xrayHealth') }} / {{ t('nodes.columns.statsHealth') }}</dt>
				<dd class="health-pair">
					<span class="inline-state">
						<span class="state-dot" :class="`is-${xrayHealth.tag}`" />
						<span>{{ t('nodes.columns.xrayHealth') }} {{ xrayHealth.label }}</span>
					</span>
					<span class="meta-sep">·</span>
					<span class="inline-state">
						<span class="state-dot" :class="`is-${statsHealth.tag}`" />
						<span>{{ t('nodes.columns.statsHealth') }} {{ statsHealth.label }}</span>
					</span>
				</dd>
			</div>
		</dl>

		<div v-if="errorMessage" class="error-banner" :title="errorMessage">
			{{ errorMessage }}
		</div>

		<footer class="card-actions">
			<RouterLink :to="`/nodes/${node.id}`" custom v-slot="{ navigate }">
				<el-button link type="primary" @click="navigate">{{ t('common.details') }}</el-button>
			</RouterLink>
			<el-button link type="danger" :loading="deleting" @click="emit('delete', node)">
				{{ node.status === 'uninstalling' ? t('common.forceDelete') : t('common.delete') }}
			</el-button>
		</footer>
	</article>
</template>

<style scoped>
.node-card {
	background: var(--bg-surface);
	border: 1px solid var(--border-color);
	border-radius: var(--radius-lg);
	padding: 18px 20px 14px;
	box-shadow: var(--shadow-xs);
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-width: 0;
	transition: border-color 0.15s ease;
}

.node-card:hover {
	border-color: var(--border-hover);
}

.node-card.has-error {
	border-color: color-mix(in srgb, var(--tone-danger) 40%, var(--border-color));
}

.node-card.is-disabled .metrics-grid,
.node-card.is-disabled .meta-grid {
	opacity: 0.72;
}

.card-header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
}

.header-main {
	min-width: 0;
	flex: 1;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.title-row {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

.node-name {
	font-size: 15.5px;
	font-weight: 600;
	color: var(--text-primary);
	text-decoration: none;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	transition: color 0.15s ease;
}

.node-name:hover {
	color: var(--accent-primary);
	text-decoration: underline;
}

.heartbeat-meta {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 5px;
	font-size: 12px;
	color: var(--text-muted);
}

.meta-sep {
	color: var(--text-placeholder);
}

.metrics-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 8px;
}

.metric-tile {
	padding: 10px 12px;
	background: var(--bg-muted);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	display: flex;
	flex-direction: column;
	gap: 7px;
}

.metric-tile.metric-inline {
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.metric-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.metric-label {
	font-size: 12px;
	font-weight: 500;
	color: var(--text-muted);
}

.metric-value {
	font-size: 13px;
	font-weight: 600;
	color: var(--text-primary);
}

.usage-bar {
	width: 100%;
	height: 4px;
	background: var(--bg-subtle);
	border-radius: 9999px;
	overflow: hidden;
}

.usage-bar-fill {
	height: 100%;
	border-radius: 9999px;
	transition: width 0.2s ease;
}

.usage-bar-fill.is-primary {
	background: var(--accent-primary);
}

.usage-bar-fill.is-warning {
	background: var(--tone-warning);
}

.usage-bar-fill.is-danger {
	background: var(--tone-danger);
}

.meta-grid {
	margin: 0;
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 8px 12px;
}

.meta-item {
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.meta-item-wide {
	grid-column: 1 / -1;
}

.meta-item dt {
	font-size: 11.5px;
	font-weight: 500;
	color: var(--text-muted);
}

.meta-item dd {
	margin: 0;
	font-size: 12.5px;
	color: var(--text-table);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.config-version {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.pending-pill {
	padding: 1px 6px;
	border-radius: 9999px;
	font-size: 11px;
	font-weight: 500;
	background: var(--tone-warning-soft);
	color: var(--tone-warning-text);
}

.inline-state {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.health-pair {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 6px;
}

.state-dot {
	width: 6px;
	height: 6px;
	border-radius: 9999px;
	flex: none;
	background: var(--tone-info);
}

.state-dot.is-success {
	background: var(--tone-success);
}

.state-dot.is-warning {
	background: var(--tone-warning);
}

.state-dot.is-danger {
	background: var(--tone-danger);
}

.state-dot.is-info {
	background: var(--tone-info);
}

.error-banner {
	padding: 8px 10px;
	border-radius: var(--radius-sm);
	background: var(--tone-danger-soft);
	color: var(--tone-danger-text);
	font-size: 12px;
	line-height: 1.45;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
	word-break: break-word;
}

.card-actions {
	margin-top: auto;
	padding-top: 12px;
	border-top: 1px solid var(--border-subtle);
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	flex-wrap: wrap;
}

.card-actions :deep(.el-button + .el-button) {
	margin-left: 0;
}
</style>
