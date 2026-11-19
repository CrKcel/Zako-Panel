import type { Subscriber } from '@zako/contracts';
import { t } from '../i18n';
import { formatBytes, formatTimestamp } from '../utils/format';

export type LimitUnit = 'GB' | 'MB';

export const LIMIT_UNITS: readonly LimitUnit[] = ['GB', 'MB'];

const UNIT_BYTES: Record<LimitUnit, number> = {
	GB: 1024 ** 3,
	MB: 1024 ** 2,
};

/** Form fields for the quota picker; `limit_value` stays undefined for unlimited quotas. */
export interface LimitParts {
	limit_value: number | undefined;
	limit_unit: LimitUnit;
}

/** Empty or non-positive input means unlimited, matching the API's null. */
export function limitBytes(value: number | undefined, unit: LimitUnit): number | null {
	if (value === undefined || value <= 0) return null;
	return Math.round(value * UNIT_BYTES[unit]);
}

/** Keeps the quota input readable by choosing GB for whole gigabytes and MB below. */
export function limitParts(bytes: number | null | undefined): LimitParts {
	if (bytes === null || bytes === undefined) return { limit_value: undefined, limit_unit: 'GB' };
	if (bytes >= UNIT_BYTES.GB) return { limit_value: Number((bytes / UNIT_BYTES.GB).toFixed(2)), limit_unit: 'GB' };
	return { limit_value: Number((bytes / UNIT_BYTES.MB).toFixed(2)), limit_unit: 'MB' };
}

export function subscriberUsedBytes(subscriber: Pick<Subscriber, 'usage'>): number {
	const usage = subscriber.usage;
	if (usage === null || usage === undefined) return 0;
	return usage.uplink_bytes + usage.downlink_bytes;
}

export function trafficLimitLabel(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined) return t('subscribers.form.unlimited');
	return formatBytes(bytes);
}

export function usageLabel(subscriber: Subscriber): string {
	return `${formatBytes(subscriberUsedBytes(subscriber))} / ${trafficLimitLabel(subscriber.traffic_limit_bytes)}`;
}

export function usageCycleLabel(subscriber: Pick<Subscriber, 'usage_cycle_start' | 'usage_cycle_end'>): string {
	return `${formatTimestamp(subscriber.usage_cycle_start)} ~ ${formatTimestamp(subscriber.usage_cycle_end)}`;
}
