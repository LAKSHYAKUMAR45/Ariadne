import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 15000,
    globalSetup: ['./test/globalSetup.ts'],
    // All test files share one real Postgres instance (see test/testConfig.ts) —
    // run them sequentially to avoid concurrent-migration races between files.
    fileParallelism: false,
  },
});
