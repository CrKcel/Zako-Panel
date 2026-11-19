<script setup lang="ts">
import type { TagType } from '../domain/status';

defineProps<{
	label: string;
	type?: TagType;
}>();
</script>

<template>
	<span class="status-badge" :class="`is-${type ?? 'info'}`">
		<span class="status-dot" />
		<span>{{ label }}</span>
	</span>
</template>

<style scoped>
.status-badge {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 2px 9px;
	border-radius: 9999px;
	font-size: 12px;
	font-weight: 500;
	line-height: 1.5;
	white-space: nowrap;
}

.status-dot {
	width: 6px;
	height: 6px;
	border-radius: 9999px;
	flex: none;
}

.is-success {
	background: var(--tone-success-soft);
	color: var(--tone-success-text);
}
.is-success .status-dot {
	background: var(--tone-success);
}

.is-warning {
	background: var(--tone-warning-soft);
	color: var(--tone-warning-text);
}
.is-warning .status-dot {
	background: var(--tone-warning);
}

.is-danger {
	background: var(--tone-danger-soft);
	color: var(--tone-danger-text);
}
.is-danger .status-dot {
	background: var(--tone-danger);
}

.is-primary {
	background: var(--accent-primary-soft);
	color: var(--accent-primary-hover);
}
.is-primary .status-dot {
	background: var(--accent-primary);
}

.is-info {
	background: var(--tone-info-soft);
	color: var(--tone-info-text);
}
.is-info .status-dot {
	background: var(--tone-info);
}
</style>
