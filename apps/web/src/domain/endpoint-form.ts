import type {
	CreateEndpointRequest,
	Endpoint,
	EndpointProtocol,
	Hysteria2Params,
	ProtocolParams,
	ShadowsocksParams,
	TrojanParams,
	VlessRealityParams,
	VmessParams,
} from '@zako/contracts';

export interface EndpointProtocolOption {
	value: EndpointProtocol;
	label: string;
}

/** Admin display order; protocol names are product names and are not translated. */
export const ENDPOINT_PROTOCOLS: ReadonlyArray<EndpointProtocolOption> = [
	{ value: 'vless-reality', label: 'VLESS + REALITY' },
	{ value: 'vmess', label: 'VMess' },
	{ value: 'trojan', label: 'Trojan' },
	{ value: 'shadowsocks', label: 'Shadowsocks' },
	{ value: 'hysteria2', label: 'Hysteria2' },
];

export const VMESS_SECURITY_MODES = ['tls', 'none'] as const;
export const ENDPOINT_NETWORKS = ['tcp', 'ws', 'grpc'] as const;
export const SHADOWSOCKS_METHODS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305'] as const;
export const HYSTERIA2_OBFS_MODES = ['none', 'salamander'] as const;

/** Flat editing shape for the endpoint dialog; the protocol params are inlined. */
export interface EndpointFormValue {
	name: string;
	host: string;
	port: number;
	protocol: EndpointProtocol;
	sni?: string;
	public_key?: string;
	short_id?: string;
	fingerprint?: string;
	flow?: VlessRealityParams['flow'];
	network?: VmessParams['network'];
	security?: VmessParams['security'];
	path?: string;
	/**
	 * ws Host header / gRPC authority. The contract names this param `host`, which the flat
	 * form already uses for the endpoint address.
	 */
	host_header?: string;
	method?: ShadowsocksParams['method'];
	obfs?: Hysteria2Params['obfs'];
	obfs_password?: string;
}

type EndpointProtocolFields = Omit<EndpointFormValue, 'name' | 'host' | 'port'>;

/**
 * Fields of a fresh endpoint with the given protocol. Switching the protocol while creating
 * resets the params so only the active protocol's inputs carry values.
 */
export function endpointProtocolFields(protocol: EndpointProtocol): EndpointProtocolFields {
	switch (protocol) {
		case 'vless-reality':
			return {
				protocol,
				sni: '',
				public_key: '',
				short_id: '',
				fingerprint: 'chrome',
				flow: 'xtls-rprx-vision',
				network: 'tcp',
			};
		case 'vmess':
			return { protocol, security: 'tls', sni: '', network: 'tcp', path: '', host_header: '' };
		case 'trojan':
			return { protocol, sni: '', network: 'tcp', path: '', host_header: '' };
		case 'shadowsocks':
			return { protocol, method: 'aes-256-gcm' };
		case 'hysteria2':
			return { protocol, sni: '', obfs: 'none', obfs_password: '' };
	}
}

export function emptyEndpointFormValue(): EndpointFormValue {
	return { name: '', host: '', port: 443, ...endpointProtocolFields('vless-reality') };
}

/**
 * The contract types `params` as a union of per-protocol objects. Callers switch on the
 * protocol first, so the matching member is the only shape the endpoint can store.
 */
export function endpointParamsOf<T extends ProtocolParams>(endpoint: Endpoint): T {
	return endpoint.params as T;
}

export function endpointFormValueFrom(endpoint: Endpoint): EndpointFormValue {
	const base = { name: endpoint.name, host: endpoint.host, port: endpoint.port, protocol: endpoint.protocol };
	switch (endpoint.protocol) {
		case 'vless-reality':
			return { ...base, ...endpointParamsOf<VlessRealityParams>(endpoint) };
		case 'vmess': {
			const { host: hostHeader, ...params } = endpointParamsOf<VmessParams>(endpoint);
			return { ...base, ...params, host_header: hostHeader };
		}
		case 'trojan': {
			const { host: hostHeader, ...params } = endpointParamsOf<TrojanParams>(endpoint);
			return { ...base, ...params, host_header: hostHeader };
		}
		case 'shadowsocks':
			return { ...base, ...endpointParamsOf<ShadowsocksParams>(endpoint) };
		case 'hysteria2':
			return { ...base, ...endpointParamsOf<Hysteria2Params>(endpoint) };
	}
}

export function endpointRequestBody(value: EndpointFormValue): CreateEndpointRequest {
	return {
		name: value.name,
		host: value.host,
		port: value.port,
		protocol: value.protocol,
		params: endpointParams(value),
	};
}

function endpointParams(value: EndpointFormValue): ProtocolParams {
	switch (value.protocol) {
		case 'vless-reality':
			return {
				sni: value.sni ?? '',
				public_key: value.public_key ?? '',
				short_id: value.short_id ?? '',
				fingerprint: value.fingerprint ?? 'chrome',
				flow: value.flow ?? 'xtls-rprx-vision',
				network: 'tcp',
			};
		case 'vmess':
			return {
				security: value.security ?? 'none',
				sni: value.sni ?? '',
				network: value.network ?? 'tcp',
				path: value.path ?? '',
				host: value.host_header ?? '',
			};
		case 'trojan':
			return {
				sni: value.sni ?? '',
				network: value.network ?? 'tcp',
				path: value.path ?? '',
				host: value.host_header ?? '',
			};
		case 'shadowsocks':
			return { method: value.method ?? 'aes-256-gcm' };
		case 'hysteria2':
			return {
				sni: value.sni ?? '',
				obfs: value.obfs ?? 'none',
				obfs_password: value.obfs === 'salamander' ? (value.obfs_password ?? '') : '',
			};
	}
}

const PUBLIC_KEY_SUMMARY_LENGTH = 8;

function shorten(value: string): string {
	return value.length > PUBLIC_KEY_SUMMARY_LENGTH ? `${value.slice(0, PUBLIC_KEY_SUMMARY_LENGTH)}…` : value;
}

function summaryOf(parts: ReadonlyArray<string | false>): string {
	return parts.filter((part): part is string => part !== false && part !== '').join(' · ');
}

function transportSummary(network: string, path: string, sni: string): string {
	return summaryOf([path === '' ? network : `${network} ${path}`, sni !== '' && `SNI ${sni}`]);
}

/** Compact single-line param summary for the endpoints table. */
export function endpointParamsSummary(endpoint: Endpoint): string {
	switch (endpoint.protocol) {
		case 'vless-reality': {
			const params = endpointParamsOf<VlessRealityParams>(endpoint);
			return summaryOf([
				params.sni !== '' && `SNI ${params.sni}`,
				params.public_key !== '' && `PBK ${shorten(params.public_key)}`,
				params.short_id !== '' && `SID ${params.short_id}`,
			]);
		}
		case 'vmess': {
			const params = endpointParamsOf<VmessParams>(endpoint);
			return transportSummary(params.network, params.path, params.sni);
		}
		case 'trojan': {
			const params = endpointParamsOf<TrojanParams>(endpoint);
			return transportSummary(params.network, params.path, params.sni);
		}
		case 'shadowsocks':
			return endpointParamsOf<ShadowsocksParams>(endpoint).method;
		case 'hysteria2': {
			const params = endpointParamsOf<Hysteria2Params>(endpoint);
			return summaryOf([params.obfs, params.sni !== '' && `SNI ${params.sni}`]);
		}
	}
}
