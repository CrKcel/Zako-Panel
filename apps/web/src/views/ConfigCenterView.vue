<script setup lang="ts">
import type { ConfigVersion } from '@zako/contracts';
import { ref } from 'vue';
import { formatTimestamp } from '../utils/format';

const versions = ref<ConfigVersion[]>([]);
</script>

<template>
	<el-card shadow="never">
		<el-table :data="versions" empty-text="暂无数据">
			<el-table-column label="版本" width="90">
				<template #default="{ row }">v{{ row.version }}</template>
			</el-table-column>
			<el-table-column prop="definition_sha256" label="摘要" min-width="320" />
			<el-table-column prop="created_by" label="创建者" min-width="220" />
			<el-table-column label="创建时间" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.created_at) }}</template>
			</el-table-column>
			<el-table-column label="应用时间" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.applied_at) }}</template>
			</el-table-column>
			<el-table-column prop="last_error" label="错误" min-width="240" />
		</el-table>
	</el-card>
</template>
