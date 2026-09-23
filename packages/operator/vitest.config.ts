import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The tracked deployment contract tests (deploy/nodem2/test) exercise shell
    // scripts rather than a workspace package, so they run under this package's
    // vitest project instead of adding a package just for them.
    include: ['test/**/*.test.ts', '../../deploy/nodem2/test/**/*.test.ts'],
    // The deployment tests spawn many short-lived shell processes; running test
    // files sequentially keeps that load from perturbing the operator server's
    // timing-sensitive concurrency tests.
    fileParallelism: false,
  },
});
