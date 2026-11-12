<script setup lang="ts">
import type { CreateSubscriptionRequest, Profile, Subscription } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { profilesApi } from '../api/profiles';
import { subscriptionsApi } from '../api/subscriptions';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

interface SubscriptionForm {
	name: string;
	subscriber_id: string;
	profile_id: string;
	expires_at: Date | null;
}

const subscriptions = ref<Subscription[]>([]);
const profiles = ref<Profile[]>([]);
const loading = ref(true);
const saving = ref(false);
const dialogVisible = ref(false);
const tokenDialogVisible = ref(false);
const token = ref('');
const rotatingId = ref<string | null>(null);
const formRef = ref<FormInstance>();

function emptyForm(): SubscriptionForm {
	return { name: '', subscriber_id: '', profile_id: '', expires_at: null };
}

const form = ref<SubscriptionForm>(emptyForm());

const rules: FormRules = {
	name: [{ required: true, message: '请输入订阅名称', trigger: 'blur' }],
	subscriber_id: [{ required: true, message: '请输入订阅用户 ID', trigger: 'blur' }],
	profile_id: [{ required: true, message: '请选择订阅档案', trigger: 'change' }],
};

const links = computed(() => {
	if (!token.value) return [];
	const base = `${window.location.origin}/sub/${token.value}`;
	return [
		{ label: 'Clash', url: `${base}/clash.yaml` },
		{ label: 'URI Base64', url: `${base}/uri?encoding=base64` },
		{ label: 'URI Plain', url: `${base}/uri?encoding=plain` },
	];
});

function profileName(profileId: string): string {
	return profiles.value.find((profile) => profile.id === profileId)?.name ?? profileId;
}

function subscriptionStatus(row: Subscription): { label: string; type: 'success' | 'warning' | 'danger' } {
	if (row.revoked_at !== null) return { label: '已撤销', type: 'danger' };
	if (row.expires_at !== null && row.expires_at * 1000 <= Date.now()) return { label: '已到期', type: 'warning' };
	return { label: '有效', type: 'success' };
}

async function load(): Promise<void> {
	loading.value = true;
	try {
		const page = await subscriptionsApi.list({ limit: 200 });
		subscriptions.value = page.items;
	} catch (error) {
		showError(error, '订阅加载失败');
	} finally {
		loading.value = false;
	}
}

async function loadProfiles(): Promise<void> {
	try {
		const page = await profilesApi.list({ limit: 200 });
		profiles.value = page.items;
	} catch (error) {
		showError(error, '订阅档案加载失败');
	}
}

function openCreate(): void {
	form.value = emptyForm();
	dialogVisible.value = true;
}

async function submit(): Promise<void> {
	const valid = await formRef.value?.validate().catch(() => false);
	if (!valid) return;
	const payload: CreateSubscriptionRequest = {
		name: form.value.name,
		subscriber_id: form.value.subscriber_id,
		profile_id: form.value.profile_id,
		expires_at: form.value.expires_at === null ? null : Math.floor(form.value.expires_at.getTime() / 1000),
	};
	saving.value = true;
	try {
		const result = await subscriptionsApi.create(payload);
		dialogVisible.value = false;
		token.value = result.token;
		tokenDialogVisible.value = true;
		showSuccess('订阅已创建');
		await load();
	} catch (error) {
		showError(error, '订阅创建失败');
	} finally {
		saving.value = false;
	}
}

async function rotate(row: Subscription): Promise<void> {
	const confirmed = await confirmAction(`轮换订阅「${row.name}」的 token？`);
	if (!confirmed) return;
	rotatingId.value = row.id;
	try {
		const result = await subscriptionsApi.rotate(row.id);
		token.value = result.token;
		tokenDialogVisible.value = true;
		showSuccess('订阅 token 已轮换');
		await load();
	} catch (error) {
		showError(error, '订阅轮换失败');
	} finally {
		rotatingId.value = null;
	}
}

async function revoke(row: Subscription): Promise<void> {
	const confirmed = await confirmAction(`撤销订阅「${row.name}」？`);
	if (!confirmed) return;
	try {
		await subscriptionsApi.revoke(row.id);
		showSuccess('订阅已撤销');
		await load();
	} catch (error) {
		showError(error, '订阅撤销失败');
	}
}

onMounted(async () => {
	await Promise.all([load(), loadProfiles()]);
});
</script>

<template>
	<el-card shadow="never">
		<div class="toolbar">
			<el-button :loading="loading" @click="load">刷新</el-button>
			<el-button type="primary" @click="openCreate">创建订阅</el-button>
		</div>
		<el-table v-loading="loading" :data="subscriptions" empty-text="暂无数据">
			<el-table-column prop="name" label="名称" min-width="160" />
			<el-table-column prop="subscriber_id" label="订阅用户" min-width="240" />
			<el-table-column label="档案" min-width="160">
				<template #default="{ row }">{{ profileName(row.profile_id) }}</template>
			</el-table-column>
			<el-table-column label="状态" width="100">
				<template #default="{ row }">
					<el-tag :type="subscriptionStatus(row as Subscription).type" disable-transitions>
						{{ subscriptionStatus(row as Subscription).label }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="到期" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.expires_at) }}</template>
			</el-table-column>
			<el-table-column label="创建时间" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.created_at) }}</template>
			</el-table-column>
			<el-table-column label="操作" width="150" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" :loading="rotatingId === row.id" @click="rotate(row as Subscription)">轮换</el-button>
					<el-button link type="danger" :disabled="row.revoked_at !== null" @click="revoke(row as Subscription)">撤销</el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog v-model="dialogVisible" title="创建订阅" width="560px" :close-on-click-modal="false" destroy-on-close>
		<el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
			<el-form-item label="名称" prop="name">
				<el-input v-model="form.name" />
			</el-form-item>
			<el-form-item label="订阅用户 ID" prop="subscriber_id">
				<el-input v-model="form.subscriber_id" />
			</el-form-item>
			<el-form-item label="档案" prop="profile_id">
				<el-select v-model="form.profile_id" class="full-width">
					<el-option v-for="profile in profiles" :key="profile.id" :label="profile.name" :value="profile.id" />
				</el-select>
			</el-form-item>
			<el-form-item label="到期时间" prop="expires_at">
				<el-date-picker v-model="form.expires_at" type="datetime" class="full-width" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="dialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="saving" @click="submit">创建</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="tokenDialogVisible" title="订阅链接" width="720px" :close-on-click-modal="false">
		<div class="link-list">
			<div class="link-row">
				<span class="link-label">Token</span>
				<el-input :model-value="token" readonly>
					<template #append>
						<el-button @click="copyText(token)">复制</el-button>
					</template>
				</el-input>
			</div>
			<div v-for="link in links" :key="link.label" class="link-row">
				<span class="link-label">{{ link.label }}</span>
				<el-input :model-value="link.url" readonly>
					<template #append>
						<el-button @click="copyText(link.url)">复制</el-button>
					</template>
				</el-input>
			</div>
		</div>
	</el-dialog>
</template>

<style scoped>
.toolbar {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-bottom: 16px;
}

.full-width {
	width: 100%;
}

.link-list {
	display: flex;
	flex-direction: column;
	gap: 16px;
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
	color: #6b7280;
}
</style>
