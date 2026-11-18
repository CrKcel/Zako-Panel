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
	background: #f0fdf4;
	color: #15803d;
}
.is-success .status-dot {
	background: #16a34a;
}

.is-warning {
	background: #fffbeb;
	color: #b45309;
}
.is-warning .status-dot {
	background: #d97706;
}

.is-danger {
	background: #fef2f2;
	color: #b91c1c;
}
.is-danger .status-dot {
	background: #dc2626;
}

.is-primary {
	background: #eff6ff;
	color: #1d4ed8;
}
.is-primary .status-dot {
	background: #2563eb;
}

.is-info {
	background: #f1f5f9;
	color: #475569;
}
.is-info .status-dot {
	background: #64748b;
}
</style>
