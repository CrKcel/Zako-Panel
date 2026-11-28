<script setup lang="ts">
import type { Profile } from '@zako/contracts';
import { computed } from 'vue';
import { useI18n } from '../i18n';
import { formatTimestamp } from '../utils/format';
import StatusBadge from './StatusBadge.vue';

const props = defineProps<{
	profile: Profile;
	deleting?: boolean;
}>();

const emit = defineEmits<{
	preview: [profile: Profile];
	edit: [profile: Profile];
	delete: [profile: Profile];
}>();

const { t } = useI18n();

const MAX_VISIBLE_GROUPS = 4;

const visibleGroups = computed(() => props.profile.proxy_groups.slice(0, MAX_VISIBLE_GROUPS));
const extraGroupCount = computed(() => Math.max(0, props.profile.proxy_groups.length - MAX_VISIBLE_GROUPS));
</script>

<template>
	<article class="profile-card">
		<header class="card-header">
			<div class="header-main">
				<div class="title-row">
					<button type="button" class="profile-name" :title="profile.name" @click="emit('edit', profile)">
						{{ profile.name }}
					</button>
				</div>
				<div class="profile-sub" :title="profile.description ?? undefined">
					<span class="sub-desc">{{ profile.description || t('profiles.noDescription') }}</span>
				</div>
			</div>
			<StatusBadge
				:label="profile.node_selection === 'all' ? t('profiles.selection.all') : t('profiles.selection.selected')"
				:type="profile.node_selection === 'all' ? 'primary' : 'info'"
			/>
		</header>

		<div class="metrics-grid">
			<div class="metric-tile metric-inline">
				<span class="metric-label">{{ t('profiles.columns.proxyGroups') }}</span>
				<span class="metric-value tnum">{{ profile.proxy_groups.length }}</span>
			</div>

			<div class="metric-tile metric-inline">
				<span class="metric-label">{{ t('profiles.columns.rulesCount') }}</span>
				<span class="metric-value tnum">{{ profile.rules.length }}</span>
			</div>

			<div class="metric-tile metric-inline">
				<span class="metric-label">{{ t('profiles.columns.onlineOnly') }}</span>
				<span class="inline-state">
					<span class="state-dot" :class="profile.online_only ? 'is-success' : 'is-info'" />
					<span class="metric-value-sm">{{ profile.online_only ? t('common.enabled') : t('common.off') }}</span>
				</span>
			</div>

			<div class="metric-tile metric-inline">
				<span class="metric-label">{{ t('profiles.columns.revision') }}</span>
				<span class="metric-value tnum mono">v{{ profile.revision }}</span>
			</div>
		</div>

		<dl class="meta-grid">
			<div class="meta-item meta-item-wide">
				<dt>{{ t('profiles.columns.proxyGroups') }}</dt>
				<dd class="group-tags-dd">
					<div v-if="visibleGroups.length > 0" class="group-tags">
						<span v-for="group in visibleGroups" :key="group.name" class="group-pill" :title="`${group.name} (${group.type})`">
							{{ group.name }}
						</span>
						<span v-if="extraGroupCount > 0" class="group-pill is-extra tnum">+{{ extraGroupCount }}</span>
					</div>
					<span v-else>—</span>
				</dd>
			</div>
			<div class="meta-item">
				<dt>{{ t('profiles.columns.updatedAt') }}</dt>
				<dd class="tnum">{{ formatTimestamp(profile.updated_at) }}</dd>
			</div>
			<div class="meta-item">
				<dt>{{ t('profiles.columns.createdAt') }}</dt>
				<dd class="tnum">{{ formatTimestamp(profile.created_at) }}</dd>
			</div>
		</dl>

		<footer class="card-actions">
			<div class="actions-primary">
				<el-button link type="primary" @click="emit('preview', profile)">{{ t('profiles.actions.preview') }}</el-button>
				<el-button link type="primary" @click="emit('edit', profile)">{{ t('common.edit') }}</el-button>
			</div>
			<el-button link type="danger" :loading="deleting" @click="emit('delete', profile)">
				{{ t('common.delete') }}
			</el-button>
		</footer>
	</article>
</template>

<style scoped>
.profile-card {
	background: var(--bg-surface);
	border: 1px solid var(--border-color);
	border-radius: var(--radius-lg);
	padding: 18px 20px 14px;
	box-shadow: var(--shadow-xs);
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-width: 0;
	transition:
		border-color var(--duration-fast) var(--ease-standard),
		box-shadow var(--duration-fast) var(--ease-standard);
}

.profile-card:hover {
	border-color: var(--border-hover);
	box-shadow: var(--shadow-sm);
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

.profile-name {
	padding: 0;
	border: none;
	background: transparent;
	font-family: inherit;
	font-size: 15.5px;
	font-weight: 600;
	color: var(--text-primary);
	text-align: left;
	cursor: pointer;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	transition: color var(--duration-fast) var(--ease-standard);
}

.profile-name:hover {
	color: var(--accent-primary);
	text-decoration: underline;
}

.profile-sub {
	display: flex;
	align-items: center;
	min-width: 0;
	font-size: 12px;
	color: var(--text-muted);
}

.sub-desc {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
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

.metric-value-sm {
	font-size: 12.5px;
	font-weight: 500;
	color: var(--text-primary);
}

.inline-state {
	display: inline-flex;
	align-items: center;
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

.state-dot.is-info {
	background: var(--tone-info);
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

.meta-item dd.group-tags-dd {
	overflow: visible;
	white-space: normal;
}

.group-tags {
	display: flex;
	flex-wrap: wrap;
	gap: 5px;
	margin-top: 2px;
}

.group-pill {
	display: inline-flex;
	align-items: center;
	max-width: 140px;
	padding: 2px 8px;
	border-radius: var(--radius-pill);
	background: var(--bg-muted);
	border: 1px solid var(--border-color);
	font-size: 11.5px;
	color: var(--text-secondary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.group-pill.is-extra {
	background: var(--accent-primary-soft);
	border-color: var(--accent-primary-border);
	color: var(--accent-primary);
	font-weight: 600;
}

.card-actions {
	margin-top: auto;
	padding-top: 10px;
	border-top: 1px solid var(--border-subtle);
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	flex-wrap: wrap;
}

.actions-primary {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}

.card-actions :deep(.el-button + .el-button) {
	margin-left: 0;
}
</style>
