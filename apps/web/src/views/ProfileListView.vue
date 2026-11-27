<script setup lang="ts">
import type { ClashPreview, DistributionSkipReason, Node, Profile } from '@zako/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, ref } from 'vue';
import { nodesApi } from '../api/nodes';
import { profilesApi } from '../api/profiles';
import AppIcon from '../components/AppIcon.vue';
import CodeBlock from '../components/CodeBlock.vue';
import PageToolbar from '../components/PageToolbar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { invalidateCachedResource } from '../composables/resourceCache';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useAsyncResource } from '../composables/useAsyncResource';
import { useCrudDialog } from '../composables/useCrudDialog';
import {
	buildProfilePayload,
	DEFAULT_MIHOMO_YAML_TEMPLATE,
	emptyProfileForm,
	profileFormFrom,
	PROXY_GROUP_TYPES,
	type ProfileFormError,
	type ProfileFormState,
} from '../domain/profile-form';
import { distributionSkipReasonLabel, subscriberBlockReasonLabel } from '../domain/status';
import { useI18n } from '../i18n';
import { confirmAction, showError, showSuccess, showValidationError } from '../utils/feedback';
import { formatTimestamp } from '../utils/format';

const { t } = useI18n();

const form = ref<ProfileFormState>(emptyProfileForm());
const formRef = ref<FormInstance>();
const yamlError = ref('');
const previewVisible = ref(false);
const preview = ref<ClashPreview | null>(null);
const previewName = ref('');

function formatFormError(error: ProfileFormError): string {
	switch (error.code) {
		case 'yamlSyntax':
			return t('profiles.form.yamlSyntaxError', { message: error.message });
		case 'yamlRoot':
			return t('profiles.form.yamlRootError');
		case 'proxyGroupsArray':
			return t('profiles.form.proxyGroupsArrayError');
		case 'proxyGroupItem':
			return t('profiles.form.proxyGroupItemError', {
				index: error.index,
				types: PROXY_GROUP_TYPES.join(', '),
			});
		case 'proxyGroupProxies':
			return t('profiles.form.proxyGroupProxiesError', { index: error.index });
		case 'rulesArray':
			return t('profiles.form.rulesArrayError');
		case 'ruleEmpty':
			return t('profiles.form.ruleEmptyError', { index: error.index });
	}
}

const {
	data: profiles,
	loading,
	refreshing,
	reload,
} = useAsyncResource<Profile[]>(() => profilesApi.list().then((page) => page.items), {
	initialValue: [],
	cacheKey: 'profiles:list',
	onError: (error) => showError(error, t('profiles.loadError')),
});

const { data: nodes } = useAsyncResource<Node[]>(() => nodesApi.list().then((page) => page.items), {
	initialValue: [],
	cacheKey: 'nodes:list',
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
		yamlError.value = '';
		form.value = emptyProfileForm();
	},
	load: async (id) => {
		yamlError.value = '';
		form.value = profileFormFrom(await profilesApi.get(id));
	},
	onError: (error) => showError(error, t('profiles.loadError')),
});

function fillDefaultTemplate(): void {
	yamlError.value = '';
	form.value.clash_yaml = DEFAULT_MIHOMO_YAML_TEMPLATE;
}

async function submit(): Promise<void> {
	if (!(await formRef.value?.validate().catch(() => false))) return;
	const result = buildProfilePayload(form.value);
	if (!result.ok) {
		const message = formatFormError(result.error);
		yamlError.value = message;
		showValidationError(message);
		return;
	}
	yamlError.value = '';
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
	if (saved) {
		invalidateCachedResource('profiles:list');
		await reload();
	}
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
		invalidateCachedResource('profiles:list');
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
	<PageToolbar>
		<el-button :loading="refreshing" @click="reload">
			<AppIcon name="refresh" :size="14" class="btn-icon" />
			<span>{{ t('common.refresh') }}</span>
		</el-button>
		<el-button type="primary" @click="openCreate">
			<AppIcon name="plus" :size="14" class="btn-icon" />
			<span>{{ t('profiles.create') }}</span>
		</el-button>
	</PageToolbar>

	<el-card shadow="never">
		<el-table v-loading="loading" :data="profiles" :empty-text="t('common.noData')">
			<el-table-column prop="name" :label="t('common.name')" min-width="160">
				<template #default="{ row }">
					<div class="profile-name">{{ row.name }}</div>
					<div v-if="row.description" class="profile-desc">{{ row.description }}</div>
				</template>
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
			<el-table-column :label="t('profiles.columns.proxyGroups')" width="95">
				<template #default="{ row }">
					<span class="tnum">{{ row.proxy_groups.length }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('profiles.columns.rulesCount')" width="90">
				<template #default="{ row }">
					<span class="tnum">{{ row.rules.length }}</span>
				</template>
			</el-table-column>
			<el-table-column :label="t('profiles.columns.revision')" width="85">
				<template #default="{ row }">
					<span class="tnum mono">v{{ row.revision }}</span>
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

	<el-drawer
		v-model="dialogVisible"
		:title="editingId === null ? t('profiles.create') : t('profiles.edit')"
		size="min(840px, 94vw)"
		:close-on-click-modal="false"
		destroy-on-close
	>
		<el-form ref="formRef" :model="form" :rules="rules" label-position="top">
			<div class="drawer-grid">
				<el-form-item :label="t('common.name')" prop="name">
					<el-input v-model="form.name" />
				</el-form-item>
				<el-form-item :label="t('profiles.form.description')" prop="description">
					<el-input v-model="form.description" />
				</el-form-item>
			</div>
			<div class="drawer-grid">
				<el-form-item :label="t('profiles.form.nodeSelection')" prop="node_selection">
					<el-radio-group v-model="form.node_selection">
						<el-radio value="all">{{ t('profiles.selection.all') }}</el-radio>
						<el-radio value="selected">{{ t('profiles.selection.selected') }}</el-radio>
					</el-radio-group>
				</el-form-item>
				<el-form-item :label="t('profiles.form.onlineOnly')" prop="online_only">
					<el-switch v-model="form.online_only" />
				</el-form-item>
			</div>
			<el-form-item v-if="form.node_selection === 'selected'" :label="t('profiles.form.nodes')" prop="node_ids">
				<el-select v-model="form.node_ids" multiple filterable class="full-width">
					<el-option v-for="node in nodes" :key="node.id" :label="node.name" :value="node.id" />
				</el-select>
			</el-form-item>
			<el-form-item :label="t('profiles.form.clashYaml')" prop="clash_yaml">
				<div class="yaml-editor-wrap">
					<div class="editor-toolbar">
						<el-button size="small" @click="fillDefaultTemplate">{{ t('profiles.form.loadTemplate') }}</el-button>
						<span class="hint">{{ t('profiles.form.yamlHint') }}</span>
					</div>
					<el-input
						v-model="form.clash_yaml"
						type="textarea"
						:rows="20"
						class="code-input"
						:placeholder="DEFAULT_MIHOMO_YAML_TEMPLATE"
						@input="yamlError = ''"
					/>
					<div v-if="yamlError" class="yaml-error">{{ yamlError }}</div>
				</div>
			</el-form-item>
		</el-form>
		<template #footer>
			<el-button @click="closeDialog">{{ t('common.cancel') }}</el-button>
			<el-button type="primary" :loading="submitting" @click="submit">{{ t('common.save') }}</el-button>
		</template>
	</el-drawer>

	<el-dialog v-model="previewVisible" :title="t('profiles.preview.title', { name: previewName })" width="840px" destroy-on-close>
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
				<el-descriptions :column="3" border size="small" class="preview-desc">
					<el-descriptions-item :label="t('profiles.preview.subscriber')">{{ preview.subscriber.name }}</el-descriptions-item>
					<el-descriptions-item :label="t('profiles.preview.proxiesCount')">
						<span class="tnum">{{ preview.proxies.length }}</span>
					</el-descriptions-item>
					<el-descriptions-item :label="t('profiles.preview.skippedCount')">
						<span class="tnum">{{ preview.skipped.length }}</span>
					</el-descriptions-item>
				</el-descriptions>
				<CodeBlock
					:code="preview.document"
					:label="`${previewName || 'clash'}.yaml`"
					:filename="`${previewName || 'clash'}.yaml`"
					max-height="380px"
				/>
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
.btn-icon {
	margin-right: 5px;
}

.profile-name {
	font-weight: 600;
	color: var(--text-primary);
}

.profile-desc {
	font-size: 12px;
	color: var(--text-muted);
	margin-top: 2px;
}

.drawer-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 0 16px;
}

.full-width {
	width: 100%;
}

.yaml-editor-wrap {
	width: 100%;
}

.editor-toolbar {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	margin-bottom: 8px;
}

.hint {
	font-size: 12px;
	line-height: 1.5;
	color: var(--text-muted);
}

.yaml-error {
	margin-top: 6px;
	font-size: 12px;
	line-height: 1.4;
	color: var(--tone-danger-text);
	font-family: var(--font-mono);
	white-space: pre-wrap;
}

.code-input :deep(textarea) {
	font-family: var(--font-mono);
	font-size: 12px;
	line-height: 1.55;
}

.preview-alert {
	margin-bottom: 12px;
}

.preview-desc {
	margin-bottom: 12px;
}

.preview-skipped {
	margin-top: 12px;
}

@media (max-width: 640px) {
	.drawer-grid {
		grid-template-columns: 1fr;
	}
}
</style>
