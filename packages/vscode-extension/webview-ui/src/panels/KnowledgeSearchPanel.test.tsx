import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import KnowledgeSearchPanel from './KnowledgeSearchPanel';
import type { AriadneBridge } from '../bridge';

describe('KnowledgeSearchPanel', () => {
  it('searches and renders cited results', async () => {
    const request = vi.fn(async () => ({ results: [{ id: 'p1', title: 'Auth', kind: 'page', snippet: 'Auth flow', citations: [{ id: 's1', label: 'docs/auth.md' }] }] }));
    const bridge: AriadneBridge = { request, subscribe: vi.fn(() => () => undefined) };
    render(<KnowledgeSearchPanel bridge={bridge} />);
    await userEvent.type(screen.getByLabelText('Knowledge search query'), 'auth');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('Auth')).toBeInTheDocument());
    expect(screen.getByText(/docs\/auth\.md/)).toBeInTheDocument();
  });
});
