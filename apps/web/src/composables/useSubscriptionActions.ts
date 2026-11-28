import type { Subscription } from '@zako/contracts';
import { ref } from 'vue';
import { subscriptionsApi } from '../api/subscriptions';
import { useI18n } from '../i18n';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { invalidateCachedPrefix, invalidateCachedResource } from './resourceCache';
import { useAsyncAction } from './useAsyncAction';

export interface SubscriptionOwner {
	id: string;
	name: string;
}

export interface SubscriptionActionsOptions {
	onChanged?: () => Promise<void> | void;
}

/**
 * Coordinates create, edit, link presentation, and revoke for subscription links
 * scoped under a subscriber.
 */
export function useSubscriptionActions(options: SubscriptionActionsOptions = {}) {
	const { t } = useI18n();
	const token = ref('');
	const tokenName = ref('');
	const tokenVisible = ref(false);
	const formVisible = ref(false);
	const formSubscriber = ref<SubscriptionOwner | null>(null);
	const editingSubscription = ref<Subscription | null>(null);

	function openCreateFor(owner: SubscriptionOwner): void {
		editingSubscription.value = null;
		formSubscriber.value = owner;
		formVisible.value = true;
	}

	function openEdit(row: Subscription): void {
		editingSubscription.value = row;
		formSubscriber.value = { id: row.subscriber_id, name: row.subscriber_name ?? row.subscriber_id };
		formVisible.value = true;
	}

	function openLinks(row: Subscription): void {
		token.value = row.token;
		tokenName.value = row.name;
		tokenVisible.value = true;
	}

	async function onCreated(createdToken: string, name: string): Promise<void> {
		token.value = createdToken;
		tokenName.value = name;
		tokenVisible.value = true;
		invalidateCachedResource('subscriptions:list');
		await options.onChanged?.();
	}

	async function onUpdated(): Promise<void> {
		invalidateCachedResource('subscriptions:list');
		await options.onChanged?.();
	}

	const revokeAction = useAsyncAction(
		async (row: Subscription) => {
			await subscriptionsApi.revoke(row.id);
			showSuccess(t('subscriptions.revoke.success'));
			invalidateCachedResource('subscriptions:list');
			invalidateCachedPrefix('recycle-bin:');
			await options.onChanged?.();
		},
		{ onError: (error) => showError(error, t('subscriptions.revoke.failed')) },
	);

	async function revoke(row: Subscription): Promise<void> {
		if (!(await confirmAction(t('subscriptions.revoke.confirm', { name: row.name })))) return;
		await revokeAction.runFor(row.id, row);
	}

	return {
		token,
		tokenName,
		tokenVisible,
		formVisible,
		formSubscriber,
		editingSubscription,
		openCreateFor,
		openEdit,
		openLinks,
		onCreated,
		onUpdated,
		isRevoking: revokeAction.isRunning,
		revoke,
	};
}
