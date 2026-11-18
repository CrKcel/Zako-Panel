<script setup lang="ts">
import type { CreateSubscriptionRequest, Profile, Subscriber, Subscription } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { profilesApi } from '../api/profiles';
import { subscribersApi } from '../api/subscribers';
import { subscriptionsApi } from '../api/subscriptions';
import PageToolbar from '../components/PageToolbar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import { subscriptionStatusDescriptor } from '../domain/status';
import { copyText } from '../utils/clipboard';
import { confirmAction, showError, showSuccess } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';
import { subscriptionLinks } from '../utils/subscription';
import { toUnixSeconds } from '../utils/time';

interface SubscriptionForm {
	name: string;
	subscriber_id: string;
	profile_id: string;
	expires_at: Date | null;
}

function emptySubscriptionForm(): SubscriptionForm {
	return { name: '', subscriber_id: '', profile_id: '', expires_at: null };
}

const search = ref('');
const form = ref<SubscriptionForm>(emptySubscriptionForm());
const formRef = ref<FormInstance>();
const token = ref('');
const tokenVisible = ref(false);

const {
	data: subscriptions,
	loading,
	reload,
} = useAsyncResource<Subscription[]>(() => subscriptionsApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, '订阅加载失败'),
});

const { data: profiles } = useAsyncResource<Profile[]>(() => profilesApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, '订阅档案加载失败'),
});

const { data: subscribers } = useAsyncResource<Subscriber[]>(() => subscribersApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, '订阅用户加载失败'),
});

const rules: FormRules = {
	name: [{ required: true, message: '请输入订阅名称', trigger: 'blur' }],
	subscriber_id: [{ required: true, message: '请选择订阅用户', trigger: 'change' }],
	profile_id: [{ required: true, message: '请选择订阅档案', trigger: 'change' }],
};

const links = computed(() => subscriptionLinks(token.value));

const {
	visible: dialogVisible,
	submitting,
	openCreate,
	close: closeDialog,
	submit: submitDialog,
} = useCrudDialog({
	reset: () => {
		form.value = emptySubscriptionForm();
	},
});

function profileName(profileId: string): string {
	return profiles.value.find((profile) => profile.id === profileId)?.name ?? profileId;
}

function subscriberName(subscriberId: string): string {
	return subscribers.value.find((subscriber) => subscriber.id === subscriberId)?.name ?? subscriberId;
}

const filteredSubscriptions = computed(() => {
	const q = search.value.trim().toLowerCase();
	if (!q) return subscriptions.value;
	return subscriptions.value.filter(
		(row) =>
			row.name.toLowerCase().includes(q) ||
			subscriberName(row.subscriber_id).toLowerCase().includes(q) ||
			profileName(row.profile_id).toLowerCase().includes(q),
	);
});

async function submit(): Promise<void> {
	if (!(await formRef.value?.validate().catch(() => false))) return;
	const payload: CreateSubscriptionRequest = {
		name: form.value.name,
		subscriber_id: form.value.subscriber_id,
		profile_id: form.value.profile_id,
		expires_at: toUnixSeconds(form.value.expires_at),
	};
	const saved = await submitDialog(
		async () => {
			const result = await subscriptionsApi.create(payload);
			closeDialog();
			token.value = result.token;
			tokenVisible.value = true;
			showSuccess('订阅已创建');
		},
		(error) => showError(error, '订阅创建失败'),
	);
	if (saved) await reload();
}

const rotateAction = useAsyncAction(
	async (row: Subscription) => {
		const result = await subscriptionsApi.rotate(row.id);
		token.value = result.token;
		tokenVisible.value = true;
		showSuccess('订阅 token 已轮换');
		await reload();
	},
	{ onError: (error) => showError(error, '订阅轮换失败') },
);

const revokeAction = useAsyncAction(
	async (row: Subscription) => {
		await subscriptionsApi.revoke(row.id);
		showSuccess('订阅已撤销');
		await reload();
	},
	{ onError: (error) => showError(error, '订阅撤销失败') },
);

async function rotate(row: Subscription): Promise<void> {
	if (!(await confirmAction(`轮换订阅「${row.name}」的 token？`))) return;
	await rotateAction.runFor(row.id, row);
}

async function revoke(row: Subscription): Promise<void> {
	if (!(await confirmAction(`撤销订阅「${row.name}」？`))) return;
	await revokeAction.run(row);
}
</script>

<template>
	<el-card shadow="never">
		<PageToolbar spread>
			<template #left>
				<el-input v-model="search" placeholder="搜索订阅名称、用户或档案…" clearable class="search-input" />
			</template>
			<el-button :loading="loading" @click="reload">刷新</el-button>
			<el-button type="primary" @click="openCreate">创建订阅</el-button>
		</PageToolbar>
		<el-table v-loading="loading" :data="filteredSubscriptions" empty-text="暂无数据">
			<el-table-column prop="name" label="名称" min-width="160" />
			<el-table-column label="订阅用户" min-width="160">
				<template #default="{ row }">
					<RouterLink :to="`/subscribers/${row.subscriber_id}`" class="ui-link">
						{{ subscriberName(row.subscriber_id) }}
					</RouterLink>
				</template>
			</el-table-column>
			<el-table-column label="档案" min-width="160">
				<template #default="{ row }">{{ profileName(row.profile_id) }}</template>
			</el-table-column>
			<el-table-column label="状态" width="105">
				<template #default="{ row }">
					<StatusBadge
						:label="subscriptionStatusDescriptor(row as Subscription).label"
						:type="subscriptionStatusDescriptor(row as Subscription).tag"
					/>
				</template>
			</el-table-column>
			<el-table-column label="到期" width="175">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.expires_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column label="创建时间" width="175">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.created_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column label="操作" width="150" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" :loading="rotateAction.isRunning(row.id)" @click="rotate(row as Subscription)">轮换</el-button>
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
			<el-form-item label="订阅用户" prop="subscriber_id">
				<el-select v-model="form.subscriber_id" filterable class="full-width">
					<el-option v-for="subscriber in subscribers" :key="subscriber.id" :label="subscriber.name" :value="subscriber.id" />
				</el-select>
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
			<el-button @click="closeDialog">取消</el-button>
			<el-button type="primary" :loading="submitting" @click="submit">创建</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="tokenVisible" title="订阅链接" width="720px" :close-on-click-modal="false">
		<div class="link-list">
			<div class="link-row">
				<span class="link-label">Token</span>
				<el-input :model-value="token" readonly class="mono">
					<template #append>
						<el-button @click="copyText(token)">复制</el-button>
					</template>
				</el-input>
			</div>
			<div v-for="link in links" :key="link.label" class="link-row">
				<span class="link-label">{{ link.label }}</span>
				<el-input :model-value="link.url" readonly class="mono">
					<template #append>
						<el-button @click="copyText(link.url)">复制</el-button>
					</template>
				</el-input>
			</div>
		</div>
	</el-dialog>
</template>

<style scoped>
.search-input {
	width: 240px;
}

.full-width {
	width: 100%;
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
</style>
