<script setup lang="ts">
import type { EndpointFormValue } from '../domain/endpoint-form';

const props = defineProps<{
	modelValue: EndpointFormValue;
	/** Validation path prefix of the fields in the parent form model. */
	propPrefix?: string;
	nameLabel?: string;
	addressPlaceholder?: string;
	sniPlaceholder?: string;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: EndpointFormValue];
}>();

function patch(changes: Partial<EndpointFormValue>): void {
	emit('update:modelValue', { ...props.modelValue, ...changes });
}

function prop(name: string): string {
	return `${props.propPrefix ?? ''}${name}`;
}
</script>

<template>
	<el-form-item :label="nameLabel ?? '名称'" :prop="prop('name')">
		<el-input :model-value="modelValue.name" @update:model-value="patch({ name: $event })" />
	</el-form-item>
	<el-form-item label="地址" :prop="prop('host')">
		<el-input :model-value="modelValue.host" :placeholder="addressPlaceholder" @update:model-value="patch({ host: $event })" />
	</el-form-item>
	<el-form-item label="端口" :prop="prop('port')">
		<el-input-number :model-value="modelValue.port" :min="1" :max="65535" @update:model-value="patch({ port: $event as number })" />
	</el-form-item>
	<el-form-item label="SNI" :prop="prop('sni')">
		<el-input :model-value="modelValue.sni" :placeholder="sniPlaceholder" @update:model-value="patch({ sni: $event })" />
	</el-form-item>
	<el-form-item label="Public Key" :prop="prop('public_key')">
		<el-input :model-value="modelValue.public_key" @update:model-value="patch({ public_key: $event })" />
	</el-form-item>
	<el-form-item label="Short ID" :prop="prop('short_id')">
		<el-input :model-value="modelValue.short_id" @update:model-value="patch({ short_id: $event })" />
	</el-form-item>
	<el-form-item label="Fingerprint" :prop="prop('fingerprint')">
		<el-input :model-value="modelValue.fingerprint" @update:model-value="patch({ fingerprint: $event })" />
	</el-form-item>
	<el-form-item label="Flow">
		<el-input :model-value="modelValue.flow" disabled />
	</el-form-item>
	<el-form-item label="Network">
		<el-input :model-value="modelValue.network" disabled />
	</el-form-item>
</template>
