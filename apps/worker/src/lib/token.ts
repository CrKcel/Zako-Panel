import { base64UrlEncode } from './base64';
import { isId } from './ids';

const TOKEN_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function generateToken(byteLength = TOKEN_BYTES): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function isTokenShaped(value: string): boolean {
	return value.length >= 43 && BASE64URL_PATTERN.test(value);
}

export interface AgentToken {
	nodeId: string;
	secret: string;
}

/**
 * Agent tokens are `Bearer <node_id>.<secret>`; the node id is a ULID and the
 * secret is URL-safe base64 without separators.
 */
export function parseAgentToken(value: string | undefined): AgentToken | null {
	if (!value) return null;
	const parts = value.split('.');
	if (parts.length !== 2) return null;
	const [nodeId, secret] = parts;
	if (!nodeId || !secret || !isId(nodeId) || !isTokenShaped(secret)) return null;
	return { nodeId, secret };
}
