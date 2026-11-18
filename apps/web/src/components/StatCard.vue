<script setup lang="ts">
import type { IconName } from './AppIcon.vue';
import AppIcon from './AppIcon.vue';

export type StatTone = 'default' | 'primary' | 'success' | 'warning' | 'danger';

withDefaults(
	defineProps<{
		label: string;
		value: string | number;
		hint?: string;
		icon?: IconName;
		tone?: StatTone;
	}>(),
	{
		tone: 'default',
	},
);
</script>

<template>
	<div class="stat-card">
		<div class="stat-top">
			<span class="stat-label">{{ label }}</span>
			<span v-if="icon" class="stat-icon" :class="`tone-${tone}`">
				<AppIcon :name="icon" :size="15" />
			</span>
			<span v-else-if="tone !== 'default'" class="stat-dot" :class="`tone-${tone}`" />
		</div>
		<div class="stat-value tnum">{{ value }}</div>
		<div v-if="hint" class="stat-hint">{{ hint }}</div>
	</div>
</template>

<style scoped>
.stat-card {
	background: var(--bg-surface);
	border: 1px solid var(--border-color);
	border-radius: var(--radius-lg);
	padding: 16px 20px;
	box-shadow: var(--shadow-xs);
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.stat-top {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.stat-label {
	font-size: 13px;
	font-weight: 500;
	color: var(--text-muted);
}

.stat-value {
	font-size: 26px;
	font-weight: 600;
	line-height: 1.2;
	letter-spacing: -0.02em;
	color: var(--text-primary);
}

.stat-hint {
	font-size: 12px;
	color: var(--text-muted);
}

.stat-icon {
	width: 28px;
	height: 28px;
	border-radius: 7px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	background: var(--bg-subtle);
	color: var(--text-secondary);
}

.stat-icon.tone-primary {
	background: var(--accent-primary-soft);
	color: var(--accent-primary);
}

.stat-icon.tone-success {
	background: var(--tone-success-soft);
	color: var(--tone-success);
}

.stat-icon.tone-warning {
	background: var(--tone-warning-soft);
	color: var(--tone-warning);
}

.stat-icon.tone-danger {
	background: var(--tone-danger-soft);
	color: var(--tone-danger);
}

.stat-dot {
	width: 8px;
	height: 8px;
	border-radius: 9999px;
	background: var(--text-muted);
}

.stat-dot.tone-primary {
	background: var(--accent-primary);
}

.stat-dot.tone-success {
	background: var(--tone-success);
}

.stat-dot.tone-warning {
	background: var(--tone-warning);
}

.stat-dot.tone-danger {
	background: var(--tone-danger);
}
</style>
