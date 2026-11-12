import type { AgentTraffic, AgentTrafficUser } from '@zako/contracts';
import { canonicalJson } from './canonical-json';
import { AppError } from './errors';
import { sha256Hex } from './hash';
import { hourBucket } from './node-status';

export const MAX_REPORT_SPAN_SECONDS = 3600;
export const MAX_FUTURE_SKEW_SECONDS = 300;
export const MAX_REPORT_AGE_SECONDS = 7 * 86_400;

export async function trafficPayloadHash(traffic: AgentTraffic): Promise<string> {
	return sha256Hex(canonicalJson(traffic));
}

/**
 * A report must stay inside one UTC hour bucket so it maps to one hourly row.
 * Reports arriving too far ahead or older than the report-id retention are
 * rejected instead of silently landing in the wrong bucket.
 */
export function assertReportWindow(periodStart: number, periodEnd: number, now: number): void {
	if (periodEnd <= periodStart) {
		throw new AppError('UNPROCESSABLE_ENTITY', 'period_end must be greater than period_start', 422);
	}
	if (periodEnd - periodStart > MAX_REPORT_SPAN_SECONDS) {
		throw new AppError('UNPROCESSABLE_ENTITY', 'Report span exceeds one hour', 422);
	}
	if (hourBucket(periodStart) !== hourBucket(periodEnd - 1)) {
		throw new AppError('UNPROCESSABLE_ENTITY', 'Report crosses an hour boundary', 422);
	}
	if (periodEnd > now + MAX_FUTURE_SKEW_SECONDS) {
		throw new AppError('UNPROCESSABLE_ENTITY', 'Report is too far in the future', 422);
	}
	if (periodEnd < now - MAX_REPORT_AGE_SECONDS) {
		throw new AppError('UNPROCESSABLE_ENTITY', 'Report is older than seven days', 422);
	}
}

export function assertUniqueXrayEmails(users: AgentTrafficUser[]): void {
	const seen = new Set<string>();
	for (const user of users) {
		if (seen.has(user.xray_email)) {
			throw new AppError('UNPROCESSABLE_ENTITY', 'Duplicate xray_email in report', 422);
		}
		seen.add(user.xray_email);
	}
}
