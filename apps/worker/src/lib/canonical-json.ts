function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === 'object') {
		const source = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			const child = source[key];
			if (child !== undefined) sorted[key] = sortValue(child);
		}
		return sorted;
	}
	return value;
}

/**
 * Stable JSON with recursively sorted keys. Hashing this form makes an agent
 * retry with different key order byte-identical for idempotency checks.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}
