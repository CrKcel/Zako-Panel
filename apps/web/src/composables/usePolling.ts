import { onBeforeUnmount, onMounted } from 'vue';

export interface PollingHandle {
	refresh: () => Promise<void>;
}

/**
 * Runs `task` immediately and then every `intervalMs`, pausing while the tab is
 * hidden so background tabs do not keep issuing requests.
 */
export function usePolling(task: () => Promise<void> | void, intervalMs = 30_000): PollingHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let stopped = false;

	function clearTimer(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function schedule(): void {
		clearTimer();
		if (stopped || document.hidden) return;
		timer = setTimeout(() => {
			void tick();
		}, intervalMs);
	}

	async function tick(): Promise<void> {
		if (running) return;
		running = true;
		try {
			await task();
		} finally {
			running = false;
			schedule();
		}
	}

	function onVisibilityChange(): void {
		if (document.hidden) {
			clearTimer();
		} else {
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

	return { refresh: tick };
}
