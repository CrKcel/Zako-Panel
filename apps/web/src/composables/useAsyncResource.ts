import { computed, onMounted, ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue';
import {
	clearInFlightResource,
	getCachedResource,
	getInFlightResource,
	getResourceGeneration,
	setCachedResource,
	setInFlightResource,
} from './resourceCache';

export type CacheKeySource = string | null | undefined | (() => string | null | undefined);

export interface AsyncResourceOptions<T> {
	/** Reload when the owning component mounts. Defaults to true. */
	immediate?: boolean;
	initialValue?: T;
	/** Optional cache key (or reactive getter) enabling stale-while-revalidate caching. */
	cacheKey?: CacheKeySource;
	/** Called with every load failure; the resource never throws from `reload`. */
	onError?: (error: unknown) => void;
}

export interface AsyncResource<T> {
	data: Ref<T>;
	/** True only during an active fetch when no cached data is available yet. */
	loading: Ref<boolean>;
	/** True whenever a fetch (initial or background revalidation) is in flight. */
	refreshing: Ref<boolean>;
	/** Unix ms timestamp of the last successful load for the current key, or null. */
	updatedAt: Ref<number | null>;
	error: ShallowRef<unknown>;
	/** Runs the loader now; a newer call supersedes an older in-flight result. */
	reload: () => Promise<void>;
}

/**
 * Owns one read request: the value, its loading/refreshing flags and its last error.
 * When `cacheKey` is set, cached data is shown immediately while background reloads
 * update it in place.
 */
export function useAsyncResource<T>(loader: () => Promise<T>, options: AsyncResourceOptions<T> = {}): AsyncResource<T> {
	const fallbackData = ref(options.initialValue) as Ref<T>;
	const fallbackUpdatedAt = ref<number | null>(null);
	const refreshing = ref(false);
	const error = shallowRef<unknown>(null);
	let requestId = 0;

	const hasCacheConfig = options.cacheKey !== undefined;
	const activeKey = computed<string | null>(() => {
		if (!hasCacheConfig) return null;
		const resolved = typeof options.cacheKey === 'function' ? options.cacheKey() : options.cacheKey;
		return resolved && resolved !== '' ? resolved : null;
	});

	const cachedEntry = computed(() => {
		const key = activeKey.value;
		return key ? getCachedResource<T>(key) : undefined;
	});

	const data = computed<T>({
		get() {
			return cachedEntry.value ? cachedEntry.value.data : fallbackData.value;
		},
		set(value) {
			const key = activeKey.value;
			if (key) {
				setCachedResource(key, value);
			} else {
				fallbackData.value = value;
			}
		},
	});

	const updatedAt = computed<number | null>(() => {
		return cachedEntry.value ? cachedEntry.value.updatedAt : fallbackUpdatedAt.value;
	});

	const loading = computed<boolean>(() => refreshing.value && cachedEntry.value === undefined);

	async function reload(): Promise<void> {
		if (hasCacheConfig && activeKey.value === null) return;

		const current = ++requestId;
		const key = activeKey.value;
		const generation = key ? getResourceGeneration(key) : 0;

		refreshing.value = true;
		error.value = null;
		try {
			let value: T;
			if (key) {
				const existing = getInFlightResource<T>(key, generation);
				const promise = existing ?? loader();
				if (!existing) {
					setInFlightResource(key, generation, promise);
				}
				try {
					value = await promise;
				} finally {
					clearInFlightResource(key, promise);
				}
				if (getResourceGeneration(key) === generation) {
					setCachedResource(key, value);
				}
			} else {
				value = await loader();
				if (current === requestId) {
					fallbackData.value = value;
					fallbackUpdatedAt.value = Date.now();
				}
			}
		} catch (caught) {
			if (current === requestId && (!key || getResourceGeneration(key) === generation)) {
				error.value = caught;
				options.onError?.(caught);
			}
		} finally {
			if (current === requestId) {
				refreshing.value = false;
			}
		}
	}

	if (typeof options.cacheKey === 'function') {
		watch(activeKey, (next, prev) => {
			if (next && next !== prev) {
				void reload();
			} else if (!next) {
				requestId += 1;
				refreshing.value = false;
				error.value = null;
			}
		});
	}

	if (options.immediate !== false) {
		onMounted(() => {
			void reload();
		});
	}

	return { data, loading, refreshing, updatedAt, error, reload };
}
