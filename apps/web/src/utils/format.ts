import { locale, t } from '../i18n';

export function formatTimestamp(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) return '—';
	const tag = locale.value === 'zh-CN' ? 'zh-CN' : 'en-US';
	return new Date(seconds * 1000).toLocaleString(tag, { hour12: false });
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

export function formatPercent(ratio: number | null | undefined): string {
	if (ratio === null || ratio === undefined) return '—';
	return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDuration(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) return '—';
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return t('format.durationDaysHours', { days, hours });
	if (hours > 0) return t('format.durationHoursMinutes', { hours, minutes });
	return t('format.durationMinutes', { minutes });
}
