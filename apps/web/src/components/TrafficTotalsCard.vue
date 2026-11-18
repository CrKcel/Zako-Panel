<script setup lang="ts">
import type { TrafficSummary } from '@zako/contracts';
import { computed } from 'vue';
import { sumTrafficItems } from '../domain/traffic';
import { formatBytes } from '../utils/format';
import AppIcon, { type IconName } from './AppIcon.vue';

const props = defineProps<{
	summary: TrafficSummary | null;
	title?: string;
	loading?: boolean;
}>();

const metrics = computed<Array<{ label: string; value: string; icon: IconName; tone: string }>>(() => {
	const totals = sumTrafficItems(props.summary?.items);
	return [
		{ label: '上行', value: formatBytes(totals.uplink), icon: 'arrow-up', tone: 'primary' },
		{ label: '下行', value: formatBytes(totals.downlink), icon: 'arrow-down', tone: 'success' },
		{ label: '总计', value: formatBytes(totals.total), icon: 'activity', tone: 'neutral' },
	];
});
</script>

<template>
	<el-card v-loading="loading" shadow="never" class="traffic-totals">
		<template v-if="title" #header>
			<div class="ui-card-header">
				<span class="ui-card-title">{{ title }}</span>
			</div>
		</template>
		<div class="metric-grid">
			<div v-for="metric in metrics" :key="metric.label" class="metric-tile">
				<div class="metric-head">
					<span class="metric-label">{{ metric.label }}</span>
					<span class="metric-icon" :class="`tone-${metric.tone}`">
						<AppIcon :name="metric.icon" :size="14" />
					</span>
				</div>
				<div class="metric-value tnum">{{ metric.value }}</div>
			</div>
		</div>
		<slot />
	</el-card>
</template>

<style scoped>
.traffic-totals {
	margin-bottom: 16px;
}

.metric-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 12px;
}

.metric-tile {
	padding: 14px 16px;
	background: var(--bg-muted);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
}

.metric-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.metric-label {
	font-size: 12.5px;
	font-weight: 500;
	color: var(--text-muted);
}

.metric-icon {
	width: 24px;
	height: 24px;
	border-radius: 6px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
}

.metric-icon.tone-primary {
	background: var(--accent-primary-soft);
	color: var(--accent-primary);
}

.metric-icon.tone-success {
	background: var(--tone-success-soft);
	color: var(--tone-success);
}

.metric-icon.tone-neutral {
	background: var(--bg-subtle);
	color: var(--text-secondary);
}

.metric-value {
	margin-top: 8px;
	font-size: 22px;
	font-weight: 600;
	letter-spacing: -0.02em;
	color: var(--text-primary);
}
</style>
