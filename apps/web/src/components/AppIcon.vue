<script setup lang="ts">
export type IconName =
	| 'overview'
	| 'nodes'
	| 'subscribers'
	| 'profiles'
	| 'subscriptions'
	| 'traffic'
	| 'menu'
	| 'refresh'
	| 'plus'
	| 'back'
	| 'copy'
	| 'arrow-up'
	| 'arrow-down'
	| 'activity'
	| 'globe';

withDefaults(
	defineProps<{
		name: IconName;
		size?: number;
	}>(),
	{
		size: 16,
	},
);
</script>

<template>
	<svg
		:width="size"
		:height="size"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.8"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		class="app-icon"
	>
		<template v-if="name === 'overview'">
			<rect x="3" y="3" width="7" height="7" rx="1.5" />
			<rect x="14" y="3" width="7" height="7" rx="1.5" />
			<rect x="3" y="14" width="7" height="7" rx="1.5" />
			<rect x="14" y="14" width="7" height="7" rx="1.5" />
		</template>
		<template v-else-if="name === 'nodes'">
			<rect x="2" y="3" width="20" height="7" rx="2" />
			<rect x="2" y="14" width="20" height="7" rx="2" />
			<circle cx="6.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
			<circle cx="6.5" cy="17.5" r="1" fill="currentColor" stroke="none" />
		</template>
		<template v-else-if="name === 'subscribers'">
			<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
			<circle cx="9" cy="7" r="4" />
			<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
			<path d="M16 3.13a4 4 0 0 1 0 7.75" />
		</template>
		<template v-else-if="name === 'profiles'">
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<polyline points="14 2 14 8 20 8" />
			<line x1="8" y1="13" x2="16" y2="13" />
			<line x1="8" y1="17" x2="13" y2="17" />
		</template>
		<template v-else-if="name === 'subscriptions'">
			<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
			<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
		</template>
		<template v-else-if="name === 'traffic'">
			<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
		</template>
		<template v-else-if="name === 'menu'">
			<line x1="4" y1="6" x2="20" y2="6" />
			<line x1="4" y1="12" x2="20" y2="12" />
			<line x1="4" y1="18" x2="20" y2="18" />
		</template>
		<template v-else-if="name === 'refresh'">
			<polyline points="23 4 23 10 17 10" />
			<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
		</template>
		<template v-else-if="name === 'plus'">
			<line x1="12" y1="5" x2="12" y2="19" />
			<line x1="5" y1="12" x2="19" y2="12" />
		</template>
		<template v-else-if="name === 'back'">
			<line x1="19" y1="12" x2="5" y2="12" />
			<polyline points="12 19 5 12 12 5" />
		</template>
		<template v-else-if="name === 'copy'">
			<rect x="9" y="9" width="13" height="13" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</template>
		<template v-else-if="name === 'arrow-up'">
			<line x1="12" y1="19" x2="12" y2="5" />
			<polyline points="5 12 12 5 19 12" />
		</template>
		<template v-else-if="name === 'arrow-down'">
			<line x1="12" y1="5" x2="12" y2="19" />
			<polyline points="19 12 12 19 5 12" />
		</template>
		<template v-else-if="name === 'activity'">
			<circle cx="12" cy="12" r="9" />
			<polyline points="12 7 12 12 15 14" />
		</template>
		<template v-else-if="name === 'globe'">
			<circle cx="12" cy="12" r="9" />
			<path d="M3 12h18" />
			<path d="M12 3a14 14 0 0 1 0 18" />
			<path d="M12 3a14 14 0 0 0 0 18" />
		</template>
	</svg>
</template>

<style scoped>
.app-icon {
	flex: none;
	display: inline-block;
	vertical-align: middle;
}
</style>
