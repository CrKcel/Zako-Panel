import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('api infrastructure', () => {
	it('adds a request id to unknown routes and uses the error envelope', async () => {
		const response = await SELF.fetch('https://panel.test/unknown');
		expect(response.status).toBe(404);
		expect(response.headers.get('X-Request-Id')).toMatch(ULID_PATTERN);

		const body = (await response.json()) as {
			error: { code: string; message: string; request_id: string };
		};
		expect(body.error.code).toBe('NOT_FOUND');
		expect(body.error.request_id).toBe(response.headers.get('X-Request-Id'));
	});

	it('rejects admin requests without an Access assertion', async () => {
		const response = await SELF.fetch('https://panel.test/api/v1/admin/nodes');
		expect(response.status).toBe(401);

		const body = (await response.json()) as {
			error: { code: string; request_id: string };
		};
		expect(body.error.code).toBe('UNAUTHORIZED');
		expect(body.error.request_id).toMatch(ULID_PATTERN);
	});

	it('rejects agent requests without a bearer token', async () => {
		const response = await SELF.fetch('https://panel.test/api/v1/agent/report', { method: 'POST' });
		expect(response.status).toBe(401);
	});

	it('rejects subscription requests with a malformed token', async () => {
		const response = await SELF.fetch('https://panel.test/sub/not-a-token/clash.yaml');
		expect(response.status).toBe(401);
		expect(response.headers.get('Content-Type')).toContain('application/json');
	});
});
