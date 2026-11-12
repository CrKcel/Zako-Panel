import type { z } from 'zod';
import { AppError } from './errors';
import type { AppContext } from '../types';

export const MAX_BODY_BYTES = 64 * 1024;

function invalid(detail: string): AppError {
	return new AppError('VALIDATION_ERROR', `Invalid request: ${detail}`, 400);
}

function firstIssue(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return 'unknown field';
	const path = issue.path.join('.');
	return path ? `${path} ${issue.message}` : issue.message;
}

export async function readJson<T>(c: AppContext, schema: z.ZodType<T>, maxBytes = MAX_BODY_BYTES): Promise<T> {
	const body = await c.req.text();
	if (new TextEncoder().encode(body).byteLength > maxBytes) {
		throw new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(body) as unknown;
	} catch {
		throw new AppError('BAD_REQUEST', 'Request body must be valid JSON', 400);
	}
	const result = schema.safeParse(raw);
	if (!result.success) throw invalid(firstIssue(result.error));
	return result.data;
}

export function readQuery<T>(c: AppContext, schema: z.ZodType<T>): T {
	const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
	const result = schema.safeParse(raw);
	if (!result.success) throw invalid(firstIssue(result.error));
	return result.data;
}
