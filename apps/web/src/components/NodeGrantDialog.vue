<script setup lang="ts">
import type { Node, Subscriber, SubscriberDetail } from '@zako/contracts';
import { ref, watch } from 'vue';
import { subscribersApi } from '../api/subscribers';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useI18n } from '../i18n';
import { showError, showSuccess } from '../utils/feedback';

const props = defineProps<{
	visible: boolean;
	title?: string;
	subscriber: Subscriber | null;
	nodes: Node[];
	/** Current grants; when omitted the dialog loads them from the subscriber. */
	nodeIds?: string[];
}>();

const emit = defineEmits<{
	'update:visible': [value: boolean];
	saved: [detail: SubscriberDetail];
}>();

const { t } = useI18n();
const selected = ref<string[]>([]);
const loading = ref(false);

function close(): void {
	emit('update:visible', false);
}

async function loadGrants(subscriberId: string): Promise<void> {
	loading.value = true;
	try {
		const detail = await subscribersApi.get(subscriberId);
		selected.value = [...detail.node_ids];
	} catch (error) {
		close();
		showError(error, t('subscribers.loadError'));
	} finally {
		loading.value = false;
	}
}

watch(
	() => props.visible,
	(visible) => {
		if (!visible) return;
		const subscriber = props.subscriber;
		if (subscriber === null) return;
		if (props.nodeIds !== undefined) {
			selected.value = [...props.nodeIds];
			return;
		}
		void loadGrants(subscriber.id);
	},
);

const { running: saving, run: save } = useAsyncAction(
	async () => {
		const subscriber = props.subscriber;
		if (subscriber === null) return;
		const detail = await subscribersApi.replaceNodes(subscriber.id, selected.value);
		close();
		showSuccess(t('subscribers.grant.updated'));
		emit('saved', detail);
	},
	{ onError: (error) => showError(error, t('subscribers.grant.saveFailed')) },
);
</script>

<template>
	<el-dialog
		:model-value="visible"
		:title="title ?? t('subscribers.grant.title')"
		width="520px"
		:close-on-click-modal="false"
		destroy-on-close
		@update:model-value="close"
	>
		<div v-loading="loading">
			<el-select v-model="selected" multiple filterable class="full-width">
				<el-option v-for="node in nodes" :key="node.id" :label="node.name" :value="node.id" />
			</el-select>
		</div>
		<template #footer>
			<el-button @click="close">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="saving" @click="save()">{{ t('common.save') }}</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.full-width {
	width: 100%;
}
</style>
