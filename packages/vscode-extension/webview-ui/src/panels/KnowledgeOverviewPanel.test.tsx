import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import KnowledgeOverviewPanel from './KnowledgeOverviewPanel';
import type { AriadneBridge } from '../bridge';

function bridge(response: unknown): AriadneBridge {
  return { request: vi.fn(async () => response), subscribe: vi.fn(() => () => undefined) };
}

describe('KnowledgeOverviewPanel', () => {
  it('renders loading and success overview states', async () => {
    render(<KnowledgeOverviewPanel bridge={bridge({ overview: { title: 'Wiki', pageCount: 2, pages: [] } })} />);
    expect(screen.getByText(/Loading knowledge workspace/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Wiki')).toBeInTheDocument());
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders an empty state', async () => {
    render(<KnowledgeOverviewPanel bridge={bridge({ overview: null })} />);
    await waitFor(() => expect(screen.getByText(/No knowledge project/)).toBeInTheDocument());
  });
});
