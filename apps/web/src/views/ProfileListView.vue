<script setup lang="ts">
import type { ClashPreview, DistributionSkipReason, Node, Profile } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
import { nodesApi } from '../api/nodes';
import { profilesApi } from '../api/profiles';
import PageToolbar from '../components/PageToolbar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import {
	buildProfilePayload,
	emptyProfileForm,
	profileFormFrom,
	type ProfileFormError,
	type ProfileFormState,
} from '../domain/profile-form';
import { distributionSkipReasonLabel, subscriberBlockReasonLabel } from '../domain/status';
import { useI18n } from '../i18n';
import { confirmAction, showError, showSuccess, showValidationError } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

const { t } = useI18n();

const PARSE_ERROR_KEY: Record<ProfileFormError, 'profiles.form.clashBaseError' | 'profiles.form.proxyGroupsError'> = {
	clash_base: 'profiles.form.clashBaseError',
	proxy_groups: 'profiles.form.proxyGroupsError',
};

const form = ref<ProfileFormState>(emptyProfileForm());
const formRef = ref<FormInstance>();
const previewVisible = ref(false);
const preview = ref<ClashPreview | null>(null);
const previewName = ref('');

const {
	data: profiles,
	loading,
	reload,
} = useAsyncResource<Profile[]>(() => profilesApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, t('profiles.loadError')),
});

const { data: nodes } = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	initialValue: [],
	onError: (error) => showError(error, t('profiles.loadNodesError')),
});

const rules = computed<FormRules>(() => ({
	name: [{ required: true, message: t('profiles.form.nameRequired'), trigger: 'blur' }],
}));

const {
	visible: dialogVisible,
	editingId,
	submitting,
	openCreate,
	openEdit,
	close: closeDialog,
	submit: submitDialog,
} = useCrudDialog({
	reset: () => {
		form.value = emptyProfileForm();
	},
	load: async (id) => {
		form.value = profileFormFrom(await profilesApi.get(id));
	},
	onError: (error) => showError(error, t('profiles.loadError')),
});

async function submit(): Promise<void> {
	if (!(await formRef.value?.validate().catch(() => false))) return;
	const result = buildProfilePayload(form.value);
	if (!result.ok) {
		showValidationError(t(PARSE_ERROR_KEY[result.error]));
		return;
	}
	const profileId = editingId.value;
	const saved = await submitDialog(
		async () => {
			if (profileId === null) {
				await profilesApi.create(result.payload);
				showSuccess(t('profiles.form.created'));
			} else {
				await profilesApi.update(profileId, result.payload);
				showSuccess(t('profiles.form.updated'));
			}
			closeDialog();
		},
		(error) => showError(error, t('profiles.form.saveFailed')),
	);
	if (saved) await reload();
}

const { running: previewLoading, run: runPreview } = useAsyncAction(
	async (profile: Profile) => {
		preview.value = await profilesApi.preview(profile.id);
	},
	{
		onError: (error) => {
			previewVisible.value = false;
			showError(error, t('profiles.preview.failed'));
		},
	},
);

async function openPreview(profile: Profile): Promise<void> {
	previewName.value = profile.name;
	preview.value = null;
	previewVisible.value = true;
	await runPreview(profile);
}

const removeAction = useAsyncAction(
	async (profile: Profile) => {
		await profilesApi.remove(profile.id);
		showSuccess(t('profiles.delete.success'));
		await reload();
	},
	{ onError: (error) => showError(error, t('profiles.delete.failed')) },
);

async function remove(profile: Profile): Promise<void> {
	if (!(await confirmAction(t('profiles.delete.confirm', { name: profile.name })))) return;
	await removeAction.run(profile);
}
</script>

<template>
	<el-card shadow="never">
		<PageToolbar>
			<el-button :loading="loading" @click="reload">{{ t('common.refresh') }}</el-button>
			<el-button type="primary" @click="openCreate">{{ t('profiles.create') }}</el-button>
		</PageToolbar>
		<el-table v-loading="loading" :data="profiles" :empty-text="t('common.noData')">
			<el-table-column prop="name" :label="t('common.name')" min-width="160" />
			<el-table-column :label="t('profiles.columns.description')" min-width="200">
				<template #default="{ row }">{{ row.description ?? '—' }}</template>
			</el-table-column>
			<el-table-column :label="t('profiles.columns.nodeSelection')" width="130">
				<template #default="{ row }">
					<StatusBadge
						:label="row.node_selection === 'all' ? t('profiles.selection.all') : t('profiles.selection.selected')"
						:type="row.node_selection === 'all' ? 'primary' : 'info'"
					/>
				</template>
			</el-table-column>
			<el-table-column :label="t('profiles.columns.onlineOnly')" width="115">
				<template #default="{ row }">
					<StatusBadge :label="row.online_only ? t('common.enabled') : t('common.off')" :type="row.online_only ? 'success' : 'info'" />
				</template>
			</el-table-column>
			<el-table-column :label="t('profiles.columns.proxyGroups')" width="90">
				<template #default="{ row }">
					<span class="tnum">{{ row.proxy_groups.length }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('profiles.columns.rulesCount')" width="85">
				<template #default="{ row }">
					<span class="tnum">{{ row.rules.length }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('profiles.columns.revision')" width="80">
				<template #default="{ row }">
					<span class="tnum">v{{ row.revision }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('profiles.columns.updatedAt')" width="180">
				<template #default="{ row }">
					<span class="tnum">{{ formatTimestamp(row.updated_at) }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('common.actions')" width="200" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" @click="openPreview(row as Profile)">{{ t('profiles.actions.preview') }}</el-button>
					<el-button link type="primary" @click="openEdit(row.id)">{{ t('common.edit') }}</el-button>
					<el-button link type="danger" @click="remove(row as Profile)">{{ t('common.delete') }}</el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-card>

	<el-dialog
		v-model="dialogVisible"
		:title="editingId === null ? t('profiles.create') : t('profiles.edit')"
		width="740px"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-form ref="formRef" :model="form" :rules="rules" label-width="140px">
			<el-form-item :label="t('common.name')" prop="name">
				<el-input v-model="form.name" />
			</el-form-item>
			<el-form-item :label="t('profiles.form.description')" prop="description">
				<el-input v-model="form.description" />
			</el-form-item>
			<el-form-item :label="t('profiles.form.nodeSelection')" prop="node_selection">
				<el-radio-group v-model="form.node_selection">
					<el-radio value="all">{{ t('profiles.selection.all') }}</el-radio>
					<el-radio value="selected">{{ t('profiles.selection.selected') }}</el-radio>
				</el-radio-group>
			</el-form-item>
			<el-form-item v-if="form.node_selection === 'selected'" :label="t('profiles.form.nodes')" prop="node_ids">
				<el-select v-model="form.node_ids" multiple filterable class="full-width">
					<el-option v-for="node in nodes" :key="node.id" :label="node.name" :value="node.id" />
				</el-select>
			</el-form-item>
			<el-form-item :label="t('profiles.form.onlineOnly')" prop="online_only">
				<el-switch v-model="form.online_only" />
			</el-form-item>
			<el-form-item label="clash_base" prop="clash_base">
				<el-input v-model="form.clash_base" type="textarea" :rows="5" class="code-input" />
			</el-form-item>
			<el-form-item label="proxy_groups" prop="proxy_groups">
				<el-input v-model="form.proxy_groups" type="textarea" :rows="6" class="code-input" />
			</el-form-item>
			<el-form-item label="rules" prop="rules">
				<el-input v-model="form.rules" type="textarea" :rows="6" class="code-input" />
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="closeDialog">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="submitting" @click="submit">{{ t('common.save') }}</el-button>
		</template>
	</el-dialog>

	<el-dialog v-model="previewVisible" :title="t('profiles.preview.title', { name: previewName })" width="820px" destroy-on-close>
		<div v-loading="previewLoading">
			<template v-if="preview">
				<el-alert
					v-if="preview.subscriber.blocked_reason !== null"
					:title="t('profiles.preview.blockedAlert', { reason: subscriberBlockReasonLabel(preview.subscriber.blocked_reason) })"
					type="warning"
					:closable="false"
					show-icon
					class="preview-alert"
				/>
				<el-descriptions :column="3" border size="small">
					<el-descriptions-item :label="t('profiles.preview.subscriber')">{{ preview.subscriber.name }}</el-descriptions-item>
					<el-descriptions-item :label="t('profiles.preview.proxiesCount')">
						<span class="tnum">{{ preview.proxies.length }}</span>
					</el-descriptions-item>
					<el-descriptions-item :label="t('profiles.preview.skippedCount')">
						<span class="tnum">{{ preview.skipped.length }}</span>
					</el-descriptions-item>
				</el-descriptions>
				<el-input class="preview-document code-input" type="textarea" :model-value="preview.document" :rows="16" readonly />
				<el-table v-if="preview.skipped.length > 0" :data="preview.skipped" size="small" class="preview-skipped">
					<el-table-column prop="node_name" :label="t('profiles.preview.node')" min-width="160" />
					<el-table-column :label="t('profiles.preview.reason')" min-width="160">
						<template #default="{ row }">{{ distributionSkipReasonLabel(row.reason as DistributionSkipReason) }}</template>
					</el-table-column>
				</el-table>
			</template>
		</div>
	</el-dialog>
</template>

<style scoped>
.full-width {
	width: 100%;
}

.code-input :deep(textarea) {
	font-family: var(--font-mono);
	font-size: 12px;
	line-height: 1.5;
}

.preview-alert {
	margin-bottom: 12px;
}

.preview-document {
	margin: 12px 0;
}

.preview-skipped {
	margin-top: 4px;
}
</style>
