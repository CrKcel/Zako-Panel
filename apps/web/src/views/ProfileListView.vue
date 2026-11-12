<script setup lang="ts">
import type { Profile } from '@zako/contracts';
import { ref } from 'vue';
import { formatTimestamp } from '../utils/format';

const profiles = ref<Profile[]>([]);
</script>

<template>
	<el-card shadow="never">
		<el-table :data="profiles" empty-text="暂无数据">
			<el-table-column prop="name" label="名称" min-width="180" />
			<el-table-column label="节点选择" width="120">
				<template #default="{ row }">{{ row.node_selection === 'all' ? '全部' : '指定' }}</template>
			</el-table-column>
			<el-table-column label="在线过滤" width="110">
				<template #default="{ row }">{{ row.online_only ? '启用' : '关闭' }}</template>
			</el-table-column>
			<el-table-column label="规则数" width="100">
				<template #default="{ row }">{{ row.rules.length }}</template>
			</el-table-column>
			<el-table-column label="修订" width="90">
				<template #default="{ row }">{{ row.revision }}</template>
			</el-table-column>
			<el-table-column label="更新时间" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.updated_at) }}</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>
