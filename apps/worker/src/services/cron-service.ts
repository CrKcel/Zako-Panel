import type { Env } from '../env';
import { log } from '../lib/log';
import { nowSeconds } from '../lib/node-status';
import { deleteOldAuditEvents } from '../repositories/audit-events';
import { deleteOldNodeBuckets, deleteOldReports, deleteOldSiteBuckets, deleteOldUserBuckets } from '../repositories/traffic';
import { reconcileSubscriberCycles } from './subscriber-cycle-service';

const DAY_SECONDS = 86_400;
const HOUR_BUCKET_RETENTION_DAYS = 90;
const REPORT_RETENTION_DAYS = 30;
const AUDIT_RETENTION_DAYS = 180;
const CLEANUP_BATCH_SIZE = 1000;
const MAX_BATCHES_PER_TABLE = 20;

type Purge = (cutoff: number, batchSize: number) => Promise<number>;

/** Repeats the bounded delete until a short batch is seen, keeping one cron run cheap. */
async function drain(purge: Purge, cutoff: number): Promise<number> {
	let removed = 0;
	for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
		const changes = await purge(cutoff, CLEANUP_BATCH_SIZE);
		removed += changes;
		if (changes < CLEANUP_BATCH_SIZE) break;
	}
	return removed;
}

async function runDailyCleanup(env: Env): Promise<void> {
	const now = nowSeconds();
	const hourlyCutoff = now - HOUR_BUCKET_RETENTION_DAYS * DAY_SECONDS;
	const reportCutoff = now - REPORT_RETENTION_DAYS * DAY_SECONDS;
	const auditCutoff = now - AUDIT_RETENTION_DAYS * DAY_SECONDS;

	const nodeHours = await drain((cutoff, size) => deleteOldNodeBuckets(env.DB, cutoff, size), hourlyCutoff);
	const siteHours = await drain((cutoff, size) => deleteOldSiteBuckets(env.DB, cutoff, size), hourlyCutoff);
	const userHours = await drain((cutoff, size) => deleteOldUserBuckets(env.DB, cutoff, size), hourlyCutoff);
	const reports = await drain((cutoff, size) => deleteOldReports(env.DB, cutoff, size), reportCutoff);
	const audits = await drain((cutoff, size) => deleteOldAuditEvents(env.DB, cutoff, size), auditCutoff);

	log('info', {
		job: 'daily-cleanup',
		node_hour_buckets: nodeHours,
		site_hour_buckets: siteHours,
		user_hour_buckets: userHours,
		traffic_reports: reports,
		audit_events: audits,
	});
}

async function runQuarterHourlyJob(env: Env, scheduledTime: number): Promise<void> {
	const now = nowSeconds();
	const subscribers = await reconcileSubscriberCycles(env.DB, now);
	log('info', {
		job: 'quarter-hourly',
		scheduled_time: scheduledTime,
		environment: env.ENVIRONMENT ?? null,
		advanced_cycles: subscribers.advanced,
		changed_statuses: subscribers.status_changed,
	});
}

/**
 * Cron entry point. The daily trigger owns retention cleanup; the quarter-hour
 * trigger advances usage cycles and materialises subscriber status.
 */
export async function runScheduledJob(env: Env, cron: string, scheduledTime: number): Promise<void> {
	if (cron.trim().startsWith('*/15')) {
		await runQuarterHourlyJob(env, scheduledTime);
		return;
	}
	await runDailyCleanup(env);
}
