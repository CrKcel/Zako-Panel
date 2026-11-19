<script setup lang="ts">
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TrafficSeries } from '../domain/traffic';
import { useTheme } from '../theme';
import { formatBytes } from '../utils/format';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const CHART_THEMES = {
	light: {
		palette: ['#2563eb', '#16a34a', '#0ea5e9', '#d97706', '#7c3aed', '#e11d48'],
		tooltipBg: '#ffffff',
		tooltipBorder: '#e2e8f0',
		tooltipText: '#0f172a',
		legendText: '#475569',
		axisLine: '#e2e8f0',
		axisLabel: '#64748b',
		splitLine: '#f1f5f9',
	},
	dark: {
		palette: ['#3b82f6', '#22c55e', '#38bdf8', '#f59e0b', '#a78bfa', '#fb7185'],
		tooltipBg: '#172238',
		tooltipBorder: '#243247',
		tooltipText: '#f1f5f9',
		legendText: '#cbd5e1',
		axisLine: '#243247',
		axisLabel: '#94a3b8',
		splitLine: '#1b263b',
	},
} as const;

const props = defineProps<{
	categories: string[];
	series: TrafficSeries[];
}>();

const { resolvedTheme } = useTheme();
const chartEl = ref<HTMLDivElement | null>(null);
let chart: EChartsType | null = null;
let observer: ResizeObserver | null = null;

function render(): void {
	const theme = CHART_THEMES[resolvedTheme.value];
	chart?.setOption(
		{
			color: [...theme.palette],
			tooltip: {
				trigger: 'axis',
				backgroundColor: theme.tooltipBg,
				borderColor: theme.tooltipBorder,
				borderWidth: 1,
				textStyle: { color: theme.tooltipText, fontSize: 12 },
				valueFormatter: (value: unknown) => formatBytes(Number(value)),
			},
			legend: {
				top: 0,
				right: 0,
				icon: 'roundRect',
				itemWidth: 10,
				itemHeight: 3,
				textStyle: { color: theme.legendText, fontSize: 12 },
				data: props.series.map((item) => item.name),
			},
			grid: { left: 72, right: 20, top: 36, bottom: 28 },
			xAxis: {
				type: 'category',
				boundaryGap: false,
				data: props.categories,
				axisLine: { lineStyle: { color: theme.axisLine } },
				axisTick: { show: false },
				axisLabel: { color: theme.axisLabel, fontSize: 11 },
			},
			yAxis: {
				type: 'value',
				splitLine: { lineStyle: { color: theme.splitLine, type: 'dashed' } },
				axisLabel: {
					color: theme.axisLabel,
					fontSize: 11,
					formatter: (value: number | string) => formatBytes(Number(value)),
				},
			},
			series: props.series.map((item) => ({
				name: item.name,
				type: 'line',
				showSymbol: false,
				smooth: 0.25,
				lineStyle: { width: 2 },
				data: item.values,
			})),
		},
		{ notMerge: true },
	);
}

onMounted(() => {
	if (!chartEl.value) return;
	chart = init(chartEl.value);
	render();
	observer = new ResizeObserver(() => chart?.resize());
	observer.observe(chartEl.value);
});

watch([props, resolvedTheme], render, { deep: true });

onBeforeUnmount(() => {
	observer?.disconnect();
	chart?.dispose();
	chart = null;
});
</script>

<template>
	<div ref="chartEl" class="traffic-chart" />
</template>

<style scoped>
.traffic-chart {
	width: 100%;
	height: 300px;
}
</style>
