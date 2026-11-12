import type { NodeStatus, SubscriberStatus } from '@zako/contracts';

export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
	online: '在线',
	degraded: '异常',
	offline: '离线',
	disabled: '停用',
};

export const NODE_STATUS_TAG: Record<NodeStatus, 'success' | 'warning' | 'info' | 'danger'> = {
	online: 'success',
	degraded: 'warning',
	offline: 'info',
	disabled: 'danger',
};

export const SUBSCRIBER_STATUS_LABEL: Record<SubscriberStatus, string> = {
	active: '正常',
	limited: '超额',
	expired: '到期',
	disabled: '停用',
};

export function formatTimestamp(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) return '—';
	return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
