<script setup lang="ts">
import { useI18n } from '../i18n';
import AppIcon from './AppIcon.vue';

export type ListViewMode = 'card' | 'table';

const model = defineModel<ListViewMode>({ required: true });

const { t } = useI18n();
</script>

<template>
	<div class="view-switch" role="group">
		<button
			type="button"
			class="view-btn"
			:class="{ 'is-active': model === 'card' }"
			:title="t('common.viewCard')"
			:aria-label="t('common.viewCard')"
			:aria-pressed="model === 'card'"
			@click="model = 'card'"
		>
			<AppIcon name="grid" :size="14" />
		</button>
		<button
			type="button"
			class="view-btn"
			:class="{ 'is-active': model === 'table' }"
			:title="t('common.viewTable')"
			:aria-label="t('common.viewTable')"
			:aria-pressed="model === 'table'"
			@click="model = 'table'"
		>
			<AppIcon name="list" :size="14" />
		</button>
	</div>
</template>

<style scoped>
.view-switch {
	display: inline-flex;
	align-items: center;
	padding: 2px;
	border: 1px solid var(--border-color);
	border-radius: var(--radius-sm);
	background: var(--bg-muted);
}

.view-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 26px;
	border: none;
	border-radius: var(--radius-xs);
	background: transparent;
	color: var(--text-muted);
	cursor: pointer;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		color var(--duration-fast) var(--ease-standard);
}

.view-btn:hover {
	color: var(--text-primary);
}

.view-btn.is-active {
	background: var(--bg-surface);
	color: var(--text-primary);
	box-shadow: var(--shadow-xs);
}
</style>
