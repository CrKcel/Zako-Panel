<script setup lang="ts">
import { RouterLink } from 'vue-router';
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
		progress?: number | null;
		to?: string;
	}>(),
	{
		tone: 'default',
		progress: null,
	},
);
</script>

<template>
	<component :is="to ? RouterLink : 'div'" :to="to" class="stat-card" :class="[`tone-${tone}`, { 'is-clickable': Boolean(to) }]">
		<div class="stat-top">
			<span class="stat-label">{{ label }}</span>
			<span v-if="icon" class="stat-icon" :class="`tone-${tone}`">
				<AppIcon :name="icon" :size="15" />
			</span>
			<span v-else-if="tone !== 'default'" class="stat-dot" :class="`tone-${tone}`" />
		</div>
		<div class="stat-value tnum">{{ value }}</div>
		<div v-if="progress !== null" class="stat-bar" aria-hidden="true">
			<div class="stat-bar-fill" :class="`tone-${tone}`" :style="{ width: `${Math.min(100, Math.max(0, progress))}%` }" />
		</div>
		<div v-if="hint" class="stat-hint tnum">{{ hint }}</div>
	</component>
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
	text-decoration: none;
	transition:
		border-color var(--duration-fast) var(--ease-standard),
		box-shadow var(--duration-fast) var(--ease-standard);
}

.stat-card.is-clickable {
	cursor: pointer;
}

.stat-card.is-clickable:hover {
	border-color: var(--border-hover);
	box-shadow: var(--shadow-sm);
}

.stat-top {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.stat-label {
	font-size: 12.5px;
	font-weight: 500;
	color: var(--text-muted);
}

.stat-value {
	font-size: 26px;
	font-weight: 600;
	line-height: 1.2;
	letter-spacing: -0.025em;
	color: var(--text-primary);
}

.stat-bar {
	width: 100%;
	height: 4px;
	border-radius: var(--radius-pill);
	background: var(--bg-subtle);
	overflow: hidden;
}

.stat-bar-fill {
	height: 100%;
	border-radius: var(--radius-pill);
	background: var(--accent-primary);
	transition: width var(--duration-normal) var(--ease-standard);
}

.stat-bar-fill.tone-success {
	background: var(--tone-success);
}

.stat-bar-fill.tone-warning {
	background: var(--tone-warning);
}

.stat-bar-fill.tone-danger {
	background: var(--tone-danger);
}

.stat-hint {
	font-size: 12px;
	color: var(--text-muted);
}

.stat-icon {
	width: 28px;
	height: 28px;
	border-radius: 8px;
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
