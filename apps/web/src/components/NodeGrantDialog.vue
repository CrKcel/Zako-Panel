<script setup lang="ts">
import type { Node, Subscriber, SubscriberDetail } from '@zako/contracts';
import { ref, watch } from 'vue';
import { subscribersApi } from '../api/subscribers';
import { useAsyncAction } from '../composables/useAsyncAction';
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
		showError(error, '订阅用户加载失败');
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
		showSuccess('节点授权已更新');
		emit('saved', detail);
	},
	{ onError: (error) => showError(error, '节点授权保存失败') },
);
</script>

<template>
	<el-dialog
		:model-value="visible"
		:title="title ?? '节点授权'"
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
			<el-button @click="close">取消</el-button>
			<el-button type="primary" :loading="saving" @click="save()">保存</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.full-width {
	width: 100%;
}
</style>
