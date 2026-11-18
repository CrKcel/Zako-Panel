/**
 * D1 reports constraint violations as plain errors with the SQLite message, so
 * every service maps them to `409` through these two predicates instead of
 * matching message text on its own.
 */
export function isUniqueConstraintError(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export function isForeignKeyConstraintError(error: unknown): boolean {
	return error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message);
}
