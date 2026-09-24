import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['webview-ui/**'],
    setupFiles: ['./test/setup.ts'],
  },
});
