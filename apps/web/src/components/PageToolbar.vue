<script setup lang="ts">
defineProps<{ spread?: boolean }>();
</script>

<template>
	<div class="page-toolbar" :class="{ 'is-spread': spread }">
		<slot />
	</div>
</template>

<style scoped>
.page-toolbar {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	margin-bottom: 16px;
}

.is-spread {
	gap: 0;
	justify-content: space-between;
}
</style>
