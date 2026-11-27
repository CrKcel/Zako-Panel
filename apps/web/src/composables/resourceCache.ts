import { shallowReactive } from 'vue';

export interface ResourceCacheEntry<T = unknown> {
	data: T;
	updatedAt: number;
}

interface InFlightRequest<T = unknown> {
	generation: number;
	promise: Promise<T>;
}

const entries = shallowReactive(new Map<string, ResourceCacheEntry>());
const generations = new Map<string, number>();
const inFlight = new Map<string, InFlightRequest>();

export function getResourceGeneration(key: string): number {
	return generations.get(key) ?? 0;
}

export function getCachedResource<T>(key: string): ResourceCacheEntry<T> | undefined {
	return entries.get(key) as ResourceCacheEntry<T> | undefined;
}

export function setCachedResource<T>(key: string, data: T, updatedAt = Date.now()): void {
	entries.set(key, { data, updatedAt });
}

/**
 * Marks a key stale and drops any in-flight request so the next reload hits the
 * server, while keeping cached data visible until the new response arrives.
 */
export function invalidateCachedResource(key: string): void {
	generations.set(key, getResourceGeneration(key) + 1);
	inFlight.delete(key);
}

export function invalidateCachedPrefix(prefix: string): void {
	for (const key of new Set([...entries.keys(), ...inFlight.keys(), ...generations.keys()])) {
		if (key.startsWith(prefix)) {
			invalidateCachedResource(key);
		}
	}
}

/** Removes a cached entry completely and invalidates any in-flight request. */
export function evictCachedResource(key: string): void {
	invalidateCachedResource(key);
	entries.delete(key);
}

export function clearResourceCache(): void {
	for (const key of new Set([...entries.keys(), ...inFlight.keys(), ...generations.keys()])) {
		generations.set(key, getResourceGeneration(key) + 1);
	}
	inFlight.clear();
	entries.clear();
}

export function getInFlightResource<T>(key: string, generation: number): Promise<T> | undefined {
	const current = inFlight.get(key);
	if (!current || current.generation !== generation) return undefined;
	return current.promise as Promise<T>;
}

export function setInFlightResource<T>(key: string, generation: number, promise: Promise<T>): void {
	inFlight.set(key, { generation, promise });
}

export function clearInFlightResource(key: string, promise: Promise<unknown>): void {
	const current = inFlight.get(key);
	if (current?.promise === promise) {
		inFlight.delete(key);
	}
}
