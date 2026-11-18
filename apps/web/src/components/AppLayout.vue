<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute } from 'vue-router';

const route = useRoute();

const items = [
	{ path: '/', label: '总览' },
	{ path: '/nodes', label: '节点' },
	{ path: '/subscribers', label: '订阅用户' },
	{ path: '/profiles', label: '订阅档案' },
	{ path: '/subscriptions', label: '订阅' },
	{ path: '/traffic', label: '流量' },
];

const activeMenu = computed(() => {
	if (route.path.startsWith('/nodes')) return '/nodes';
	if (route.path.startsWith('/subscribers')) return '/subscribers';
	return route.path;
});
const title = computed(() => route.meta.title ?? '');
</script>

<template>
	<el-container class="shell">
		<el-aside width="216px" class="aside">
			<div class="brand">ZAKO<span>PANEL</span></div>
			<el-menu :default-active="activeMenu" router class="nav" background-color="#111827" text-color="#9ca3af" active-text-color="#ffffff">
				<el-menu-item v-for="item in items" :key="item.path" :index="item.path">
					{{ item.label }}
				</el-menu-item>
			</el-menu>
		</el-aside>
		<el-container>
			<el-header height="56px" class="header">
				<span class="title">{{ title }}</span>
			</el-header>
			<el-main class="main">
				<RouterView />
			</el-main>
		</el-container>
	</el-container>
</template>

<style scoped>
.shell {
	min-height: 100vh;
}

.aside {
	background: #111827;
	display: flex;
	flex-direction: column;
}

.brand {
	height: 56px;
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 0 20px;
	color: #f9fafb;
	font-size: 15px;
	font-weight: 600;
	letter-spacing: 0.08em;
}

.brand span {
	color: #6b7280;
	font-weight: 400;
}

.nav {
	border-right: none;
	flex: 1;
}

.header {
	display: flex;
	align-items: center;
	background: #ffffff;
	border-bottom: 1px solid #e5e7eb;
}

.title {
	font-size: 16px;
	font-weight: 600;
	color: #111827;
}

.main {
	padding: 24px;
	background: #f5f7fa;
}
</style>
