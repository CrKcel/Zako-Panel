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
		palette: ['#171717', '#737373', '#404040', '#a3a3a3', '#525252', '#d4d4d4'],
		tooltipBg: '#ffffff',
		tooltipBorder: '#e5e5e5',
		tooltipText: '#171717',
		legendText: '#525252',
		axisLine: '#e5e5e5',
		axisLabel: '#737373',
		splitLine: '#f5f5f5',
	},
	dark: {
		palette: ['#f5f5f5', '#737373', '#d4d4d4', '#525252', '#a3a3a3', '#404040'],
		tooltipBg: '#1c1c1c',
		tooltipBorder: 'rgba(255, 255, 255, 0.16)',
		tooltipText: '#f5f5f5',
		legendText: '#d4d4d4',
		axisLine: 'rgba(255, 255, 255, 0.14)',
		axisLabel: '#a3a3a3',
		splitLine: 'rgba(255, 255, 255, 0.08)',
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
