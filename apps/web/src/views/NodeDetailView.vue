<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const nodeId = computed(() => String(route.params.nodeId ?? ''));
</script>

<template>
	<el-card shadow="never" class="detail">
		<el-descriptions :column="3" border>
			<el-descriptions-item label="节点 ID">{{ nodeId }}</el-descriptions-item>
			<el-descriptions-item label="状态">—</el-descriptions-item>
			<el-descriptions-item label="心跳间隔">—</el-descriptions-item>
			<el-descriptions-item label="Agent 版本">—</el-descriptions-item>
			<el-descriptions-item label="Xray 版本">—</el-descriptions-item>
			<el-descriptions-item label="配置版本">—</el-descriptions-item>
		</el-descriptions>
	</el-card>

	<el-card shadow="never">
		<el-tabs>
			<el-tab-pane label="端点">
				<el-table :data="[]" empty-text="暂无数据">
					<el-table-column prop="name" label="名称" min-width="160" />
					<el-table-column prop="protocol" label="协议" width="160" />
					<el-table-column prop="host" label="地址" min-width="200" />
					<el-table-column prop="port" label="端口" width="100" />
				</el-table>
			</el-tab-pane>
			<el-tab-pane label="流量">
				<el-table :data="[]" empty-text="暂无数据">
					<el-table-column prop="bucket_start" label="时间" width="180" />
					<el-table-column prop="uplink_bytes" label="上行" width="140" />
					<el-table-column prop="downlink_bytes" label="下行" width="140" />
				</el-table>
			</el-tab-pane>
			<el-tab-pane label="用户">
				<el-table :data="[]" empty-text="暂无数据">
					<el-table-column prop="xray_email" label="标识" min-width="240" />
					<el-table-column prop="vless_uuid" label="UUID" min-width="300" />
				</el-table>
			</el-tab-pane>
		</el-tabs>
	</el-card>
</template>

<style scoped>
.detail {
	margin-bottom: 16px;
}
</style>
