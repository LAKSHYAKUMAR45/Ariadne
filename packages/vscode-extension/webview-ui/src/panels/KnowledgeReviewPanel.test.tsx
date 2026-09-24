import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import KnowledgeReviewPanel from './KnowledgeReviewPanel';
import type { AriadneBridge } from '../bridge';

describe('KnowledgeReviewPanel', () => {
  it('renders review actions and sends the selected action', async () => {
    const request = vi.fn(async (type: string) => type === 'knowledge.reviews' ? { reviews: [{ id: 'r1', summary: 'Review page', status: 'pending' }] } : {});
    const bridge: AriadneBridge = { request, subscribe: vi.fn(() => () => undefined) };
    render(<KnowledgeReviewPanel bridge={bridge} />);
    await waitFor(() => expect(screen.getByText('Review page')).toBeInTheDocument());
    screen.getByRole('button', { name: 'accept' }).click();
    await waitFor(() => expect(request).toHaveBeenCalledWith('knowledge.review.resolve', { reviewId: 'r1', action: 'accept' }));
  });
});
