import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [vue()],
	base: '/admin/',
	build: {
		outDir: 'dist',
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		proxy: {
			'/api': 'http://127.0.0.1:8787',
			'/sub': 'http://127.0.0.1:8787',
		},
	},
});
