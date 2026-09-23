import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

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
