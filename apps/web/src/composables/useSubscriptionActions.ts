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
 * Coordinates create, rotate, revoke and one-time token presentation for
 * subscription links scoped under a subscriber.
 */
export function useSubscriptionActions(options: SubscriptionActionsOptions = {}) {
	const { t } = useI18n();
	const token = ref('');
	const tokenVisible = ref(false);
	const createVisible = ref(false);
	const createTarget = ref<SubscriptionOwner | null>(null);

	function openCreateFor(owner: SubscriptionOwner): void {
		createTarget.value = owner;
		createVisible.value = true;
	}

	async function onCreated(createdToken: string): Promise<void> {
		token.value = createdToken;
		tokenVisible.value = true;
		invalidateCachedResource('subscriptions:list');
		await options.onChanged?.();
	}

	const rotateAction = useAsyncAction(
		async (row: Subscription) => {
			const result = await subscriptionsApi.rotate(row.id);
			token.value = result.token;
			tokenVisible.value = true;
			showSuccess(t('subscriptions.rotate.success'));
			invalidateCachedResource('subscriptions:list');
			await options.onChanged?.();
		},
		{ onError: (error) => showError(error, t('subscriptions.rotate.failed')) },
	);

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

	async function rotate(row: Subscription): Promise<void> {
		if (!(await confirmAction(t('subscriptions.rotate.confirm', { name: row.name })))) return;
		await rotateAction.runFor(row.id, row);
	}

	async function revoke(row: Subscription): Promise<void> {
		if (!(await confirmAction(t('subscriptions.revoke.confirm', { name: row.name })))) return;
		await revokeAction.runFor(row.id, row);
	}

	return {
		token,
		tokenVisible,
		createVisible,
		createTarget,
		openCreateFor,
		onCreated,
		isRotating: rotateAction.isRunning,
		isRevoking: revokeAction.isRunning,
		rotate,
		revoke,
	};
}
