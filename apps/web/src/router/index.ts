import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { t, type MessageKey } from '../i18n';

declare module 'vue-router' {
	interface RouteMeta {
		titleKey?: MessageKey;
	}
}

const routes: RouteRecordRaw[] = [
	{
		path: '/',
		name: 'overview',
		component: () => import('../views/OverviewView.vue'),
		meta: { titleKey: 'nav.overview' },
	},
	{
		path: '/nodes',
		name: 'nodes',
		component: () => import('../views/NodeListView.vue'),
		meta: { titleKey: 'nav.nodes' },
	},
	{
		path: '/nodes/:nodeId',
		name: 'node-detail',
		component: () => import('../views/NodeDetailView.vue'),
		meta: { titleKey: 'nav.nodeDetail' },
	},
	{
		path: '/subscribers',
		name: 'subscribers',
		component: () => import('../views/SubscriberListView.vue'),
		meta: { titleKey: 'nav.subscribers' },
	},
	{
		path: '/subscribers/:subscriberId',
		name: 'subscriber-detail',
		component: () => import('../views/SubscriberDetailView.vue'),
		meta: { titleKey: 'nav.subscriberDetail' },
	},
	{
		path: '/profiles',
		name: 'profiles',
		component: () => import('../views/ProfileListView.vue'),
		meta: { titleKey: 'nav.profiles' },
	},
	{
		path: '/subscriptions',
		name: 'subscriptions',
		component: () => import('../views/SubscriptionListView.vue'),
		meta: { titleKey: 'nav.subscriptions' },
	},
	{
		path: '/traffic',
		name: 'traffic',
		component: () => import('../views/TrafficView.vue'),
		meta: { titleKey: 'nav.traffic' },
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

export function syncDocumentTitle(titleKey?: MessageKey): void {
	document.title = titleKey ? `${t(titleKey)} · Zako Panel` : 'Zako Panel';
}

router.afterEach((to) => {
	syncDocumentTitle(to.meta.titleKey);
});
