import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import KnowledgeGraphPanel from './KnowledgeGraphPanel';
import type { AriadneBridge } from '../bridge';

describe('KnowledgeGraphPanel', () => {
  it('renders graph nodes and insights', async () => {
    const bridge: AriadneBridge = { request: vi.fn(async () => ({ graph: { nodes: [{ id: 'n1', label: 'API' }], edges: [], insights: ['Central node'] } })), subscribe: vi.fn(() => () => undefined) };
    render(<KnowledgeGraphPanel bridge={bridge} />);
    await waitFor(() => expect(screen.getByText('API')).toBeInTheDocument());
    expect(screen.getByText('Central node')).toBeInTheDocument();
  });
});
