import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { vi } from 'vitest';
import { afterEach } from 'vitest';

if (typeof window.acquireVsCodeApi !== 'function') {
  Object.defineProperty(window, 'acquireVsCodeApi', {
    configurable: true,
    value: () => ({
      postMessage: vi.fn(),
      getState: vi.fn(() => undefined),
      setState: vi.fn(),
    }),
  });
}

afterEach(() => {
  cleanup();
});
