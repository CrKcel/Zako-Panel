<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../i18n';

const props = defineProps<{
	leftTitle: string;
	leftText: string;
	rightTitle?: string;
	rightText?: string;
}>();

const { t } = useI18n();
const mode = ref<'diff' | 'split'>('diff');

interface DiffLine {
	kind: 'same' | 'add' | 'del';
	text: string;
	leftNo: number | null;
	rightNo: number | null;
}

function computeLineDiff(beforeText: string, afterText: string): DiffLine[] {
	const a = beforeText.split('\n');
	const b = afterText.split('\n');
	const m = a.length;
	const n = b.length;

	// Guard against oversized files to keep diff responsive in browser.
	if (m * n > 250_000) {
		return [
			...a.map((line, i) => ({ kind: 'del' as const, text: line, leftNo: i + 1, rightNo: null })),
			...b.map((line, i) => ({ kind: 'add' as const, text: line, leftNo: null, rightNo: i + 1 })),
		];
	}

	const cols = n + 1;
	const dp = new Uint32Array((m + 1) * cols);
	const cell = (row: number, col: number): number => dp[row * cols + col] ?? 0;

	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (a[i] === b[j]) {
				dp[i * cols + j] = cell(i + 1, j + 1) + 1;
			} else {
				const down = cell(i + 1, j);
				const right = cell(i, j + 1);
				dp[i * cols + j] = down >= right ? down : right;
			}
		}
	}

	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	let leftNo = 1;
	let rightNo = 1;
	while (i < m && j < n) {
		const lineA = a[i] ?? '';
		const lineB = b[j] ?? '';
		if (lineA === lineB) {
			out.push({ kind: 'same', text: lineA, leftNo: leftNo++, rightNo: rightNo++ });
			i++;
			j++;
		} else if (cell(i + 1, j) >= cell(i, j + 1)) {
			out.push({ kind: 'del', text: lineA, leftNo: leftNo++, rightNo: null });
			i++;
		} else {
			out.push({ kind: 'add', text: lineB, leftNo: null, rightNo: rightNo++ });
			j++;
		}
	}
	while (i < m) {
		out.push({ kind: 'del', text: a[i++] ?? '', leftNo: leftNo++, rightNo: null });
	}
	while (j < n) {
		out.push({ kind: 'add', text: b[j++] ?? '', leftNo: null, rightNo: rightNo++ });
	}
	return out;
}

const hasComparison = computed(() => props.rightText !== undefined && props.rightText !== '');
const diffLines = computed(() => {
	if (!hasComparison.value) return [];
	// Compare right (active) -> left (inspected) so additions highlight what the inspected version introduces.
	return computeLineDiff(props.rightText ?? '', props.leftText);
});

const hasChanges = computed(() => diffLines.value.some((line) => line.kind !== 'same'));
</script>

<template>
	<div class="diff-viewer">
		<div v-if="hasComparison" class="diff-toolbar">
			<span v-if="!hasChanges" class="diff-identical">{{ t('nodeConfig.detail.noChanges') }}</span>
			<span v-else class="diff-legend">
				<span class="legend-chip is-add">+ {{ leftTitle }}</span>
				<span class="legend-chip is-del">- {{ rightTitle }}</span>
			</span>
			<el-radio-group v-model="mode" size="small">
				<el-radio-button value="diff">{{ t('nodeConfig.detail.unifiedDiff') }}</el-radio-button>
				<el-radio-button value="split">{{ t('nodeConfig.detail.sideBySide') }}</el-radio-button>
			</el-radio-group>
		</div>

		<div v-if="hasComparison && mode === 'diff'" class="unified-box mono">
			<div v-for="(line, idx) in diffLines" :key="idx" class="diff-row" :class="`is-${line.kind}`">
				<span class="line-no tnum">{{ line.rightNo ?? '' }}</span>
				<span class="line-no tnum">{{ line.leftNo ?? '' }}</span>
				<span class="line-sign">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ' }}</span>
				<span class="line-text">{{ line.text }}</span>
			</div>
		</div>

		<div v-else class="compare-grid" :class="{ single: !hasComparison }">
			<div class="pane">
				<div class="pane-title">{{ leftTitle }}</div>
				<pre class="json-preview mono">{{ leftText }}</pre>
			</div>
			<div v-if="hasComparison" class="pane">
				<div class="pane-title">{{ rightTitle }}</div>
				<pre class="json-preview mono">{{ rightText }}</pre>
			</div>
		</div>
	</div>
</template>

<style scoped>
.diff-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	flex-wrap: wrap;
	margin-bottom: 10px;
}

.diff-identical {
	font-size: 12.5px;
	color: var(--tone-success-text);
	font-weight: 500;
}

.diff-legend {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}

.legend-chip {
	padding: 2px 8px;
	border-radius: var(--radius-xs);
	font-size: 11.5px;
	font-weight: 500;
}

.legend-chip.is-add {
	background: var(--diff-add-bg);
	color: var(--diff-add-fg);
}

.legend-chip.is-del {
	background: var(--diff-del-bg);
	color: var(--diff-del-fg);
}

.unified-box {
	max-height: 460px;
	overflow: auto;
	background: var(--bg-code);
	border: 1px solid var(--border-color);
	border-radius: var(--radius-md);
	font-size: 12px;
	line-height: 1.5;
}

.diff-row {
	display: grid;
	grid-template-columns: 42px 42px 20px 1fr;
	padding: 0 10px 0 4px;
	white-space: pre;
}

.diff-row.is-add {
	background: var(--diff-add-bg);
	color: var(--diff-add-fg);
}

.diff-row.is-del {
	background: var(--diff-del-bg);
	color: var(--diff-del-fg);
}

.line-no {
	padding: 0 6px;
	text-align: right;
	color: var(--text-placeholder);
	user-select: none;
}

.line-sign {
	text-align: center;
	user-select: none;
	font-weight: 600;
}

.line-text {
	min-width: 0;
}

.compare-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 12px;
}

.compare-grid.single {
	grid-template-columns: 1fr;
}

.pane-title {
	margin-bottom: 6px;
	font-size: 12.5px;
	font-weight: 600;
	color: var(--text-secondary);
}

.json-preview {
	margin: 0;
	padding: 12px 14px;
	max-height: 460px;
	overflow: auto;
	background: var(--bg-code);
	border: 1px solid var(--border-color);
	border-radius: var(--radius-md);
	font-size: 12px;
	line-height: 1.5;
	color: var(--text-primary);
}

@media (max-width: 760px) {
	.compare-grid {
		grid-template-columns: 1fr;
	}
}
</style>
