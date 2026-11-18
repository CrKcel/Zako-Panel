import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

declare module 'vue-router' {
	interface RouteMeta {
		title?: string;
	}
}

const routes: RouteRecordRaw[] = [
	{
		path: '/',
		name: 'overview',
		component: () => import('../views/OverviewView.vue'),
		meta: { title: '总览' },
	},
	{
		path: '/nodes',
		name: 'nodes',
		component: () => import('../views/NodeListView.vue'),
		meta: { title: '节点' },
	},
	{
		path: '/nodes/:nodeId',
		name: 'node-detail',
		component: () => import('../views/NodeDetailView.vue'),
		meta: { title: '节点详情' },
	},
	{
		path: '/subscribers',
		name: 'subscribers',
		component: () => import('../views/SubscriberListView.vue'),
		meta: { title: '订阅用户' },
	},
	{
		path: '/subscribers/:subscriberId',
		name: 'subscriber-detail',
		component: () => import('../views/SubscriberDetailView.vue'),
		meta: { title: '订阅用户详情' },
	},
	{
		path: '/profiles',
		name: 'profiles',
		component: () => import('../views/ProfileListView.vue'),
		meta: { title: '订阅档案' },
	},
	{
		path: '/subscriptions',
		name: 'subscriptions',
		component: () => import('../views/SubscriptionListView.vue'),
		meta: { title: '订阅' },
	},
	{
		path: '/traffic',
		name: 'traffic',
		component: () => import('../views/TrafficView.vue'),
		meta: { title: '流量' },
	},
	{
		path: '/admins',
		name: 'admins',
		component: () => import('../views/AdminListView.vue'),
		meta: { title: '管理员' },
	},
	{
		path: '/:pathMatch(.*)*',
		redirect: { name: 'overview' },
	},
];

export const router = createRouter({
	history: createWebHistory(import.meta.env.BASE_URL),
	routes,
});

router.afterEach((to) => {
	document.title = to.meta.title ? `${to.meta.title} · Zako Panel` : 'Zako Panel';
});
