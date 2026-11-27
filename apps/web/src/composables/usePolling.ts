import { onBeforeUnmount, onMounted, readonly, ref, type DeepReadonly, type Ref } from 'vue';

export interface PollingHandle {
	/** Runs the task now and restarts the countdown; an in-flight run absorbs the call. */
	refresh: () => Promise<void>;
	/** Unix ms timestamp of the last completed refresh. */
	lastUpdatedAt: DeepReadonly<Ref<number | null>>;
	/** True when automatic background ticks are paused by the user. */
	paused: DeepReadonly<Ref<boolean>>;
	togglePause: () => void;
}

/**
 * Runs `task` immediately and then every `intervalMs`, pausing while the tab is
 * hidden so background tabs do not keep issuing requests.
 */
export function usePolling(task: () => Promise<void> | void, intervalMs = 30_000): PollingHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let stopped = false;

	const lastUpdatedAt = ref<number | null>(null);
	const paused = ref(false);

	function clearTimer(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function schedule(): void {
		clearTimer();
		if (stopped || paused.value || document.hidden) return;
		timer = setTimeout(() => {
			void tick();
		}, intervalMs);
	}

	async function tick(): Promise<void> {
		if (stopped || running) return;
		clearTimer();
		running = true;
		try {
			await task();
			lastUpdatedAt.value = Date.now();
		} catch {
			// The task reports its own failures; swallowing here keeps the loop alive.
		} finally {
			running = false;
			schedule();
		}
	}

	function togglePause(): void {
		paused.value = !paused.value;
		if (paused.value) {
			clearTimer();
		} else {
			void tick();
		}
	}

	function onVisibilityChange(): void {
		if (document.hidden) {
			clearTimer();
		} else if (!paused.value) {
			void tick();
		}
	}

	onMounted(() => {
		void tick();
		document.addEventListener('visibilitychange', onVisibilityChange);
	});

	onBeforeUnmount(() => {
		stopped = true;
		clearTimer();
		document.removeEventListener('visibilitychange', onVisibilityChange);
	});

	return {
		refresh: tick,
		lastUpdatedAt: readonly(lastUpdatedAt),
		paused: readonly(paused),
		togglePause,
	};
}
