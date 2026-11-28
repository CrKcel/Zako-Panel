import type { AgentReport, AgentReportResponse, TrafficSummary } from '@zako/contracts';
import { isUniqueConstraintError } from '../lib/db-errors';
import { AppError } from '../lib/errors';
import { hourBucket, nowSeconds } from '../lib/node-status';
import { assertReportWindow, assertUniqueXrayEmails, trafficPayloadHash } from '../lib/traffic';
import { getUsersVersion } from '../repositories/meta';
import { findNodeRuntimeById, updateNodeHeartbeatStatement, type NodeRuntimeRow } from '../repositories/nodes';
import type { SubscriberReportUsageRow } from '../repositories/subscribers';
import { subscriberUsageMapStatement } from '../repositories/subscribers';
import {
	findReportHash,
	insertTrafficReportStatement,
	sumNodeTotal,
	sumNodeTraffic,
	sumSiteTraffic,
	sumSubscriberTraffic,
	sumUserNodeTraffic,
	sumUserTraffic,
	upsertNodeBucketStatement,
	upsertSiteBucketStatement,
	upsertSubscriberUsageStatements,
	upsertUserBucketsStatements,
	type UsageInput,
	type UserBucketInput,
} from '../repositories/traffic';

export interface TrafficQuery {
	from: number;
	to: number;
	groupBy: 'node' | 'subscriber' | 'site';
	nodeId?: string;
	subscriberId?: string;
}

export const TRAFFIC_INTERVAL_SECONDS = 900;
const MAX_TRAFFIC_RANGE_SECONDS = 31 * 86_400;

async function responseFor(
	db: D1Database,
	runtime: NodeRuntimeRow,
	ackReportId: string | null,
	unknownUsers: number,
	currentAgentVersion?: string,
): Promise<AgentReportResponse> {
	const directives: AgentReportResponse['directives'] = [];
	if (runtime.uninstall_requested_at !== null) {
		directives.push({
			type: 'uninstall',
			payload: {
				remove_xray: runtime.uninstall_remove_xray === 1,
			},
		});
	} else if (
		runtime.desired_agent_version !== null &&
		runtime.desired_agent_version !== (currentAgentVersion ?? runtime.agent_version ?? '')
	) {
		directives.push({
			type: 'self_update',
			payload: {
				target_version: runtime.desired_agent_version,
			},
		});
	}
	return {
		ack_report_id: ackReportId,
		server_time: nowSeconds(),
		heartbeat_interval_seconds: runtime.heartbeat_interval_seconds,
		traffic_interval_seconds: TRAFFIC_INTERVAL_SECONDS,
		users_ver: await getUsersVersion(db),
		desired_config_version: runtime.desired_config_version,
		unknown_users: unknownUsers,
		directives,
	};
}

/**
 * Ingests one agent report. Heartbeat fields commit before the traffic batch so
 * a rejected or conflicting report cannot make a live node look offline.
 */
export async function ingestReport(db: D1Database, nodeId: string, report: AgentReport): Promise<AgentReportResponse> {
	const now = nowSeconds();
	const runtime = await findNodeRuntimeById(db, nodeId);
	if (!runtime) throw new AppError('NODE_NOT_FOUND', 'Node not found', 404);

	const traffic = report.traffic;
	let payloadHash: string | null = null;
	let emails: string[] = [];
	if (traffic) {
		assertReportWindow(traffic.period_start, traffic.period_end, now);
		assertUniqueXrayEmails(traffic.users);
		payloadHash = await trafficPayloadHash(traffic);
		emails = [...new Set(traffic.users.map((user) => user.xray_email))];
	}

	// Never record an applied version ahead of what the control plane published.
	const appliedConfigVersion = Math.min(report.applied_config_version, runtime.desired_config_version);
	const [, mappingResult] = await db.batch([
		updateNodeHeartbeatStatement(db, {
			nodeId,
			last_seen_at: now,
			xray_healthy: report.xray_healthy,
			stats_healthy: report.stats_healthy,
			agent_version: report.agent_version,
			xray_version: report.xray_version,
			sys_json: report.sys ? JSON.stringify(report.sys) : null,
			applied_config_version: appliedConfigVersion,
			updated_at: now,
		}),
		subscriberUsageMapStatement(db, emails),
	]);

	const mapping = (mappingResult?.results as SubscriberReportUsageRow[] | undefined) ?? [];
	const mapped = new Map(mapping.map((row) => [row.xray_email, row]));

	if (!traffic || payloadHash === null) {
		return responseFor(db, runtime, null, 0, report.agent_version);
	}

	const unknownUsers = traffic.users.filter((user) => !mapped.has(user.xray_email)).length;
	const bucketStart = hourBucket(traffic.period_start);

	const totalsBySubscriber = new Map<string, { uplink: number; downlink: number; cycleStart: number }>();
	for (const user of traffic.users) {
		const client = mapped.get(user.xray_email);
		if (!client) continue;
		const total = totalsBySubscriber.get(client.subscriber_id);
		if (total) {
			total.uplink += user.uplink_bytes;
			total.downlink += user.downlink_bytes;
		} else {
			totalsBySubscriber.set(client.subscriber_id, {
				uplink: user.uplink_bytes,
				downlink: user.downlink_bytes,
				cycleStart: client.usage_cycle_start,
			});
		}
	}

	const userBuckets: UserBucketInput[] = [...totalsBySubscriber].map(([subscriberId, totals]) => ({
		subscriber_id: subscriberId,
		node_id: nodeId,
		bucket_start: bucketStart,
		uplink_bytes: totals.uplink,
		downlink_bytes: totals.downlink,
		updated_at: now,
	}));
	const usageRows: UsageInput[] = [...totalsBySubscriber].map(([subscriberId, totals]) => ({
		subscriber_id: subscriberId,
		cycle_start: totals.cycleStart,
		uplink_bytes: totals.uplink,
		downlink_bytes: totals.downlink,
		updated_at: now,
	}));

	const statements = [
		insertTrafficReportStatement(db, {
			node_id: nodeId,
			report_id: traffic.report_id,
			payload_hash: payloadHash,
			period_start: traffic.period_start,
			period_end: traffic.period_end,
			item_count: traffic.users.length,
			has_counter_gap: traffic.has_counter_gap,
			received_at: now,
		}),
		upsertNodeBucketStatement(db, nodeId, bucketStart, traffic.node.uplink_bytes, traffic.node.downlink_bytes, now),
		upsertSiteBucketStatement(db, bucketStart, traffic.node.uplink_bytes, traffic.node.downlink_bytes, now),
		...upsertUserBucketsStatements(db, userBuckets),
		...upsertSubscriberUsageStatements(db, usageRows),
	];

	try {
		await db.batch(statements);
	} catch (error) {
		if (!isUniqueConstraintError(error)) throw error;
		const storedHash = await findReportHash(db, nodeId, traffic.report_id);
		if (storedHash === null) throw error;
		if (storedHash === payloadHash) {
			return responseFor(db, runtime, traffic.report_id, unknownUsers, report.agent_version);
		}
		throw new AppError('REPORT_CONFLICT', 'Report id was already used with a different payload', 409);
	}

	return responseFor(db, runtime, traffic.report_id, unknownUsers, report.agent_version);
}

function invalidRange(message: string): AppError {
	return new AppError('VALIDATION_ERROR', message, 400);
}

export async function getTrafficSummary(db: D1Database, query: TrafficQuery): Promise<TrafficSummary> {
	if (query.from >= query.to) throw invalidRange('from must be earlier than to');

	const from = hourBucket(query.from);
	let to = hourBucket(query.to);
	if (to <= from) to = from + 3600;
	if (to - from > MAX_TRAFFIC_RANGE_SECONDS) {
		throw invalidRange('Traffic range must not exceed 31 days');
	}

	let items: TrafficSummary['items'];
	if (query.groupBy === 'node') {
		items =
			query.subscriberId === undefined
				? await sumNodeTraffic(db, from, to, query.nodeId)
				: await sumUserNodeTraffic(db, from, to, { subscriberId: query.subscriberId, nodeId: query.nodeId });
	} else if (query.groupBy === 'subscriber') {
		items = await sumSubscriberTraffic(db, from, to, {
			subscriberId: query.subscriberId,
			nodeId: query.nodeId,
		});
	} else {
		let total;
		if (query.subscriberId !== undefined) {
			total = await sumUserTraffic(db, from, to, { subscriberId: query.subscriberId, nodeId: query.nodeId });
		} else if (query.nodeId !== undefined) {
			total = await sumNodeTotal(db, from, to, query.nodeId);
		} else {
			total = await sumSiteTraffic(db, from, to);
		}
		items = [{ key: 'site', label: 'Site', uplink_bytes: total.uplink_bytes, downlink_bytes: total.downlink_bytes }];
	}

	return { from, to, group_by: query.groupBy, items };
}
