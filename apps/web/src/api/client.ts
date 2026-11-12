import type { ListMeta } from '@zako/contracts';

export interface Page<T> {
	items: T[];
	next_cursor: string | null;
}

export interface RequestOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
	body?: unknown;
	query?: Record<string, string | number | boolean | null | undefined>;
}

interface Envelope<T> {
	data: T;
	meta: ListMeta;
}

interface ErrorEnvelope {
	error: {
		code: string;
		message: string;
		request_id: string;
	};
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly requestId: string | undefined;

	constructor(status: number, code: string, message: string, requestId?: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.requestId = requestId;
	}
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
	return typeof value === 'object' && value !== null && 'error' in value;
}

async function envelope<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
	const url = new URL(path, window.location.origin);
	for (const [key, value] of Object.entries(options.query ?? {})) {
		if (value === undefined || value === null || value === '') continue;
		url.searchParams.set(key, String(value));
	}

	const response = await fetch(url.toString(), {
		method: options.method ?? 'GET',
		credentials: 'same-origin',
		headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});

	if (response.status === 204) return { data: undefined as T, meta: { request_id: '' } };

	const payload: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const error = isErrorEnvelope(payload) ? payload.error : null;
		throw new ApiError(
			response.status,
			error?.code ?? 'UNKNOWN',
			error?.message ?? response.statusText,
			error?.request_id ?? response.headers.get('X-Request-Id') ?? undefined,
		);
	}

	return payload as Envelope<T>;
}

export async function apiRequest<T>(path: string, options?: RequestOptions): Promise<T> {
	const { data } = await envelope<T>(path, options);
	return data;
}

export async function apiPage<T>(path: string, options?: RequestOptions): Promise<Page<T>> {
	const { data, meta } = await envelope<{ items: T[] }>(path, options);
	return { items: data.items, next_cursor: meta.next_cursor ?? null };
}
