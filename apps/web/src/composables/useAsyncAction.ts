import { ref, type Ref } from 'vue';

export interface AsyncActionOptions {
	/** Called with every failure; the action reports the Chinese copy for the view. */
	onError?: (error: unknown) => void;
}

export interface AsyncAction<Args extends unknown[]> {
	/** True while at least one run is in flight. */
	running: Ref<boolean>;
	isRunning: (key: string) => boolean;
	/** Resolves to false when the action threw. */
	run: (...args: Args) => Promise<boolean>;
	/** Ignores the call while the same key is still running, so double clicks collapse. */
	runFor: (key: string, ...args: Args) => Promise<boolean>;
}

/**
 * Wraps one write request with its in-flight flag. Row actions use `runFor`
 * with the row id so every row keeps an independent loading state.
 */
export function useAsyncAction<Args extends unknown[]>(
	action: (...args: Args) => Promise<void>,
	options: AsyncActionOptions = {},
): AsyncAction<Args> {
	const running = ref(false);
	const runningKeys = ref<ReadonlySet<string>>(new Set());
	let active = 0;

	function isRunning(key: string): boolean {
		return runningKeys.value.has(key);
	}

	function setKey(key: string, pending: boolean): void {
		const next = new Set(runningKeys.value);
		if (pending) next.add(key);
		else next.delete(key);
		runningKeys.value = next;
	}

	async function invoke(key: string | null, args: Args): Promise<boolean> {
		if (key !== null && isRunning(key)) return false;
		active += 1;
		running.value = true;
		if (key !== null) setKey(key, true);
		try {
			await action(...args);
			return true;
		} catch (caught) {
			options.onError?.(caught);
			return false;
		} finally {
			active -= 1;
			running.value = active > 0;
			if (key !== null) setKey(key, false);
		}
	}

	return {
		running,
		isRunning,
		run: (...args) => invoke(null, args),
		runFor: (key, ...args) => invoke(key, args),
	};
}
