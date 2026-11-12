import type { Env } from '../env';
import { log } from '../lib/log';

/**
 * Cron entry point for usage-cycle advancement, traffic retention and status
 * reconciliation. Jobs are grouped here so each cron invocation stays a single
 * worker request and writes in bounded batches.
 */
export async function runScheduledJob(env: Env, cron: string, scheduledTime: number): Promise<void> {
	log('info', {
		job: 'cron',
		cron,
		scheduled_time: scheduledTime,
		environment: env.ENVIRONMENT ?? null,
	});
}
