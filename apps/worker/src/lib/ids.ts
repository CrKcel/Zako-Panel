import { ulid } from 'ulid';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function newId(): string {
	return ulid();
}

export function isId(value: string): boolean {
	return ULID_PATTERN.test(value);
}

export function newXrayEmail(): string {
	return `u_${newId()}`;
}
