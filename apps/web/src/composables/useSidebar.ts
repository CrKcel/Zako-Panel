import { readonly, ref } from 'vue';

const STORAGE_KEY = 'zako-panel.sidebar-collapsed';

function loadInitialCollapsed(): boolean {
	try {
		return typeof window !== 'undefined' && window.localStorage.getItem(STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

const collapsed = ref<boolean>(loadInitialCollapsed());

export function useSidebar() {
	function toggleCollapsed(): void {
		collapsed.value = !collapsed.value;
		try {
			if (typeof window !== 'undefined') {
				window.localStorage.setItem(STORAGE_KEY, collapsed.value ? '1' : '0');
			}
		} catch {
			// Ignore storage errors in restricted browsing modes.
		}
	}

	return {
		collapsed: readonly(collapsed),
		toggleCollapsed,
	};
}
