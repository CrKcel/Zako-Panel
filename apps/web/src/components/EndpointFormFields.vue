<script setup lang="ts">
import type { EndpointProtocol } from '@zako/contracts';
import {
	ENDPOINT_NETWORKS,
	ENDPOINT_PROTOCOLS,
	endpointProtocolFields,
	HYSTERIA2_OBFS_MODES,
	SHADOWSOCKS_METHODS,
	VMESS_SECURITY_MODES,
	type EndpointFormValue,
} from '../domain/endpoint-form';
import { useI18n } from '../i18n';

const props = defineProps<{
	modelValue: EndpointFormValue;
	editing: boolean;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: EndpointFormValue];
}>();

const { t } = useI18n();

function patch(changes: Partial<EndpointFormValue>): void {
	emit('update:modelValue', { ...props.modelValue, ...changes });
}

function changeProtocol(protocol: EndpointProtocol): void {
	// Replacing the value drops the previous protocol's params so switching back
	// cannot resurrect stale values.
	const { name, host, port } = props.modelValue;
	emit('update:modelValue', { name, host, port, ...endpointProtocolFields(protocol) });
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
	<el-form-item :label="t('nodeDetail.endpoints.protocol')" prop="protocol">
		<el-select
			:model-value="modelValue.protocol"
			:disabled="editing"
			class="full-width"
			@update:model-value="changeProtocol($event as EndpointProtocol)"
		>
			<el-option v-for="option in ENDPOINT_PROTOCOLS" :key="option.value" :label="option.label" :value="option.value" />
		</el-select>
	</el-form-item>

	<template v-if="modelValue.protocol === 'vless-reality'">
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

	<template v-else-if="modelValue.protocol === 'vmess'">
		<el-form-item :label="t('nodeDetail.endpoints.security')" prop="security">
			<el-select
				:model-value="modelValue.security"
				class="full-width"
				@update:model-value="patch({ security: $event as EndpointFormValue['security'] })"
			>
				<el-option v-for="mode in VMESS_SECURITY_MODES" :key="mode" :label="mode" :value="mode" />
			</el-select>
		</el-form-item>
		<el-form-item :label="t('nodeDetail.endpoints.sni')" prop="sni">
			<el-input :model-value="modelValue.sni" placeholder="www.example.com" @update:model-value="patch({ sni: $event })" />
		</el-form-item>
		<el-form-item :label="t('nodeDetail.endpoints.network')" prop="network">
			<el-select
				:model-value="modelValue.network"
				class="full-width"
				@update:model-value="patch({ network: $event as EndpointFormValue['network'] })"
			>
				<el-option v-for="network in ENDPOINT_NETWORKS" :key="network" :label="network" :value="network" />
			</el-select>
		</el-form-item>
		<el-form-item :label="t('nodeDetail.endpoints.path')" prop="path">
			<el-input :model-value="modelValue.path" @update:model-value="patch({ path: $event })" />
		</el-form-item>
		<el-form-item :label="t('nodeDetail.endpoints.hostHeader')" prop="host_header">
			<el-input :model-value="modelValue.host_header" @update:model-value="patch({ host_header: $event })" />
		</el-form-item>
	</template>

	<template v-else-if="modelValue.protocol === 'trojan'">
		<el-form-item :label="t('nodeDetail.endpoints.sni')" prop="sni">
			<el-input :model-value="modelValue.sni" placeholder="www.example.com" @update:model-value="patch({ sni: $event })" />
		</el-form-item>
		<el-form-item :label="t('nodeDetail.endpoints.network')" prop="network">
			<el-select
				:model-value="modelValue.network"
				class="full-width"
				@update:model-value="patch({ network: $event as EndpointFormValue['network'] })"
			>
				<el-option v-for="network in ENDPOINT_NETWORKS" :key="network" :label="network" :value="network" />
			</el-select>
		</el-form-item>
		<el-form-item :label="t('nodeDetail.endpoints.path')" prop="path">
			<el-input :model-value="modelValue.path" @update:model-value="patch({ path: $event })" />
		</el-form-item>
		<el-form-item :label="t('nodeDetail.endpoints.hostHeader')" prop="host_header">
			<el-input :model-value="modelValue.host_header" @update:model-value="patch({ host_header: $event })" />
		</el-form-item>
	</template>

	<template v-else-if="modelValue.protocol === 'shadowsocks'">
		<el-form-item :label="t('nodeDetail.endpoints.method')" prop="method">
			<el-select
				:model-value="modelValue.method"
				class="full-width"
				@update:model-value="patch({ method: $event as EndpointFormValue['method'] })"
			>
				<el-option v-for="method in SHADOWSOCKS_METHODS" :key="method" :label="method" :value="method" />
			</el-select>
		</el-form-item>
	</template>

	<template v-else-if="modelValue.protocol === 'hysteria2'">
		<el-form-item :label="t('nodeDetail.endpoints.sni')" prop="sni">
			<el-input :model-value="modelValue.sni" placeholder="www.example.com" @update:model-value="patch({ sni: $event })" />
		</el-form-item>
		<el-form-item :label="t('nodeDetail.endpoints.obfs')" prop="obfs">
			<el-select
				:model-value="modelValue.obfs"
				class="full-width"
				@update:model-value="patch({ obfs: $event as EndpointFormValue['obfs'] })"
			>
				<el-option v-for="mode in HYSTERIA2_OBFS_MODES" :key="mode" :label="mode" :value="mode" />
			</el-select>
		</el-form-item>
		<el-form-item v-if="modelValue.obfs === 'salamander'" :label="t('nodeDetail.endpoints.obfsPassword')" prop="obfs_password">
			<el-input :model-value="modelValue.obfs_password" @update:model-value="patch({ obfs_password: $event })" />
		</el-form-item>
	</template>
</template>

<style scoped>
.full-width {
	width: 100%;
}
</style>
