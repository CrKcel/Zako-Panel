import { onBeforeUnmount, readonly, ref, watch, type WatchSource } from 'vue';

const entityTitle = ref<string | null>(null);

export function useEntityBreadcrumb(source?: WatchSource<string | null | undefined>) {
	if (source !== undefined) {
		watch(
			source,
			(value) => {
				entityTitle.value = value && value.trim() !== '' ? value : null;
			},
			{ immediate: true },
		);

		onBeforeUnmount(() => {
			entityTitle.value = null;
		});
	}

	return {
		entityTitle: readonly(entityTitle),
	};
}
