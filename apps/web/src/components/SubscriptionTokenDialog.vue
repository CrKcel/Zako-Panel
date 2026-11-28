<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../i18n';
import { copyText } from '../utils/clipboard';
import { subscriptionLinks } from '../utils/subscription';

const props = defineProps<{
	visible: boolean;
	token: string;
	subscriptionName?: string;
}>();

const emit = defineEmits<{
	'update:visible': [value: boolean];
}>();

const { t } = useI18n();
const links = computed(() => subscriptionLinks(props.token));
const dialogTitle = computed(() =>
	props.subscriptionName ? t('subscriptions.links.titleWithName', { name: props.subscriptionName }) : t('subscriptions.links.title'),
);

function close(): void {
	emit('update:visible', false);
}
</script>

<template>
	<el-dialog :model-value="visible" :title="dialogTitle" width="720px" :close-on-click-modal="false" @update:model-value="close">
		<el-alert type="info" :closable="false" show-icon class="links-alert" :title="t('subscriptions.links.keepSecretHint')" />
		<div class="link-list">
			<div class="link-row">
				<span class="link-label">{{ t('subscriptions.links.token') }}</span>
				<el-input :model-value="token" readonly class="mono">
					<template #append>
						<el-button @click="copyText(token)">{{ t('common.copy') }}</el-button>
					</template>
				</el-input>
			</div>
			<div v-for="link in links" :key="link.label" class="link-row">
				<span class="link-label">{{ link.label }}</span>
				<el-input :model-value="link.url" readonly class="mono">
					<template #append>
						<el-button @click="copyText(link.url)">{{ t('common.copy') }}</el-button>
					</template>
				</el-input>
			</div>
		</div>
	</el-dialog>
</template>

<style scoped>
.links-alert {
	margin-bottom: 14px;
}

.link-list {
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.link-row {
	display: flex;
	align-items: center;
	gap: 12px;
}

.link-label {
	width: 96px;
	flex: none;
	font-size: 13px;
	font-weight: 500;
	color: var(--text-secondary);
}

@media (max-width: 640px) {
	.link-row {
		flex-direction: column;
		align-items: stretch;
		gap: 6px;
	}
}
</style>
