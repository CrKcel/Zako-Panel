/** Converts a picker value to the API's second precision. */
export function toUnixSeconds(value: Date | null): number | null {
	return value === null ? null : Math.floor(value.getTime() / 1000);
}

/** Converts API seconds to a picker value. */
export function fromUnixSeconds(value: number | null | undefined): Date | null {
	if (value === null || value === undefined) return null;
	return new Date(value * 1000);
}
