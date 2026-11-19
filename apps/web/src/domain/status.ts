import type { DistributionSkipReason, NodeStatus, SubscriberBlockReason, SubscriberStatus, Subscription } from '@zako/contracts';
import { t, type MessageKey } from '../i18n';

export type TagType = 'primary' | 'success' | 'info' | 'warning' | 'danger';

export interface StatusDescriptor {
	label: string;
	tag: TagType;
}

const NODE_STATUS_META: Record<NodeStatus, { key: MessageKey; tag: TagType }> = {
	online: { key: 'status.node.online', tag: 'success' },
	degraded: { key: 'status.node.degraded', tag: 'warning' },
	offline: { key: 'status.node.offline', tag: 'info' },
	disabled: { key: 'status.node.disabled', tag: 'danger' },
	uninstalling: { key: 'status.node.uninstalling', tag: 'warning' },
};

const SUBSCRIBER_STATUS_META: Record<SubscriberStatus, { key: MessageKey; tag: TagType }> = {
	active: { key: 'status.subscriber.active', tag: 'success' },
	limited: { key: 'status.subscriber.limited', tag: 'warning' },
	expired: { key: 'status.subscriber.expired', tag: 'danger' },
	disabled: { key: 'status.subscriber.disabled', tag: 'info' },
};

const DISTRIBUTION_SKIP_REASON_KEY: Record<DistributionSkipReason, MessageKey> = {
	disabled: 'status.distributionSkip.disabled',
	offline: 'status.distributionSkip.offline',
	unhealthy: 'status.distributionSkip.unhealthy',
	not_selected: 'status.distributionSkip.not_selected',
	no_endpoint: 'status.distributionSkip.no_endpoint',
};

const SUBSCRIBER_BLOCK_REASON_KEY: Record<SubscriberBlockReason, MessageKey> = {
	inactive: 'status.subscriberBlock.inactive',
	expired: 'status.subscriberBlock.expired',
	over_quota: 'status.subscriberBlock.over_quota',
};

export function nodeStatusDescriptor(status: NodeStatus): StatusDescriptor {
	const meta = NODE_STATUS_META[status];
	return { label: t(meta.key), tag: meta.tag };
}

export function subscriberStatusDescriptor(status: SubscriberStatus): StatusDescriptor {
	const meta = SUBSCRIBER_STATUS_META[status];
	return { label: t(meta.key), tag: meta.tag };
}

export function distributionSkipReasonLabel(reason: DistributionSkipReason): string {
	return t(DISTRIBUTION_SKIP_REASON_KEY[reason]);
}

export function subscriberBlockReasonLabel(reason: SubscriberBlockReason): string {
	return t(SUBSCRIBER_BLOCK_REASON_KEY[reason]);
}

/** Health flags are nullable until the Agent reports them. */
export function healthDescriptor(healthy: boolean | null | undefined): StatusDescriptor {
	if (healthy === true) return { label: t('status.health.healthy'), tag: 'success' };
	if (healthy === false) return { label: t('status.health.unhealthy'), tag: 'danger' };
	return { label: '—', tag: 'info' };
}

/** Revocation wins over expiry; a subscription without expiry stays valid. */
export function subscriptionStatusDescriptor(
	subscription: Pick<Subscription, 'revoked_at' | 'expires_at'>,
	nowMs = Date.now(),
): StatusDescriptor {
	if (subscription.revoked_at !== null) return { label: t('status.subscription.revoked'), tag: 'danger' };
	if (subscription.expires_at !== null && subscription.expires_at * 1000 <= nowMs) {
		return { label: t('status.subscription.expired'), tag: 'warning' };
	}
	return { label: t('status.subscription.active'), tag: 'success' };
}
