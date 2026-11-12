<script setup lang="ts">
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps<{
	categories: string[];
	series: { name: string; values: number[] }[];
}>();

const chartEl = ref<HTMLDivElement | null>(null);
let chart: EChartsType | null = null;
let observer: ResizeObserver | null = null;

function render(): void {
	chart?.setOption({
		tooltip: { trigger: 'axis' },
		legend: { data: props.series.map((item) => item.name) },
		grid: { left: 48, right: 24, top: 40, bottom: 32 },
		xAxis: { type: 'category', boundaryGap: false, data: props.categories },
		yAxis: { type: 'value' },
		series: props.series.map((item) => ({
			name: item.name,
			type: 'line',
			showSymbol: false,
			smooth: true,
			data: item.values,
		})),
	});
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
	height: 320px;
}
</style>
