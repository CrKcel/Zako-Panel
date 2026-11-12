<script setup lang="ts">
import type { Subscriber } from '@zako/contracts';
import { ref } from 'vue';
import { formatBytes, formatTimestamp, SUBSCRIBER_STATUS_LABEL } from '../utils/format';

const subscribers = ref<Subscriber[]>([]);
</script>

<template>
	<el-card shadow="never">
		<el-table :data="subscribers" empty-text="暂无数据">
			<el-table-column prop="name" label="名称" min-width="160" />
			<el-table-column prop="email" label="邮箱" min-width="220" />
			<el-table-column label="状态" width="100">
				<template #default="{ row }">
					{{ SUBSCRIBER_STATUS_LABEL[row.status as Subscriber['status']] }}
				</template>
			</el-table-column>
			<el-table-column label="额度" width="140">
				<template #default="{ row }">
					{{ row.traffic_limit_bytes === null ? '不限' : formatBytes(row.traffic_limit_bytes) }}
				</template>
			</el-table-column>
			<el-table-column label="到期" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.expires_at) }}</template>
			</el-table-column>
			<el-table-column label="周期结束" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.usage_cycle_end) }}</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>
