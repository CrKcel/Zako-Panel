<script setup lang="ts">
import { computed } from 'vue';
import { locale, useI18n } from '../i18n';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
	lastUpdatedAt: number | null;
	paused: boolean;
}>();

const emit = defineEmits<{
	toggle: [];
}>();

const { t } = useI18n();

const formattedTime = computed(() => {
	if (!props.lastUpdatedAt) return '—';
	const tag = locale.value === 'zh-CN' ? 'zh-CN' : 'en-US';
	return new Date(props.lastUpdatedAt).toLocaleTimeString(tag, { hour12: false });
});
</script>

<template>
	<button
		type="button"
		class="polling-pill"
		:class="{ 'is-paused': paused }"
		:title="paused ? t('nav.resumePolling') : t('nav.pausePolling')"
		@click="emit('toggle')"
	>
		<span class="polling-dot" aria-hidden="true" />
		<span class="polling-text tnum">
			{{ paused ? t('nav.pollingPaused') : t('nav.pollingLive', { time: formattedTime }) }}
		</span>
		<AppIcon :name="paused ? 'play' : 'pause'" :size="12" />
	</button>
</template>

<style scoped>
.polling-pill {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	height: 30px;
	padding: 0 10px;
	border: 1px solid var(--border-color);
	border-radius: var(--radius-pill);
	background: var(--bg-surface);
	color: var(--text-secondary);
	font-family: inherit;
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		border-color var(--duration-fast) var(--ease-standard),
		color var(--duration-fast) var(--ease-standard);
}

.polling-pill:hover {
	background: var(--bg-subtle);
	border-color: var(--border-hover);
	color: var(--text-primary);
}

.polling-dot {
	width: 6px;
	height: 6px;
	border-radius: 9999px;
	background: var(--tone-success);
}

.polling-pill.is-paused .polling-dot {
	background: var(--text-placeholder);
}
</style>
