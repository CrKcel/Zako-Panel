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
 * The single credential of one node grant. UUID protocols render it as the UUID;
 * password protocols render it verbatim as the password, so a subscriber has one
 * secret on a node regardless of how many protocols that node serves.
 */
export interface ProxyCredential {
	secret: string;
}

/**
 * A protocol implementation owns parameter validation and output rendering.
 * Registering a new protocol only requires adding an adapter; the endpoint
 * and profile tables stay unchanged.
 */
export interface ProtocolAdapter {
	readonly protocol: string;
	readonly paramsSchema: z.ZodType<unknown>;
	toClash(_endpoint: ProxyEndpoint, _credential: ProxyCredential): Record<string, unknown>;
	toUri(_endpoint: ProxyEndpoint, _credential: ProxyCredential): string;
}
