<script setup lang="ts">
import type { Subscription } from '@zako/contracts';
import { ref } from 'vue';
import { formatTimestamp } from '../utils/format';

const subscriptions = ref<Subscription[]>([]);
</script>

<template>
	<el-card shadow="never">
		<el-table :data="subscriptions" empty-text="暂无数据">
			<el-table-column prop="name" label="名称" min-width="180" />
			<el-table-column prop="subscriber_id" label="订阅用户" min-width="240" />
			<el-table-column prop="profile_id" label="档案" min-width="240" />
			<el-table-column label="状态" width="100">
				<template #default="{ row }">
					<el-tag :type="row.revoked_at ? 'danger' : 'success'" disable-transitions>
						{{ row.revoked_at ? '已撤销' : '有效' }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="到期" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.expires_at) }}</template>
			</el-table-column>
			<el-table-column label="创建时间" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.created_at) }}</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>
