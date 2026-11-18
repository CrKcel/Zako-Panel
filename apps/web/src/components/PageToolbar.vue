<script setup lang="ts">
defineProps<{ spread?: boolean }>();
</script>

<template>
	<div class="page-toolbar" :class="{ 'is-spread': spread }">
		<slot name="left" />
		<div class="toolbar-right">
			<slot />
		</div>
	</div>
</template>

<style scoped>
.page-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	flex-wrap: wrap;
	margin-bottom: 16px;
}

.toolbar-right {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
	margin-left: auto;
}

.is-spread .toolbar-right {
	margin-left: 0;
}
</style>
