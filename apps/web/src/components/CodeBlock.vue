<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from '../i18n';
import { copyText } from '../utils/clipboard';
import AppIcon from './AppIcon.vue';

const props = withDefaults(
	defineProps<{
		code: string;
		label?: string;
		filename?: string;
		maxHeight?: string;
		wrap?: boolean;
	}>(),
	{
		maxHeight: '420px',
		wrap: false,
	},
);

const { t } = useI18n();
const justCopied = ref(false);
let resetTimer: ReturnType<typeof setTimeout> | null = null;

async function handleCopy(): Promise<void> {
	await copyText(props.code);
	justCopied.value = true;
	if (resetTimer) clearTimeout(resetTimer);
	resetTimer = setTimeout(() => {
		justCopied.value = false;
	}, 1600);
}

function handleDownload(): void {
	if (!props.filename) return;
	const blob = new Blob([props.code], { type: 'text/plain;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = props.filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}
</script>

<template>
	<div class="code-block">
		<div class="code-bar">
			<span class="code-label mono">{{ label ?? '' }}</span>
			<div class="code-actions">
				<button v-if="filename" type="button" class="code-action-btn" @click="handleDownload">
					<AppIcon name="download" :size="13" />
					<span>{{ t('common.download') }}</span>
				</button>
				<button type="button" class="code-action-btn" @click="handleCopy">
					<AppIcon :name="justCopied ? 'check' : 'copy'" :size="13" />
					<span>{{ justCopied ? t('common.copied') : t('common.copy') }}</span>
				</button>
			</div>
		</div>
		<pre class="code-pre mono" :class="{ 'is-wrapped': wrap }" :style="{ maxHeight }">{{ code }}</pre>
	</div>
</template>

<style scoped>
.code-block {
	border: 1px solid var(--border-color);
	border-radius: var(--radius-md);
	background: var(--bg-code);
	overflow: hidden;
}

.code-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 8px 12px;
	background: var(--bg-muted);
	border-bottom: 1px solid var(--border-subtle);
}

.code-label {
	font-size: 11.5px;
	font-weight: 500;
	color: var(--text-muted);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.code-actions {
	display: flex;
	align-items: center;
	gap: 6px;
}

.code-action-btn {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 24px;
	padding: 0 8px;
	border: 1px solid var(--border-color);
	border-radius: var(--radius-xs);
	background: var(--bg-surface);
	color: var(--text-secondary);
	font-family: var(--font-sans);
	font-size: 11.5px;
	font-weight: 500;
	cursor: pointer;
	transition:
		background-color var(--duration-fast) var(--ease-standard),
		border-color var(--duration-fast) var(--ease-standard),
		color var(--duration-fast) var(--ease-standard);
}

.code-action-btn:hover {
	background: var(--bg-subtle);
	border-color: var(--border-hover);
	color: var(--text-primary);
}

.code-pre {
	margin: 0;
	padding: 12px 14px;
	overflow: auto;
	font-size: 12px;
	line-height: 1.55;
	color: var(--text-primary);
	white-space: pre;
}

.code-pre.is-wrapped {
	white-space: pre-wrap;
	word-break: break-all;
}
</style>
