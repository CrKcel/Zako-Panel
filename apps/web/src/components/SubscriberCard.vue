<script setup lang="ts">
import type { Profile, Subscriber, Subscription } from '@zako/contracts';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { subscriberStatusDescriptor, subscriptionStatusDescriptor } from '../domain/status';
import { subscriberUsageRatio, usageCycleLabel, usageLabel, usageTone } from '../domain/subscriber';
import { useI18n } from '../i18n';
import { formatBytes, formatTimestamp } from '../utils/format';
import AppIcon from './AppIcon.vue';
import StatusBadge from './StatusBadge.vue';

const props = defineProps<{
	subscriber: Subscriber;
	subscriptions: Subscription[];
	profiles: Profile[];
	disabling?: boolean;
	isRevoking?: (id: string) => boolean;
}>();

const emit = defineEmits<{
	edit: [subscriber: Subscriber];
	disable: [subscriber: Subscriber];
	createSubscription: [subscriber: Subscriber];
	showSubscriptionLinks: [subscription: Subscription];
	editSubscription: [subscription: Subscription];
	revokeSubscription: [subscription: Subscription];
}>();

const { t } = useI18n();

const expanded = ref(false);

const statusDescriptor = computed(() => subscriberStatusDescriptor(props.subscriber.status));
const ratio = computed(() => subscriberUsageRatio(props.subscriber));
const uplinkBytes = computed(() => props.subscriber.usage?.uplink_bytes ?? 0);
const downlinkBytes = computed(() => props.subscriber.usage?.downlink_bytes ?? 0);
const cycleLabel = computed(() => usageCycleLabel(props.subscriber));
const expiresLabel = computed(() =>
	props.subscriber.expires_at ? formatTimestamp(props.subscriber.expires_at) : t('subscribers.neverExpires'),
);

const profileNameMap = computed(() => new Map(props.profiles.map((profile) => [profile.id, profile.name])));

function profileName(sub: Subscription): string {
	return sub.profile_name ?? profileNameMap.value.get(sub.profile_id) ?? sub.profile_id;
}

function isSubActive(sub: Subscription): boolean {
	return sub.revoked_at === null && (sub.expires_at === null || sub.expires_at * 1000 > Date.now());
}
</script>

<template>
	<article class="subscriber-card" :class="{ 'is-disabled': subscriber.status === 'disabled' }">
		<header class="card-header">
			<div class="header-main">
				<div class="title-row">
					<RouterLink :to="`/subscribers/${subscriber.id}`" class="subscriber-name" :title="subscriber.name">
						{{ subscriber.name }}
					</RouterLink>
				</div>
				<div class="subscriber-sub" :title="subscriber.email ?? undefined">
					<span class="sub-email">{{ subscriber.email || t('subscribers.noEmail') }}</span>
				</div>
			</div>
			<StatusBadge :label="statusDescriptor.label" :type="statusDescriptor.tag" :pulse="subscriber.status === 'active'" />
		</header>

		<div class="metrics-grid">
			<div class="metric-tile metric-tile-wide">
				<div class="metric-row">
					<span class="metric-label">{{ t('subscribers.columns.usedQuota') }}</span>
					<span class="metric-value tnum">
						{{ usageLabel(subscriber) }}
						<span v-if="ratio !== null" class="usage-pct">({{ ratio }}%)</span>
					</span>
				</div>
				<div class="usage-bar">
					<div v-if="ratio !== null" class="usage-bar-fill" :class="usageTone(ratio)" :style="{ width: `${ratio}%` }" />
				</div>
				<div class="traffic-breakdown tnum">
					<span>↑ {{ formatBytes(uplinkBytes) }}</span>
					<span class="meta-sep">·</span>
					<span>↓ {{ formatBytes(downlinkBytes) }}</span>
				</div>
			</div>

			<div class="metric-tile metric-tile-wide metric-inline">
				<span class="metric-label">{{ t('subscribers.columns.subscriptions') }}</span>
				<button type="button" class="sub-count-btn tnum" :aria-expanded="expanded" @click="expanded = !expanded">
					<AppIcon name="subscriptions" :size="12" />
					<span>{{ subscriptions.length }}</span>
					<AppIcon name="chevron-right" :size="12" class="expand-chevron" :class="{ 'is-open': expanded }" />
				</button>
			</div>
		</div>

		<dl class="meta-grid">
			<div class="meta-item">
				<dt>{{ t('subscribers.columns.expiresAt') }}</dt>
				<dd class="tnum" :title="expiresLabel">{{ expiresLabel }}</dd>
			</div>
			<div class="meta-item">
				<dt>{{ t('subscribers.columns.cycle') }}</dt>
				<dd class="tnum" :title="cycleLabel">{{ cycleLabel }}</dd>
			</div>
		</dl>

		<section v-if="expanded" class="subs-panel">
			<div class="subs-panel-header">
				<span class="subs-panel-title">
					<AppIcon name="subscriptions" :size="13" />
					<span>{{ t('nav.subscriptions') }} ({{ subscriptions.length }})</span>
				</span>
				<el-button link type="primary" size="small" @click="emit('createSubscription', subscriber)">
					<AppIcon name="plus" :size="12" class="btn-icon" />
					<span>{{ t('subscriptions.create') }}</span>
				</el-button>
			</div>
			<div v-if="subscriptions.length === 0" class="subs-empty">{{ t('subscriptions.empty') }}</div>
			<ul v-else class="subs-list">
				<li v-for="sub in subscriptions" :key="sub.id" class="sub-item">
					<div class="sub-item-main">
						<div class="sub-item-top">
							<span class="sub-item-name" :title="sub.name">{{ sub.name }}</span>
							<StatusBadge
								:label="subscriptionStatusDescriptor(sub).label"
								:type="subscriptionStatusDescriptor(sub).tag"
								:pulse="isSubActive(sub)"
							/>
						</div>
						<div class="sub-item-meta tnum">
							<span class="sub-item-profile" :title="profileName(sub)">{{ profileName(sub) }}</span>
							<span class="meta-sep">·</span>
							<span>{{ sub.expires_at ? formatTimestamp(sub.expires_at) : t('subscribers.neverExpires') }}</span>
						</div>
					</div>
					<div class="sub-item-actions">
						<el-button link type="primary" size="small" @click="emit('showSubscriptionLinks', sub)">
							{{ t('subscriptions.actions.links') }}
						</el-button>
						<el-button link type="primary" size="small" :disabled="sub.revoked_at !== null" @click="emit('editSubscription', sub)">
							{{ t('common.edit') }}
						</el-button>
						<el-button
							link
							type="danger"
							size="small"
							:disabled="sub.revoked_at !== null"
							:loading="isRevoking?.(sub.id) ?? false"
							@click="emit('revokeSubscription', sub)"
						>
							{{ t('subscriptions.actions.revoke') }}
						</el-button>
					</div>
				</li>
			</ul>
		</section>

		<footer class="card-actions">
			<div class="actions-primary">
				<RouterLink :to="`/subscribers/${subscriber.id}`" custom v-slot="{ navigate }">
					<el-button link type="primary" @click="navigate">{{ t('common.details') }}</el-button>
				</RouterLink>
				<el-button link type="primary" @click="emit('edit', subscriber)">{{ t('common.edit') }}</el-button>
			</div>
			<el-button link type="danger" :loading="disabling" @click="emit('disable', subscriber)">
				{{ t('subscribers.actions.disable') }}
			</el-button>
		</footer>
	</article>
</template>

<style scoped>
.subscriber-card {
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

.subscriber-card:hover {
	border-color: var(--border-hover);
	box-shadow: var(--shadow-sm);
}

.subscriber-card.is-disabled .metrics-grid,
.subscriber-card.is-disabled .meta-grid {
	opacity: 0.68;
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

.subscriber-name {
	font-size: 15.5px;
	font-weight: 600;
	color: var(--text-primary);
	text-decoration: none;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	transition: color var(--duration-fast) var(--ease-standard);
}

.subscriber-name:hover {
	color: var(--accent-primary);
	text-decoration: underline;
}

.subscriber-sub {
	display: flex;
	align-items: center;
	min-width: 0;
	font-size: 12px;
	color: var(--text-muted);
}

.sub-email {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
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

.metric-tile-wide {
	grid-column: 1 / -1;
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

.usage-pct {
	font-weight: 500;
	color: var(--text-muted);
	margin-left: 2px;
}

.usage-bar {
	width: 100%;
	height: 4px;
	background: var(--bg-subtle);
	border-radius: var(--radius-pill);
	overflow: hidden;
}

.usage-bar-fill {
	height: 100%;
	border-radius: var(--radius-pill);
	transition: width var(--duration-normal) var(--ease-standard);
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

.traffic-breakdown {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 11.5px;
	color: var(--text-muted);
}

.sub-count-btn {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	height: 22px;
	padding: 0 8px;
	border: 1px solid var(--border-color);
	border-radius: var(--radius-pill);
	background: var(--bg-surface);
	color: var(--accent-primary);
	font-family: inherit;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		border-color var(--duration-fast) var(--ease-standard);
}

.sub-count-btn:hover {
	background: var(--accent-primary-soft);
	border-color: var(--accent-primary-border);
}

.expand-chevron {
	transition: transform var(--duration-fast) var(--ease-standard);
}

.expand-chevron.is-open {
	transform: rotate(90deg);
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

.subs-panel {
	padding: 10px 12px;
	border-radius: var(--radius-md);
	background: var(--bg-muted);
	border: 1px solid var(--border-subtle);
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.subs-panel-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.subs-panel-title {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	font-size: 12px;
	font-weight: 600;
	color: var(--text-primary);
}

.btn-icon {
	margin-right: 3px;
}

.subs-empty {
	font-size: 12px;
	color: var(--text-muted);
	padding: 4px 0;
}

.subs-list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.sub-item {
	padding: 8px 10px;
	border-radius: var(--radius-sm);
	background: var(--bg-surface);
	border: 1px solid var(--border-color);
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.sub-item-main {
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 3px;
}

.sub-item-top {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.sub-item-name {
	font-size: 12.5px;
	font-weight: 600;
	color: var(--text-primary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.sub-item-meta {
	display: flex;
	align-items: center;
	gap: 5px;
	font-size: 11.5px;
	color: var(--text-muted);
	min-width: 0;
}

.sub-item-profile {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.sub-item-actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 10px;
}

.sub-item-actions :deep(.el-button + .el-button) {
	margin-left: 0;
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
