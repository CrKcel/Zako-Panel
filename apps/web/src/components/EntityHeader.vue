<script setup lang="ts">
import AppIcon from './AppIcon.vue';

defineProps<{
	title: string;
	backLabel: string;
	subtitle?: string;
}>();

const emit = defineEmits<{
	back: [];
}>();
</script>

<template>
	<section class="entity-hero ui-section">
		<div class="hero-top">
			<div class="hero-left">
				<button type="button" class="back-btn" :aria-label="backLabel" @click="emit('back')">
					<AppIcon name="back" :size="15" />
					<span>{{ backLabel }}</span>
				</button>
				<div class="title-block">
					<div class="title-row">
						<h2 class="hero-title">{{ title }}</h2>
						<slot name="badge" />
					</div>
					<p v-if="subtitle" class="hero-subtitle tnum">{{ subtitle }}</p>
				</div>
			</div>
			<div class="hero-actions">
				<slot name="actions" />
			</div>
		</div>
		<div v-if="$slots.meta" class="hero-meta">
			<slot name="meta" />
		</div>
	</section>
</template>

<style scoped>
.entity-hero {
	background: var(--bg-surface);
	border: 1px solid var(--border-color);
	border-radius: var(--radius-lg);
	padding: 18px 20px;
	box-shadow: var(--shadow-xs);
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.hero-top {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 16px;
	flex-wrap: wrap;
}

.hero-left {
	display: flex;
	flex-direction: column;
	gap: 10px;
	min-width: 0;
}

.back-btn {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	align-self: flex-start;
	padding: 4px 8px;
	margin-left: -8px;
	border: none;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-muted);
	font-family: inherit;
	font-size: 12.5px;
	font-weight: 500;
	cursor: pointer;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		color var(--duration-fast) var(--ease-standard);
}

.back-btn:hover {
	background: var(--bg-subtle);
	color: var(--text-primary);
}

.title-block {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.title-row {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}

.hero-title {
	margin: 0;
	font-size: 20px;
	font-weight: 600;
	letter-spacing: -0.02em;
	color: var(--text-primary);
}

.hero-subtitle {
	margin: 0;
	font-size: 12.5px;
	color: var(--text-muted);
}

.hero-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}

.hero-meta {
	padding-top: 12px;
	border-top: 1px solid var(--border-subtle);
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
	gap: 12px 16px;
}
</style>
