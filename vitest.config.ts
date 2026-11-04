import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
		// The live suite talks to a real Keygate server; it self-skips when
		// KEYGATE_LIVE_URL is absent, so a plain `vitest run` stays green.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
