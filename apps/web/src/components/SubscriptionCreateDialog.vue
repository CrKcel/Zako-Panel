<script setup lang="ts">
import type { CreateSubscriptionRequest, Profile } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref, watch } from 'vue';
import { subscriptionsApi } from '../api/subscriptions';
import type { SubscriptionOwner } from '../composables/useSubscriptionActions';
import { useI18n } from '../i18n';
import { showError, showSuccess } from '../utils/feedback';
import { toUnixSeconds } from '../utils/time';

const props = defineProps<{
	visible: boolean;
	subscriber: SubscriptionOwner | null;
	profiles: Profile[];
}>();

const emit = defineEmits<{
	'update:visible': [value: boolean];
	created: [token: string];
}>();

const { t } = useI18n();

interface SubscriptionForm {
	name: string;
	profile_id: string;
	expires_at: Date | null;
}

function emptyForm(): SubscriptionForm {
	return { name: '', profile_id: '', expires_at: null };
}

const form = ref<SubscriptionForm>(emptyForm());
const formRef = ref<FormInstance>();
const submitting = ref(false);

const rules = computed<FormRules>(() => ({
	name: [{ required: true, message: t('subscriptions.form.nameRequired'), trigger: 'blur' }],
	profile_id: [{ required: true, message: t('subscriptions.form.profileRequired'), trigger: 'change' }],
}));

watch(
	() => props.visible,
	(open) => {
		if (!open) return;
		form.value = emptyForm();
		if (props.profiles.length === 1 && props.profiles[0]) {
			form.value.profile_id = props.profiles[0].id;
		}
	},
);

function close(): void {
	emit('update:visible', false);
}

async function submit(): Promise<void> {
	if (!props.subscriber) return;
	if (!(await formRef.value?.validate().catch(() => false))) return;
	const payload: CreateSubscriptionRequest = {
		name: form.value.name.trim(),
		subscriber_id: props.subscriber.id,
		profile_id: form.value.profile_id,
		expires_at: toUnixSeconds(form.value.expires_at),
	};
	submitting.value = true;
	try {
		const result = await subscriptionsApi.create(payload);
		close();
		showSuccess(t('subscriptions.form.created'));
		emit('created', result.token);
	} catch (error) {
		showError(error, t('subscriptions.form.createFailed'));
	} finally {
		submitting.value = false;
	}
}
</script>

<template>
	<el-dialog
		:model-value="visible"
		:title="t('subscriptions.create')"
		width="540px"
		:close-on-click-modal="false"
		destroy-on-close
		@update:model-value="close"
	>
		<el-form ref="formRef" :model="form" :rules="rules" label-width="130px">
			<el-form-item :label="t('subscriptions.form.subscriber')">
				<el-input :model-value="subscriber?.name ?? '—'" disabled />
			</el-form-item>
			<el-form-item :label="t('common.name')" prop="name">
				<el-input v-model="form.name" />
			</el-form-item>
			<el-form-item :label="t('subscriptions.form.profile')" prop="profile_id">
				<el-select v-model="form.profile_id" class="full-width">
					<el-option v-for="profile in profiles" :key="profile.id" :label="profile.name" :value="profile.id" />
				</el-select>
			</el-form-item>
			<el-form-item :label="t('subscriptions.form.expiresAt')" prop="expires_at">
				<el-date-picker v-model="form.expires_at" type="datetime" class="full-width" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="close">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="submitting" @click="submit">{{ t('common.create') }}</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.full-width {
	width: 100%;
}
</style>
