import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { KnowledgeOverviewPage } from './KnowledgeOverviewPage';
import { KnowledgeReviewsPage } from './KnowledgeReviewsPage';
import { KnowledgeSearchPage } from './KnowledgeSearchPage';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderWithProvider(child: ReactNode) {
  return render(<AuthProvider>{child}</AuthProvider>);
}

const session = {
  userId: 'admin-id',
  username: 'admin',
  role: 'admin',
  csrfToken: 'csrf-token',
  reauthenticatedUntil: null,
};

const projects = {
  projects: [{
    id: 'project-1',
    name: 'Ariadne',
    description: 'Task and source knowledge',
    status: 'active',
    sourceCount: 4,
    pageCount: 8,
    pendingReviewCount: 1,
    worker: {
      queued: 3,
      running: 1,
      failed: 2,
      oldestQueuedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      activeWorkerCount: 1,
      deterministicCompleted: 7,
      enrichedCompleted: 2,
    },
    updatedAt: '2026-09-24T12:00:00.000Z',
  }],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('knowledge dashboard pages', () => {
  it('renders project-scoped overview metrics and empty boundaries', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') return Promise.resolve(json(session));
      if (url === '/api/v1/admin/knowledge/projects') return Promise.resolve(json(projects));
      return Promise.resolve(new Response(null, { status: 404 }));
    }));

    renderWithProvider(<KnowledgeOverviewPage />);
    expect(await screen.findByText('Task and source knowledge')).toBeVisible();
    expect(screen.getByLabelText('Knowledge totals')).toHaveTextContent('Sources4');
    expect(screen.getByText('Pending reviews')).toBeVisible();
    expect(screen.getByLabelText('Knowledge worker status')).toHaveTextContent('Queued3');
    expect(screen.getByLabelText('Knowledge worker status')).toHaveTextContent('Running1');
    expect(screen.getByLabelText('Knowledge worker status')).toHaveTextContent('Failed2');
    expect(screen.getByLabelText('Knowledge worker status')).toHaveTextContent('Active workers1');
    expect(screen.getByLabelText('Knowledge worker status')).toHaveTextContent('Deterministic7');
    expect(screen.getByLabelText('Knowledge worker status')).toHaveTextContent('Enriched2');
    expect(screen.getByLabelText('Knowledge worker status')).toHaveTextContent(/minute/);
    expect(screen.queryByLabelText(/provider secret/i)).not.toBeInTheDocument();
  });

  it('selects the chronologically oldest queued timestamp across timezone offsets', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-28T08:00:00Z'));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') return Promise.resolve(json(session));
      if (url === '/api/v1/admin/knowledge/projects') {
        return Promise.resolve(json({
          projects: [
            {
              ...projects.projects[0],
              id: 'project-offset',
              worker: { ...projects.projects[0].worker, oldestQueuedAt: '2026-09-28T00:00:00-07:00' },
            },
            {
              ...projects.projects[0],
              id: 'project-zulu',
              worker: { ...projects.projects[0].worker, oldestQueuedAt: '2026-09-28T06:00:00Z' },
            },
          ],
        }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }));

    renderWithProvider(<KnowledgeOverviewPage />);

    expect(await screen.findByLabelText('Knowledge worker status')).toHaveTextContent('Oldest queued: 2 hours');
  });

  it('shows loading and explicit API errors for project reads', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/admin/session') return Promise.resolve(json(session));
      if (String(input) === '/api/v1/admin/knowledge/projects') {
        return Promise.resolve(json({ error: { message: 'Knowledge storage unavailable.' } }, 503));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }));

    renderWithProvider(<KnowledgeOverviewPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Knowledge storage unavailable.');
  });

  it('rejects negative worker counters from the API', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/admin/session') return Promise.resolve(json(session));
      if (String(input) === '/api/v1/admin/knowledge/projects') {
        return Promise.resolve(json({
          projects: [{
            ...projects.projects[0],
            worker: { ...projects.projects[0].worker, queued: -1 },
          }],
        }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }));

    renderWithProvider(<KnowledgeOverviewPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid response/i);
  });

  it('keeps searches inside the selected project and renders citations', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') return Promise.resolve(json(session));
      if (url === '/api/v1/admin/knowledge/projects') return Promise.resolve(json(projects));
      if (url === '/api/v1/admin/knowledge/projects/project-1/search?query=queue&mode=hybrid') {
        return Promise.resolve(json({
          projectId: 'project-1',
          query: 'queue',
          results: [{
            id: 'page-1',
            kind: 'page',
            title: 'Queue recovery',
            snippet: 'Retry cancelled ingestion jobs after fixing the source.',
            score: 7,
            citations: [{
              pageId: 'page-1',
              sourceId: 'source-1',
              path: 'docs/queue.md',
              url: null,
              span: { id: 'span-1', startOffset: 0, endOffset: 42, label: 'Recovery' },
            }],
          }],
        }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<KnowledgeSearchPage />);
    await user.type(await screen.findByLabelText('Search knowledge'), 'queue');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Queue recovery')).toBeVisible();
    expect(screen.getByText('docs/queue.md - Recovery')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/knowledge/projects/project-1/search?query=queue&mode=hybrid',
      expect.anything(),
    );
  });

  it('clears a previous project search when the project boundary changes', async () => {
    const secondProject = {
      ...projects.projects[0],
      id: 'project-2',
      name: 'Second project',
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') return Promise.resolve(json(session));
      if (url === '/api/v1/admin/knowledge/projects') return Promise.resolve(json({ projects: [projects.projects[0], secondProject] }));
      if (url === '/api/v1/admin/knowledge/projects/project-1/search?query=queue&mode=hybrid') {
        return Promise.resolve(json({
          projectId: 'project-1',
          query: 'queue',
          results: [{ id: 'page-1', kind: 'page', title: 'Queue recovery', snippet: 'Retry safely.', score: 7, citations: [] }],
        }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }));
    const user = userEvent.setup();

    renderWithProvider(<KnowledgeSearchPage />);
    await user.type(await screen.findByLabelText('Search knowledge'), 'queue');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Queue recovery')).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Knowledge project'), 'project-2');
    expect(screen.queryByText('Queue recovery')).not.toBeInTheDocument();
    expect(screen.getByText('Search a knowledge project')).toBeVisible();
  });

  it('shows an explicit empty result state and resolves reviews with an audit evidence payload', async () => {
    let resolved = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') return Promise.resolve(json(session));
      if (url === '/api/v1/admin/knowledge/projects') return Promise.resolve(json(projects));
      if (url === '/api/v1/admin/knowledge/projects/project-1/reviews?status=pending') {
        return Promise.resolve(json({
          reviews: resolved ? [] : [{
            id: 'review-1',
            projectId: 'project-1',
            pageVersionId: 'version-1',
            status: 'pending',
            requestedAt: '2026-09-24T12:00:00.000Z',
            reviewedAt: null,
            reviewerId: null,
            summary: 'Confirm queue recovery guidance',
          }],
        }));
      }
      if (url === '/api/v1/admin/knowledge/projects/project-1/reviews/review-1') {
        expect(init?.method).toBe('PATCH');
        expect(init?.body).toBe(JSON.stringify({ action: 'accept', evidence: { kind: 'dashboard', id: 'review-1' } }));
        resolved = true;
        return Promise.resolve(json({
          review: {
            id: 'review-1',
            projectId: 'project-1',
            pageVersionId: 'version-1',
            status: 'approved',
            requestedAt: '2026-09-24T12:00:00.000Z',
            reviewedAt: '2026-09-24T12:01:00.000Z',
            reviewerId: 'admin-id',
            summary: 'Confirm queue recovery guidance',
          },
        }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<KnowledgeReviewsPage />);
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('No pending reviews')).toBeVisible();
  });

  it('ignores a review mutation response after switching projects', async () => {
    let resolveMutation: ((response: Response) => void) | undefined;
    const secondProject = { ...projects.projects[0], id: 'project-2', name: 'Second project' };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') return Promise.resolve(json(session));
      if (url === '/api/v1/admin/knowledge/projects') {
        return Promise.resolve(json({ projects: [projects.projects[0], secondProject] }));
      }
      if (url === '/api/v1/admin/knowledge/projects/project-1/reviews?status=pending') {
        return Promise.resolve(json({ reviews: [{
          id: 'review-1',
          projectId: 'project-1',
          pageVersionId: 'version-1',
          status: 'pending',
          requestedAt: '2026-09-24T12:00:00.000Z',
          reviewedAt: null,
          reviewerId: null,
          summary: 'First project review',
        }] }));
      }
      if (url === '/api/v1/admin/knowledge/projects/project-2/reviews?status=pending') {
        return Promise.resolve(json({ reviews: [{
          id: 'review-2',
          projectId: 'project-2',
          pageVersionId: 'version-2',
          status: 'pending',
          requestedAt: '2026-09-24T12:00:00.000Z',
          reviewedAt: null,
          reviewerId: null,
          summary: 'Second project review',
        }] }));
      }
      if (url.endsWith('/reviews/review-1') && init?.method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          resolveMutation = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }));
    const user = userEvent.setup();

    renderWithProvider(<KnowledgeReviewsPage />);
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await user.selectOptions(screen.getByLabelText('Knowledge project'), 'project-2');
    expect(screen.queryByText('First project review')).not.toBeInTheDocument();
    expect(await screen.findByText('Second project review')).toBeVisible();

    resolveMutation?.(json({
      review: {
        id: 'review-1',
        projectId: 'project-1',
        pageVersionId: 'version-1',
        status: 'approved',
        requestedAt: '2026-09-24T12:00:00.000Z',
        reviewedAt: '2026-09-24T12:01:00.000Z',
        reviewerId: 'admin-id',
        summary: 'First project review',
      },
    }));

    await waitFor(() => expect(screen.getByText('Second project review')).toBeVisible());
  });
});
