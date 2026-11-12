<script setup lang="ts">
import type { AdminUser } from '@zako/contracts';
import { ref } from 'vue';
import { formatTimestamp } from '../utils/format';

const admins = ref<AdminUser[]>([]);

const ROLE_LABEL: Record<AdminUser['role'], string> = {
	owner: '所有者',
	admin: '管理员',
	viewer: '只读',
};
</script>

<template>
	<el-card shadow="never">
		<el-table :data="admins" empty-text="暂无数据">
			<el-table-column prop="email" label="邮箱" min-width="260" />
			<el-table-column label="角色" width="120">
				<template #default="{ row }">{{ ROLE_LABEL[row.role as AdminUser['role']] }}</template>
			</el-table-column>
			<el-table-column label="状态" width="100">
				<template #default="{ row }">{{ row.enabled ? '启用' : '停用' }}</template>
			</el-table-column>
			<el-table-column label="创建时间" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.created_at) }}</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>
