import type { TrafficItem } from '@zako/contracts';
import { t } from '../i18n';

export const DAY_SECONDS = 24 * 60 * 60;

/** Windows offered by the traffic view and the 24h summaries. */
export const TRAFFIC_WINDOWS = {
	'24h': DAY_SECONDS,
	'7d': 7 * DAY_SECONDS,
	'30d': 30 * DAY_SECONDS,
} as const;

export type TrafficWindowKey = keyof typeof TRAFFIC_WINDOWS;

export interface TimeWindow {
	from: number;
	to: number;
}

/** Half-open window ending now, in the API's second precision. */
export function trafficWindow(seconds: number, nowMs = Date.now()): TimeWindow {
	const to = Math.floor(nowMs / 1000);
	return { from: to - seconds, to };
}

export interface TrafficTotals {
	uplink: number;
	downlink: number;
	total: number;
}

export function sumTrafficItems(items: readonly TrafficItem[] | null | undefined): TrafficTotals {
	let uplink = 0;
	let downlink = 0;
	for (const item of items ?? []) {
		uplink += item.uplink_bytes;
		downlink += item.downlink_bytes;
	}
	return { uplink, downlink, total: uplink + downlink };
}

export function trafficItemLabel(item: TrafficItem): string {
	return item.label ?? item.key;
}

export function trafficItemTotal(item: TrafficItem): number {
	return item.uplink_bytes + item.downlink_bytes;
}

export interface TrafficSeries {
	name: string;
	values: number[];
}

export interface TrafficChartData {
	categories: string[];
	series: TrafficSeries[];
}

export function trafficChartData(items: readonly TrafficItem[] | null | undefined): TrafficChartData {
	const rows = items ?? [];
	return {
		categories: rows.map(trafficItemLabel),
		series: [
			{ name: t('traffic.uplink'), values: rows.map((item) => item.uplink_bytes) },
			{ name: t('traffic.downlink'), values: rows.map((item) => item.downlink_bytes) },
		],
	};
}
