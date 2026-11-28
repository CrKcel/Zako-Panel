<script setup lang="ts">
import type { Profile, Subscription } from '@zako/contracts';
import { computed } from 'vue';
import { subscriptionStatusDescriptor } from '../domain/status';
import { useI18n } from '../i18n';
import { formatTimestamp } from '../utils/format';
import StatusBadge from './StatusBadge.vue';

const props = withDefaults(
	defineProps<{
		subscriptions: Subscription[];
		profiles: Profile[];
		loading?: boolean;
		size?: 'default' | 'small';
		isRotating?: (id: string) => boolean;
		isRevoking?: (id: string) => boolean;
	}>(),
	{
		loading: false,
		size: 'default',
	},
);

const emit = defineEmits<{
	rotate: [row: Subscription];
	revoke: [row: Subscription];
}>();

const { t } = useI18n();

const profileNameMap = computed(() => new Map(props.profiles.map((profile) => [profile.id, profile.name])));

function profileName(row: Subscription): string {
	return row.profile_name ?? profileNameMap.value.get(row.profile_id) ?? row.profile_id;
}

function isActive(row: Subscription): boolean {
	return row.revoked_at === null && (row.expires_at === null || row.expires_at * 1000 > Date.now());
}
</script>

<template>
	<el-table v-loading="loading" :data="subscriptions" :size="size" :empty-text="t('subscriptions.empty')">
		<el-table-column prop="name" :label="t('common.name')" min-width="150" />
		<el-table-column :label="t('subscriptions.columns.profile')" min-width="150">
			<template #default="{ row }">{{ profileName(row as Subscription) }}</template>
		</el-table-column>
		<el-table-column :label="t('common.status')" width="110">
			<template #default="{ row }">
				<StatusBadge
					:label="subscriptionStatusDescriptor(row as Subscription).label"
					:type="subscriptionStatusDescriptor(row as Subscription).tag"
					:pulse="isActive(row as Subscription)"
				/>
			</template>
		</el-table-column>
		<el-table-column :label="t('subscriptions.columns.expiresAt')" width="175">
			<template #default="{ row }">
				<span class="tnum">{{ formatTimestamp(row.expires_at) }}</span>
			</template>
		</el-table-column>
		<el-table-column :label="t('subscriptions.columns.createdAt')" width="175">
			<template #default="{ row }">
				<span class="tnum">{{ formatTimestamp(row.created_at) }}</span>
			</template>
		</el-table-column>
		<el-table-column :label="t('common.actions')" width="140" fixed="right">
			<template #default="{ row }">
				<el-button link type="primary" :loading="isRotating?.(row.id) ?? false" @click="emit('rotate', row as Subscription)">
					{{ t('subscriptions.actions.rotate') }}
				</el-button>
				<el-button
					link
					type="danger"
					:disabled="row.revoked_at !== null"
					:loading="isRevoking?.(row.id) ?? false"
					@click="emit('revoke', row as Subscription)"
				>
					{{ t('subscriptions.actions.revoke') }}
				</el-button>
			</template>
		</el-table-column>
	</el-table>
</template>
