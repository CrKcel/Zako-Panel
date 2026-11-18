import type { AdminRole, DistributionSkipReason, NodeStatus, SubscriberBlockReason, SubscriberStatus, Subscription } from '@zako/contracts';

export type TagType = 'primary' | 'success' | 'info' | 'warning' | 'danger';

export interface StatusDescriptor {
	label: string;
	tag: TagType;
}

const NODE_STATUS: Record<NodeStatus, StatusDescriptor> = {
	online: { label: '在线', tag: 'success' },
	degraded: { label: '异常', tag: 'warning' },
	offline: { label: '离线', tag: 'info' },
	disabled: { label: '停用', tag: 'danger' },
};

const SUBSCRIBER_STATUS: Record<SubscriberStatus, StatusDescriptor> = {
	active: { label: '正常', tag: 'success' },
	limited: { label: '超限', tag: 'warning' },
	expired: { label: '已到期', tag: 'danger' },
	disabled: { label: '停用', tag: 'info' },
};

const ADMIN_ROLE: Record<AdminRole, StatusDescriptor> = {
	owner: { label: '所有者', tag: 'warning' },
	admin: { label: '管理员', tag: 'primary' },
	viewer: { label: '只读', tag: 'info' },
};

const DISTRIBUTION_SKIP_REASON: Record<DistributionSkipReason, string> = {
	disabled: '节点停用',
	offline: '心跳过期',
	unhealthy: 'Xray 不健康',
	not_selected: '未在档案选择中',
	no_endpoint: '无可用端点',
};

const SUBSCRIBER_BLOCK_REASON: Record<SubscriberBlockReason, string> = {
	inactive: '用户未启用',
	expired: '用户已到期',
	over_quota: '流量已超额',
};

export function nodeStatusDescriptor(status: NodeStatus): StatusDescriptor {
	return NODE_STATUS[status];
}

export function subscriberStatusDescriptor(status: SubscriberStatus): StatusDescriptor {
	return SUBSCRIBER_STATUS[status];
}

export function adminRoleDescriptor(role: AdminRole): StatusDescriptor {
	return ADMIN_ROLE[role];
}

export function distributionSkipReasonLabel(reason: DistributionSkipReason): string {
	return DISTRIBUTION_SKIP_REASON[reason];
}

export function subscriberBlockReasonLabel(reason: SubscriberBlockReason): string {
	return SUBSCRIBER_BLOCK_REASON[reason];
}

/** Health flags are nullable until the Agent reports them. */
export function healthDescriptor(healthy: boolean | null | undefined): StatusDescriptor {
	if (healthy === true) return { label: '正常', tag: 'success' };
	if (healthy === false) return { label: '异常', tag: 'danger' };
	return { label: '—', tag: 'info' };
}

/** Revocation wins over expiry; a subscription without expiry stays valid. */
export function subscriptionStatusDescriptor(
	subscription: Pick<Subscription, 'revoked_at' | 'expires_at'>,
	nowMs = Date.now(),
): StatusDescriptor {
	if (subscription.revoked_at !== null) return { label: '已撤销', tag: 'danger' };
	if (subscription.expires_at !== null && subscription.expires_at * 1000 <= nowMs) return { label: '已到期', tag: 'warning' };
	return { label: '有效', tag: 'success' };
}
