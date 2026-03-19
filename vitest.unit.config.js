import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Unit tests for pure functions — no Cloudflare Workers pool needed
		include: ['test/gateway.spec.js', 'test/review.spec.js', 'test/pw-generate.spec.js'],
	},
});
