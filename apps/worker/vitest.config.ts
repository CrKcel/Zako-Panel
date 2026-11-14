import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: '../../wrangler.jsonc' },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations('../../migrations'),
					// 测试不依赖本地 .dev.vars 的开发登录配置。
					ENVIRONMENT: 'production',
				},
			},
		})),
	],
	test: {
		include: ['test/**/*.test.ts'],
		setupFiles: ['./test/setup-d1.ts'],
	},
});
