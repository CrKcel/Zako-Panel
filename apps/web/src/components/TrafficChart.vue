<script setup lang="ts">
import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TrafficSeries } from '../domain/traffic';
import { useTheme } from '../theme';
import { formatBytes } from '../utils/format';

use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const CHART_THEMES = {
	light: {
		palette: ['#2563eb', '#059669', '#0ea5e9', '#d97706', '#7c3aed', '#e11d48'],
		tooltipBg: '#ffffff',
		tooltipBorder: '#e2e8f0',
		tooltipText: '#0f172a',
		legendText: '#475569',
		axisLine: '#e2e8f0',
		axisLabel: '#576475',
		splitLine: '#f1f5f9',
	},
	dark: {
		palette: ['#3b82f6', '#10b981', '#38bdf8', '#f59e0b', '#a78bfa', '#fb7185'],
		tooltipBg: '#162033',
		tooltipBorder: 'rgba(148, 163, 184, 0.22)',
		tooltipText: '#f1f5f9',
		legendText: '#cbd5e1',
		axisLine: 'rgba(148, 163, 184, 0.16)',
		axisLabel: '#94a3b8',
		splitLine: 'rgba(148, 163, 184, 0.1)',
	},
} as const;

const props = withDefaults(
	defineProps<{
		categories: string[];
		series: TrafficSeries[];
		orientation?: 'vertical' | 'horizontal';
		height?: string;
	}>(),
	{
		orientation: 'vertical',
		height: '300px',
	},
);

const { resolvedTheme } = useTheme();
const chartEl = ref<HTMLDivElement | null>(null);
let chart: EChartsType | null = null;
let observer: ResizeObserver | null = null;

function render(): void {
	const theme = CHART_THEMES[resolvedTheme.value];
	const isHorizontal = props.orientation === 'horizontal';
	const categories = isHorizontal ? [...props.categories].reverse() : props.categories;

	const categoryAxis = {
		type: 'category' as const,
		data: categories,
		axisLine: { lineStyle: { color: theme.axisLine } },
		axisTick: { show: false },
		axisLabel: {
			color: theme.axisLabel,
			fontSize: 11,
			width: isHorizontal ? 100 : undefined,
			overflow: 'truncate' as const,
		},
	};

	const valueAxis = {
		type: 'value' as const,
		splitLine: { lineStyle: { color: theme.splitLine, type: 'dashed' as const } },
		axisLabel: {
			color: theme.axisLabel,
			fontSize: 11,
			formatter: (value: number | string) => formatBytes(Number(value)),
		},
	};

	chart?.setOption(
		{
			color: [...theme.palette],
			tooltip: {
				trigger: 'axis',
				axisPointer: { type: 'shadow' },
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
				itemHeight: 10,
				textStyle: { color: theme.legendText, fontSize: 12 },
				data: props.series.map((item) => item.name),
			},
			grid: isHorizontal ? { left: 116, right: 24, top: 34, bottom: 24 } : { left: 74, right: 16, top: 36, bottom: 28 },
			xAxis: isHorizontal ? valueAxis : categoryAxis,
			yAxis: isHorizontal ? categoryAxis : valueAxis,
			series: props.series.map((item) => ({
				name: item.name,
				type: 'bar',
				barMaxWidth: 26,
				itemStyle: {
					borderRadius: isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
				},
				data: isHorizontal ? [...item.values].reverse() : item.values,
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
	<div ref="chartEl" class="traffic-chart" :style="{ height }" />
</template>

<style scoped>
.traffic-chart {
	width: 100%;
}
</style>
