<script setup lang="ts">
import type { TagType } from '../domain/status';

defineProps<{
	label: string;
	type?: TagType;
	pulse?: boolean;
}>();
</script>

<template>
	<span class="status-badge" :class="[`is-${type ?? 'info'}`, { 'has-pulse': pulse }]">
		<span class="status-dot" aria-hidden="true" />
		<span>{{ label }}</span>
	</span>
</template>

<style scoped>
.status-badge {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 2px 9px;
	border-radius: var(--radius-pill);
	font-size: 12px;
	font-weight: 500;
	line-height: 1.5;
	white-space: nowrap;
	border: 1px solid transparent;
}

.status-dot {
	position: relative;
	width: 6px;
	height: 6px;
	border-radius: 9999px;
	flex: none;
}

.has-pulse .status-dot::after {
	content: '';
	position: absolute;
	inset: -3px;
	border-radius: 9999px;
	background: currentColor;
	opacity: 0.35;
	animation: status-pulse 2.2s ease-out infinite;
}

@keyframes status-pulse {
	0% {
		transform: scale(0.75);
		opacity: 0.45;
	}
	70% {
		transform: scale(1.65);
		opacity: 0;
	}
	100% {
		transform: scale(1.65);
		opacity: 0;
	}
}

.is-success {
	background: var(--tone-success-soft);
	color: var(--tone-success-text);
	border-color: var(--tone-success-border);
}
.is-success .status-dot {
	background: var(--tone-success);
	color: var(--tone-success);
}

.is-warning {
	background: var(--tone-warning-soft);
	color: var(--tone-warning-text);
	border-color: var(--tone-warning-border);
}
.is-warning .status-dot {
	background: var(--tone-warning);
	color: var(--tone-warning);
}

.is-danger {
	background: var(--tone-danger-soft);
	color: var(--tone-danger-text);
	border-color: var(--tone-danger-border);
}
.is-danger .status-dot {
	background: var(--tone-danger);
	color: var(--tone-danger);
}

.is-primary {
	background: var(--accent-primary-soft);
	color: var(--accent-primary);
	border-color: var(--accent-primary-border);
}
.is-primary .status-dot {
	background: var(--accent-primary);
	color: var(--accent-primary);
}

.is-info {
	background: var(--tone-info-soft);
	color: var(--tone-info-text);
	border-color: var(--tone-info-border);
}
.is-info .status-dot {
	background: var(--tone-info);
	color: var(--tone-info);
}
</style>
