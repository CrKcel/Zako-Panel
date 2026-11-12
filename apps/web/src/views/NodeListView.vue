<script setup lang="ts">
import type { Node } from '@zako/contracts';
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import { formatTimestamp, NODE_STATUS_LABEL, NODE_STATUS_TAG } from '../utils/format';

const nodes = ref<Node[]>([]);
</script>

<template>
	<el-card shadow="never">
		<el-table :data="nodes" empty-text="暂无数据">
			<el-table-column label="名称" min-width="180">
				<template #default="{ row }">
					<RouterLink :to="`/nodes/${row.id}`" class="node-link">{{ row.name }}</RouterLink>
				</template>
			</el-table-column>
			<el-table-column label="状态" width="100">
				<template #default="{ row }">
					<el-tag :type="NODE_STATUS_TAG[row.status as Node['status']]" disable-transitions>
						{{ NODE_STATUS_LABEL[row.status as Node['status']] }}
					</el-tag>
				</template>
			</el-table-column>
			<el-table-column label="心跳间隔" width="110">
				<template #default="{ row }">{{ row.heartbeat_interval_seconds }}s</template>
			</el-table-column>
			<el-table-column label="最近心跳" width="180">
				<template #default="{ row }">{{ formatTimestamp(row.last_seen_at) }}</template>
			</el-table-column>
			<el-table-column prop="agent_version" label="Agent" width="120" />
			<el-table-column prop="xray_version" label="Xray" width="120" />
			<el-table-column label="启用" width="80">
				<template #default="{ row }">{{ row.enabled ? '是' : '否' }}</template>
			</el-table-column>
		</el-table>
	</el-card>
</template>

<style scoped>
.node-link {
	color: #2563eb;
	text-decoration: none;
}

.node-link:hover {
	text-decoration: underline;
}
</style>
