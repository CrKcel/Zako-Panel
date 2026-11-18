/**
 * Usage cycles are calendar months in UTC: a cycle starts on the first day of a
 * month and ends on the first day of the next. Using UTC keeps the boundary
 * independent of the operator's time zone, and starting on day 1 means a cycle
 * never needs day-of-month clamping.
 */
export interface UsageCycle {
	start: number;
	end: number;
}

function nextMonthStart(timestamp: number): number {
	const date = new Date(timestamp * 1000);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
}

export function initialUsageCycle(now: number): UsageCycle {
	const date = new Date(now * 1000);
	const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
	return { start, end: nextMonthStart(start) };
}

export function advanceUsageCycle(cycle: UsageCycle): UsageCycle {
	return { start: cycle.end, end: nextMonthStart(cycle.end) };
}
