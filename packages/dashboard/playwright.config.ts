import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const packageDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/admin/',
    headless: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'pnpm --filter @ariadne-dev/dashboard run build && pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
    cwd: packageDir,
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
