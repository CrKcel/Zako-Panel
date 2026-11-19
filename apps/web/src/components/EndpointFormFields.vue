<script setup lang="ts">
import type { EndpointFormValue } from '../domain/endpoint-form';
import { useI18n } from '../i18n';

const props = defineProps<{
	modelValue: EndpointFormValue;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: EndpointFormValue];
}>();

const { t } = useI18n();

function patch(changes: Partial<EndpointFormValue>): void {
	emit('update:modelValue', { ...props.modelValue, ...changes });
}
</script>

<template>
	<el-form-item :label="t('common.name')" prop="name">
		<el-input :model-value="modelValue.name" @update:model-value="patch({ name: $event })" />
	</el-form-item>
	<el-form-item :label="t('nodeDetail.endpoints.host')" prop="host">
		<el-input :model-value="modelValue.host" placeholder="203.0.113.10" @update:model-value="patch({ host: $event })" />
	</el-form-item>
	<el-form-item :label="t('nodeDetail.endpoints.port')" prop="port">
		<el-input-number :model-value="modelValue.port" :min="1" :max="65535" @update:model-value="patch({ port: $event as number })" />
	</el-form-item>
	<el-form-item :label="t('nodeDetail.endpoints.sni')" prop="sni">
		<el-input :model-value="modelValue.sni" placeholder="www.example.com" @update:model-value="patch({ sni: $event })" />
	</el-form-item>
	<el-form-item :label="t('nodeDetail.endpoints.publicKey')" prop="public_key">
		<el-input :model-value="modelValue.public_key" @update:model-value="patch({ public_key: $event })" />
	</el-form-item>
	<el-form-item :label="t('nodeDetail.endpoints.shortId')" prop="short_id">
		<el-input :model-value="modelValue.short_id" @update:model-value="patch({ short_id: $event })" />
	</el-form-item>
	<el-form-item :label="t('nodeDetail.endpoints.fingerprint')" prop="fingerprint">
		<el-input :model-value="modelValue.fingerprint" @update:model-value="patch({ fingerprint: $event })" />
	</el-form-item>
	<el-form-item :label="t('nodeDetail.endpoints.flow')">
		<el-input :model-value="modelValue.flow" disabled />
	</el-form-item>
	<el-form-item :label="t('nodeDetail.endpoints.network')">
		<el-input :model-value="modelValue.network" disabled />
	</el-form-item>
</template>
