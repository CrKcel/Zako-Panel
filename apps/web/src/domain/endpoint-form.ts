import type { CreateEndpointRequest, Endpoint, VlessRealityParams } from '@zako/contracts';

/** Flat editing shape for the endpoint dialog; the protocol params are inlined. */
export type EndpointFormValue = Pick<CreateEndpointRequest, 'name' | 'host' | 'port'> & VlessRealityParams;

export function emptyEndpointFormValue(): EndpointFormValue {
	return {
		name: '',
		host: '',
		port: 443,
		sni: '',
		public_key: '',
		short_id: '',
		fingerprint: 'chrome',
		flow: 'xtls-rprx-vision',
		network: 'tcp',
	};
}

export function endpointFormValueFrom(endpoint: Endpoint): EndpointFormValue {
	return {
		name: endpoint.name,
		host: endpoint.host,
		port: endpoint.port,
		sni: endpoint.params.sni,
		public_key: endpoint.params.public_key,
		short_id: endpoint.params.short_id,
		fingerprint: endpoint.params.fingerprint,
		flow: endpoint.params.flow,
		network: endpoint.params.network,
	};
}

export function endpointRequestBody(value: EndpointFormValue): CreateEndpointRequest {
	return {
		name: value.name,
		host: value.host,
		port: value.port,
		params: {
			sni: value.sni,
			public_key: value.public_key,
			short_id: value.short_id,
			fingerprint: value.fingerprint,
			flow: value.flow,
			network: value.network,
		},
	};
}
