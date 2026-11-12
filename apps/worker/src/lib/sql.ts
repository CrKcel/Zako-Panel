/**
 * Builds a `?, ?, ?` placeholder list for a batched `IN (...)` clause. Callers
 * keep the number of bound values bounded by the D1 parameter limit.
 */
export function sqlPlaceholders(count: number): string {
	return Array.from({ length: count }, () => '?').join(', ');
}

/** Chunks a list into fixed-size groups so one statement stays under 100 parameters. */
export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}
