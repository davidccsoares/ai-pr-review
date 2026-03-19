import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		// Only run the integration test (index.spec.js) in the workers pool.
		// Pure-function unit tests run in a separate config (vitest.unit.config.js).
		include: ['test/index.spec.js'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
