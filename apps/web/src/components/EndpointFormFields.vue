<script setup lang="ts">
import type { EndpointFormValue } from '../domain/endpoint-form';

const props = defineProps<{
	modelValue: EndpointFormValue;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: EndpointFormValue];
}>();

function patch(changes: Partial<EndpointFormValue>): void {
	emit('update:modelValue', { ...props.modelValue, ...changes });
}
</script>

<template>
	<el-form-item label="名称" prop="name">
		<el-input :model-value="modelValue.name" @update:model-value="patch({ name: $event })" />
	</el-form-item>
	<el-form-item label="地址" prop="host">
		<el-input :model-value="modelValue.host" placeholder="203.0.113.10" @update:model-value="patch({ host: $event })" />
	</el-form-item>
	<el-form-item label="端口" prop="port">
		<el-input-number :model-value="modelValue.port" :min="1" :max="65535" @update:model-value="patch({ port: $event as number })" />
	</el-form-item>
	<el-form-item label="SNI" prop="sni">
		<el-input :model-value="modelValue.sni" placeholder="www.example.com" @update:model-value="patch({ sni: $event })" />
	</el-form-item>
	<el-form-item label="Public Key" prop="public_key">
		<el-input :model-value="modelValue.public_key" @update:model-value="patch({ public_key: $event })" />
	</el-form-item>
	<el-form-item label="Short ID" prop="short_id">
		<el-input :model-value="modelValue.short_id" @update:model-value="patch({ short_id: $event })" />
	</el-form-item>
	<el-form-item label="Fingerprint" prop="fingerprint">
		<el-input :model-value="modelValue.fingerprint" @update:model-value="patch({ fingerprint: $event })" />
	</el-form-item>
	<el-form-item label="Flow">
		<el-input :model-value="modelValue.flow" disabled />
	</el-form-item>
	<el-form-item label="Network">
		<el-input :model-value="modelValue.network" disabled />
	</el-form-item>
</template>
