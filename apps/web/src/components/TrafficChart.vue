<script setup lang="ts">
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TrafficSeries } from '../domain/traffic';
import { formatBytes } from '../utils/format';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const PALETTE = ['#2563eb', '#16a34a', '#0ea5e9', '#d97706', '#7c3aed', '#e11d48'];

const props = defineProps<{
	categories: string[];
	series: TrafficSeries[];
}>();

const chartEl = ref<HTMLDivElement | null>(null);
let chart: EChartsType | null = null;
let observer: ResizeObserver | null = null;

function render(): void {
	chart?.setOption(
		{
			color: PALETTE,
			tooltip: {
				trigger: 'axis',
				backgroundColor: '#ffffff',
				borderColor: '#e2e8f0',
				borderWidth: 1,
				textStyle: { color: '#0f172a', fontSize: 12 },
				valueFormatter: (value: unknown) => formatBytes(Number(value)),
			},
			legend: {
				top: 0,
				right: 0,
				icon: 'roundRect',
				itemWidth: 10,
				itemHeight: 3,
				textStyle: { color: '#475569', fontSize: 12 },
				data: props.series.map((item) => item.name),
			},
			grid: { left: 72, right: 20, top: 36, bottom: 28 },
			xAxis: {
				type: 'category',
				boundaryGap: false,
				data: props.categories,
				axisLine: { lineStyle: { color: '#e2e8f0' } },
				axisTick: { show: false },
				axisLabel: { color: '#64748b', fontSize: 11 },
			},
			yAxis: {
				type: 'value',
				splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' } },
				axisLabel: {
					color: '#64748b',
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

watch(props, render, { deep: true });

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
