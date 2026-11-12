export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Cloudflare captures JSON log lines with indexed fields. Tokens, UUIDs,
 * subscription URLs and request bodies are never passed to this helper.
 */
export function log(level: LogLevel, fields: LogFields): void {
	const line = JSON.stringify({ level, ...fields });
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else console.log(line);
}
