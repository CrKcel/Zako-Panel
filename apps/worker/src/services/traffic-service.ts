import type { AgentReport, AgentReportResponse, TrafficSummary } from '@zako/contracts';
import { notImplemented } from '../lib/errors';

export interface TrafficQuery {
	from: number;
	to: number;
	groupBy: 'node' | 'subscriber' | 'site';
	nodeId?: string;
	subscriberId?: string;
}

export async function getTrafficSummary(_db: D1Database, _query: TrafficQuery): Promise<TrafficSummary> {
	throw notImplemented('traffic summary');
}

/**
 * Ingests one report. The idempotency key is `(node_id, report_id)` plus the
 * normalized traffic payload hash; heartbeat fields are committed before the
 * traffic batch so a failed batch cannot mark the node offline.
 */
export async function ingestReport(_db: D1Database, _nodeId: string, _report: AgentReport): Promise<AgentReportResponse> {
	throw notImplemented('traffic ingestion');
}
