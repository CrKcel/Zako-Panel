import type { z } from 'zod';

export interface ProxyEndpoint {
	id: string;
	/** Display name chosen by the renderer; unique inside one subscription. */
	name: string;
	protocol: string;
	host: string;
	port: number;
	params: Record<string, unknown>;
}

/**
 * A protocol implementation owns parameter validation and output rendering.
 * Registering a new protocol only requires adding an adapter; the endpoint
 * and profile tables stay unchanged.
 */
export interface ProtocolAdapter {
	readonly protocol: string;
	readonly paramsSchema: z.ZodType<unknown>;
	toClash(_endpoint: ProxyEndpoint, _uuid: string): Record<string, unknown>;
	toUri(_endpoint: ProxyEndpoint, _uuid: string): string;
	toXrayInbound(_endpoint: ProxyEndpoint): Record<string, unknown>;
}
