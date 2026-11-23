import { z } from 'zod';
import { AppError } from '../lib/errors';
import { isId } from '../lib/ids';
import { vlessRealityParamsSchema } from '../protocols/vless-reality';
import type { AppContext } from '../types';

export const idSchema = z.string().refine(isId, 'Invalid identifier');
export const unixSecondsSchema = z.number().int().nonnegative();
export const nullableUnixSecondsSchema = unixSecondsSchema.nullable();

export const listQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	cursor: z.string().min(1).optional(),
});

export function pathId(c: AppContext, name: string): string {
	const value = c.req.param(name);
	if (!value || !isId(value)) throw new AppError('VALIDATION_ERROR', `Invalid ${name}`, 400);
	return value;
}

export function positiveVersion(c: AppContext): number {
	const raw = c.req.param('version');
	const version = Number(raw);
	if (!Number.isInteger(version) || version < 1) {
		throw new AppError('VALIDATION_ERROR', 'Invalid version', 400);
	}
	return version;
}

const optionalText = z.string().trim().min(1).max(255).nullable().optional();

export const createEndpointSchema = z.object({
	name: z.string().trim().min(1).max(64),
	host: z.string().trim().min(1).max(255),
	port: z.number().int().min(1).max(65535),
	params: vlessRealityParamsSchema,
});

export const updateEndpointSchema = z
	.object({
		name: z.string().trim().min(1).max(64).optional(),
		host: z.string().trim().min(1).max(255).optional(),
		port: z.number().int().min(1).max(65535).optional(),
		params: vlessRealityParamsSchema.optional(),
		enabled: z.boolean().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const updateNodeSchema = z
	.object({
		name: z.string().trim().min(1).max(64).optional(),
		enabled: z.boolean().optional(),
		heartbeat_interval_seconds: z.number().int().min(60).max(900).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const proxyGroupSchema = z
	.object({
		name: z.string().trim().min(1).max(64),
		type: z.enum(['select', 'url-test', 'fallback', 'load-balance', 'relay', 'smart']),
		proxies: z.array(z.string()).optional(),
		url: z.string().optional(),
		interval: z.number().int().positive().optional(),
	})
	.passthrough();

export const createProfileSchema = z.object({
	name: z.string().trim().min(1).max(64),
	description: optionalText,
	node_selection: z.enum(['all', 'selected']).default('all'),
	online_only: z.boolean().default(true),
	clash_base: z.record(z.string(), z.unknown()).optional(),
	proxy_groups: z.array(proxyGroupSchema).optional(),
	rules: z.array(z.string()).optional(),
	node_ids: z.array(idSchema).optional(),
});

export const updateProfileSchema = z
	.object({
		name: z.string().trim().min(1).max(64).optional(),
		description: optionalText,
		node_selection: z.enum(['all', 'selected']).optional(),
		online_only: z.boolean().optional(),
		clash_base: z.record(z.string(), z.unknown()).optional(),
		proxy_groups: z.array(proxyGroupSchema).optional(),
		rules: z.array(z.string()).optional(),
		node_ids: z.array(idSchema).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const previewProfileQuerySchema = z.object({
	subscriberId: idSchema.optional(),
});

export const createSubscriptionSchema = z.object({
	subscriber_id: idSchema,
	profile_id: idSchema,
	name: z.string().trim().min(1).max(64),
	expires_at: nullableUnixSecondsSchema.optional(),
});

export const createSubscriberSchema = z.object({
	name: z.string().trim().min(1).max(64),
	email: z.string().trim().toLowerCase().max(255).nullable().optional(),
	traffic_limit_bytes: z.number().int().nonnegative().nullable().optional(),
	expires_at: nullableUnixSecondsSchema.optional(),
});

// `limited` and `expired` are derived from quota and expiry, so only the explicit
// suspension switch is accepted from an administrator.
export const updateSubscriberSchema = z
	.object({
		name: z.string().trim().min(1).max(64).optional(),
		email: z.string().trim().toLowerCase().max(255).nullable().optional(),
		status: z.enum(['active', 'disabled']).optional(),
		traffic_limit_bytes: z.number().int().nonnegative().nullable().optional(),
		expires_at: nullableUnixSecondsSchema.optional(),
	})
	.refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const replaceSubscriberNodesSchema = z.object({
	node_ids: z.array(idSchema),
});

export const createAdminSchema = z.object({
	email: z.email().trim().toLowerCase().max(255),
	role: z.enum(['owner', 'admin', 'viewer']),
});

export const updateAdminSchema = z
	.object({
		role: z.enum(['owner', 'admin', 'viewer']).optional(),
		enabled: z.boolean().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const trafficQuerySchema = z.object({
	from: z.coerce.number().int().nonnegative(),
	to: z.coerce.number().int().nonnegative(),
	groupBy: z.enum(['node', 'subscriber', 'site']),
	nodeId: idSchema.optional(),
	subscriberId: idSchema.optional(),
});

export const publishConfigSchema = z.object({
	definition: z.record(z.string(), z.unknown()),
});

const queryBooleanSchema = z.preprocess((value) => {
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0' || value === undefined || value === '') return false;
	return value;
}, z.boolean());

export const deleteNodeQuerySchema = z.object({
	force: queryBooleanSchema.default(false),
	remove_xray: queryBooleanSchema.default(false),
});

export const agentUninstallSchema = z.object({
	reason: z.enum(['panel_directive', 'node_cli']).default('node_cli'),
});

const trafficBytesSchema = z.number().int().nonnegative();

export const agentReportSchema = z.object({
	sent_at: unixSecondsSchema,
	agent_version: z.string().max(64),
	xray_version: z.string().max(64),
	xray_healthy: z.boolean(),
	stats_healthy: z.boolean(),
	applied_config_version: z.number().int().nonnegative(),
	users_ver: z.number().int().nonnegative(),
	sys: z
		.object({
			cpu: z.number(),
			mem: z.number(),
			load: z.number(),
			uptime: unixSecondsSchema,
		})
		.optional(),
	traffic: z
		.object({
			report_id: z.string().min(1).max(64),
			period_start: unixSecondsSchema,
			period_end: unixSecondsSchema,
			has_counter_gap: z.boolean(),
			node: z.object({ uplink_bytes: trafficBytesSchema, downlink_bytes: trafficBytesSchema }),
			users: z
				.array(
					z.object({
						xray_email: z.string().min(1).max(128),
						uplink_bytes: trafficBytesSchema,
						downlink_bytes: trafficBytesSchema,
					}),
				)
				.max(40),
		})
		.optional(),
});

export const agentConfigResultSchema = z.object({
	version: z.number().int().nonnegative(),
	status: z.enum(['applied', 'failed']),
	applied_at: unixSecondsSchema,
	error: z
		.object({ code: z.string().min(1).max(64), message: z.string().max(512) })
		.nullable()
		.optional(),
});

export const requestNodeAgentUpdateSchema = z.object({
	target_version: z.string().trim().min(1).max(64),
});

export const agentUpdateResultSchema = z.object({
	target_version: z.string().trim().min(1).max(64),
	status: z.enum(['applied', 'failed']),
	reported_at: unixSecondsSchema,
	error: z
		.object({ code: z.string().min(1).max(64), message: z.string().max(512) })
		.nullable()
		.optional(),
});

export const subscriptionEncodingSchema = z.object({
	encoding: z.enum(['base64', 'plain']).default('base64'),
});

export const createEnrollmentTokenSchema = z.object({
	name_prefix: z.string().trim().min(1).max(32).nullable().optional(),
	heartbeat_interval_seconds: z.number().int().min(60).max(900).optional(),
	ttl_seconds: z.number().int().min(300).max(604_800).optional(),
});

const agentEnrollEndpointSchema = z.object({
	// The agent reports inbound tags, which Xray does not length-limit. The service
	// truncates to the panel's endpoint-name limit.
	name: z.string().trim().min(1).max(255),
	protocol: z.literal('vless-reality'),
	port: z.number().int().min(1).max(65535),
	params: vlessRealityParamsSchema,
});

export const agentEnrollSchema = z.object({
	name: z.string().trim().min(1).max(64),
	host: z.string().trim().min(1).max(255),
	agent_version: z.string().max(64).optional(),
	xray_version: z.string().max(64).optional(),
	endpoints: z.array(agentEnrollEndpointSchema).min(1).max(16),
});
