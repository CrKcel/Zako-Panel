<script setup lang="ts">
import type { EndpointProtocol } from '@zako/contracts';
import { computed } from 'vue';

const props = defineProps<{
	protocol: EndpointProtocol | string;
}>();

const LABELS: Record<string, { label: string; tone: string }> = {
	'vless-reality': { label: 'VLESS · REALITY', tone: 'vless' },
	vmess: { label: 'VMess', tone: 'vmess' },
	trojan: { label: 'Trojan', tone: 'trojan' },
	shadowsocks: { label: 'Shadowsocks', tone: 'ss' },
	hysteria2: { label: 'Hysteria2', tone: 'hy2' },
};

const meta = computed(() => LABELS[props.protocol] ?? { label: props.protocol, tone: 'ss' });
</script>

<template>
	<span class="protocol-badge mono" :class="`proto-${meta.tone}`">
		{{ meta.label }}
	</span>
</template>

<style scoped>
.protocol-badge {
	display: inline-flex;
	align-items: center;
	padding: 2px 8px;
	border-radius: var(--radius-sm);
	font-size: 11.5px;
	font-weight: 500;
	line-height: 1.45;
	white-space: nowrap;
	border: 1px solid transparent;
}

.proto-vless {
	background: var(--proto-vless-bg);
	color: var(--proto-vless-fg);
	border-color: var(--proto-vless-border);
}

.proto-hy2 {
	background: var(--proto-hy2-bg);
	color: var(--proto-hy2-fg);
	border-color: var(--proto-hy2-border);
}

.proto-trojan {
	background: var(--proto-trojan-bg);
	color: var(--proto-trojan-fg);
	border-color: var(--proto-trojan-border);
}

.proto-vmess {
	background: var(--proto-vmess-bg);
	color: var(--proto-vmess-fg);
	border-color: var(--proto-vmess-border);
}

.proto-ss {
	background: var(--proto-ss-bg);
	color: var(--proto-ss-fg);
	border-color: var(--proto-ss-border);
}
</style>
