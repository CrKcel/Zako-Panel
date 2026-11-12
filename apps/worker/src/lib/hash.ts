function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

export async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
	const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
	const digest = await crypto.subtle.digest('SHA-256', data);
	return toHex(new Uint8Array(digest));
}

/**
 * Compares two lower-case hex digests without leaking the first differing byte
 * through an early return. Length differences are folded into the accumulator.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
	const length = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < length; i += 1) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}
