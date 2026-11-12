import type { Node } from '@zako/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { ApiError } from '../api/client';
import { nodesApi } from '../api/nodes';

const CACHE_MS = 30_000;

export const useNodeStore = defineStore('nodes', () => {
	const items = ref<Node[]>([]);
	const loading = ref(false);
	const error = ref<string | null>(null);
	const loadedAt = ref<number | null>(null);

	async function load(force = false): Promise<void> {
		if (!force && loadedAt.value !== null && Date.now() - loadedAt.value < CACHE_MS) return;
		loading.value = true;
		error.value = null;
		try {
			const page = await nodesApi.list();
			items.value = page.items;
			loadedAt.value = Date.now();
		} catch (err) {
			error.value = err instanceof ApiError ? err.message : '加载失败';
		} finally {
			loading.value = false;
		}
	}

	return { items, loading, error, loadedAt, load };
});
