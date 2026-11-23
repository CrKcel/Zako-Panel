import { z } from 'zod';

/** Proxy transports the panel renders; `tcp` carries no extra client options. */
export const transportNetworkSchema = z.enum(['tcp', 'ws', 'grpc']);

export type TransportNetwork = z.infer<typeof transportNetworkSchema>;

export interface TransportParams {
	network: TransportNetwork;
	/** WebSocket path or gRPC service name; empty keeps the client default. */
	path: string;
	/** WebSocket Host header or gRPC authority; empty omits it. */
	host: string;
}

/** Clash `ws-opts` / `grpc-opts` for one endpoint; tcp renders no options block. */
export function clashTransportOptions(params: TransportParams): Record<string, unknown> {
	if (params.network === 'ws') {
		const ws: Record<string, unknown> = { path: params.path === '' ? '/' : params.path };
		if (params.host !== '') ws.headers = { Host: params.host };
		return { 'ws-opts': ws };
	}
	if (params.network === 'grpc') {
		return { 'grpc-opts': { 'grpc-service-name': params.path } };
	}
	return {};
}

/**
 * URI query entries for the transport; callers prepend their own TLS entries.
 *
 * gRPC shares its parameters with no other transport in the de-facto share-link
 * formats: the service name is `serviceName` and the host is `authority`, while
 * `path` and `host` belong to WebSocket and HTTP/2. A gRPC endpoint that only
 * carried `path` imported with an empty service name in v2rayN, v2rayNG, sing-box
 * and NekoBox.
 */
export function transportUriQuery(params: TransportParams): string[] {
	const query = [`type=${encodeURIComponent(params.network)}`];
	if (params.network === 'grpc') {
		if (params.path !== '') query.push(`serviceName=${encodeURIComponent(params.path)}`);
		if (params.host !== '') query.push(`authority=${encodeURIComponent(params.host)}`);
		return query;
	}
	if (params.path !== '') query.push(`path=${encodeURIComponent(params.path)}`);
	if (params.host !== '') query.push(`host=${encodeURIComponent(params.host)}`);
	return query;
}

/** IPv6 literals must be bracketed inside a URI authority. */
export function uriHost(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
