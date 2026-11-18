import { onMounted, ref, shallowRef, type Ref, type ShallowRef } from 'vue';

export interface AsyncResourceOptions<T> {
	/** Reload when the owning component mounts. Defaults to true. */
	immediate?: boolean;
	initialValue?: T;
	/** Called with every load failure; the resource never throws from `reload`. */
	onError?: (error: unknown) => void;
}

export interface AsyncResource<T> {
	data: Ref<T>;
	loading: Ref<boolean>;
	error: ShallowRef<unknown>;
	/** Runs the loader now; a newer call supersedes an older in-flight result. */
	reload: () => Promise<void>;
}

/**
 * Owns one read request: the value, its loading flag and its last error.
 * Failures are reported through `onError` so views keep their own copy.
 */
export function useAsyncResource<T>(loader: () => Promise<T>, options: AsyncResourceOptions<T> = {}): AsyncResource<T> {
	const data = ref(options.initialValue) as Ref<T>;
	const loading = ref(false);
	const error = shallowRef<unknown>(null);
	let requestId = 0;

	async function reload(): Promise<void> {
		const current = ++requestId;
		loading.value = true;
		error.value = null;
		try {
			const value = await loader();
			if (current === requestId) data.value = value;
		} catch (caught) {
			if (current === requestId) {
				error.value = caught;
				options.onError?.(caught);
			}
		} finally {
			if (current === requestId) loading.value = false;
		}
	}

	if (options.immediate !== false) {
		onMounted(() => {
			void reload();
		});
	}

	return { data, loading, error, reload };
}
