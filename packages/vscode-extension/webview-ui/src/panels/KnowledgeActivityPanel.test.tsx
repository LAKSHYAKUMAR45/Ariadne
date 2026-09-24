import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import KnowledgeActivityPanel from './KnowledgeActivityPanel';
import type { AriadneBridge } from '../bridge';

describe('KnowledgeActivityPanel', () => {
  it('renders queue progress and activity', async () => {
    const bridge: AriadneBridge = { request: vi.fn(async () => ({ items: [{ id: 'a1', title: 'Rebuilt pages' }], queue: { queued: 1, running: 0, failed: 0 } })), subscribe: vi.fn(() => () => undefined) };
    render(<KnowledgeActivityPanel bridge={bridge} />);
    await waitFor(() => expect(screen.getByText('Rebuilt pages')).toBeInTheDocument());
    expect(screen.getByText('queued')).toBeInTheDocument();
  });
});
