<script setup lang="ts">
import type { Profile, Subscription } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref, watch } from 'vue';
import { subscriptionsApi } from '../api/subscriptions';
import type { SubscriptionOwner } from '../composables/useSubscriptionActions';
import { useI18n } from '../i18n';
import { showError, showSuccess } from '../utils/feedback';
import { fromUnixSeconds, toUnixSeconds } from '../utils/time';

const props = defineProps<{
	visible: boolean;
	subscriber: SubscriptionOwner | null;
	subscription: Subscription | null;
	profiles: Profile[];
}>();

const emit = defineEmits<{
	'update:visible': [value: boolean];
	created: [token: string, name: string];
	updated: [];
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

const isEditing = computed(() => props.subscription !== null);

const rules = computed<FormRules>(() => ({
	name: [{ required: true, message: t('subscriptions.form.nameRequired'), trigger: 'blur' }],
	profile_id: [{ required: true, message: t('subscriptions.form.profileRequired'), trigger: 'change' }],
}));

watch(
	() => props.visible,
	(open) => {
		if (!open) return;
		if (props.subscription) {
			form.value = {
				name: props.subscription.name,
				profile_id: props.subscription.profile_id,
				expires_at: fromUnixSeconds(props.subscription.expires_at),
			};
			return;
		}
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
	if (!(await formRef.value?.validate().catch(() => false))) return;
	const name = form.value.name.trim();
	const expiresAt = toUnixSeconds(form.value.expires_at);

	if (props.subscription) {
		submitting.value = true;
		try {
			await subscriptionsApi.update(props.subscription.id, {
				name,
				profile_id: form.value.profile_id,
				expires_at: expiresAt,
			});
			close();
			showSuccess(t('subscriptions.form.updated'));
			emit('updated');
		} catch (error) {
			showError(error, t('subscriptions.form.saveFailed'));
		} finally {
			submitting.value = false;
		}
		return;
	}

	if (!props.subscriber) return;
	submitting.value = true;
	try {
		const result = await subscriptionsApi.create({
			name,
			subscriber_id: props.subscriber.id,
			profile_id: form.value.profile_id,
			expires_at: expiresAt,
		});
		close();
		showSuccess(t('subscriptions.form.created'));
		emit('created', result.token, result.subscription.name);
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
		:title="isEditing ? t('subscriptions.edit') : t('subscriptions.create')"
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
			<el-button type="primary" :loading="submitting" @click="submit">{{ isEditing ? t('common.save') : t('common.create') }}</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
.full-width {
	width: 100%;
}
</style>
