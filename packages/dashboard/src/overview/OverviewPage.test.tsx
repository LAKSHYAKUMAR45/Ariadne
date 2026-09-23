import { type ReactNode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import type { OverviewResponse } from '../api/types';
import { OverviewPage } from './OverviewPage';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionBody(overrides: Partial<Record<'reauthenticatedUntil', string | null>> = {}) {
  return {
    userId: 'admin-id',
    username: 'admin',
    csrfToken: 'csrf-token',
    reauthenticatedUntil: overrides.reauthenticatedUntil ?? null,
  };
}

function buildOverview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  const now = Date.now();
  return {
    generatedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    database: { status: 'healthy', healthy: true, latencyMs: 4 },
    host: {
      cpuPercent: 62.5,
      memoryUsedBytes: 6 * 1024 * 1024 * 1024,
      memoryTotalBytes: 8 * 1024 * 1024 * 1024,
      filesystemUsedBytes: 220 * 1024 * 1024 * 1024,
      filesystemTotalBytes: 512 * 1024 * 1024 * 1024,
    },
    databaseSizeBytes: 536_870_912,
    tasks: { total: 34, active: 4, updatedLast24h: 7 },
    members: { total: 3, active: 2, inactive: 1, admins: 1, members: 2 },
    sync: {
      lastPushAt: new Date(now - 13 * 60 * 1000).toISOString(),
      lastPullAt: new Date(now - 11 * 60 * 1000).toISOString(),
    },
    backup: {
      latestAt: new Date(now - 15 * 60 * 1000).toISOString(),
      latestVerifiedAt: new Date(now - 10 * 60 * 1000).toISOString(),
      status: 'verified',
    },
    operations: { running: 1, failedLast24h: 0 },
    components: {
      database: { healthy: true },
      operator: { healthy: true },
    },
    ...overrides,
  };
}

function renderWithProvider(child: ReactNode) {
  return render(<AuthProvider>{child}</AuthProvider>);
}

function installFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(responder);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function formatAbsoluteTimestamp(value: string): string {
  return value.slice(0, 16).replace('T', ' ') + ' UTC';
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setVisibilityState('visible');
});

describe('OverviewPage', () => {
  it('renders healthy status panels in priority order with relative and absolute timestamps', async () => {
    installFetch((input) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/overview') {
        return Promise.resolve(json(buildOverview()));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    renderWithProvider(<OverviewPage />);

    expect(await screen.findByText('5m ago')).toBeVisible();
    expect(screen.getByText(formatAbsoluteTimestamp(buildOverview().generatedAt))).toBeVisible();
    expect(screen.getByText('4 ms')).toBeVisible();
    expect(screen.getByText('62.5%')).toBeVisible();
    expect(screen.getByText('6.0 GiB / 8.0 GiB')).toBeVisible();
    expect(screen.getByText('220.0 GiB / 512.0 GiB')).toBeVisible();
    expect(screen.getByText('34 total / 4 active')).toBeVisible();

    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Failures', 'Services', 'Backup', 'Operations', 'Counts']);
  });

  it('surfaces stale backups and failed operations before lower-priority counts', async () => {
    const staleVerifiedAt = new Date(Date.now() - 32 * 60 * 60 * 1000).toISOString();
    const staleLatestAt = new Date(Date.now() - 32 * 60 * 60 * 1000).toISOString();
    installFetch((input) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/overview') {
        return Promise.resolve(
          json(
            buildOverview({
              backup: {
                latestAt: staleLatestAt,
                latestVerifiedAt: staleVerifiedAt,
                status: 'verified',
              },
              operations: {
                running: 0,
                failedLast24h: 3,
              },
            }),
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    renderWithProvider(<OverviewPage />);

    expect(await screen.findByText('3 recent failures need review.')).toBeVisible();
    expect(screen.getAllByText('stale').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Verified backup is 1d old.').length).toBeGreaterThan(0);
  });

  it('shows an operator partial failure without discarding the rest of the overview', async () => {
    installFetch((input) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/overview') {
        return Promise.resolve(
          json(
            buildOverview({
              host: null,
              components: {
                database: { healthy: true },
                operator: { healthy: false, code: 'operator_unavailable' },
              },
            }),
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    renderWithProvider(<OverviewPage />);

    expect((await screen.findAllByText('operator_unavailable')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Host metrics unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText('3 total / 2 active')).toBeVisible();
  });

  it('shows the loading state before the first overview response arrives', async () => {
    installFetch((input) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/overview') {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    renderWithProvider(<OverviewPage />);

    expect(await screen.findByRole('status')).toHaveTextContent('Loading live overview');
  });

  it('surfaces a database hard failure from the overview API', async () => {
    installFetch((input) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/overview') {
        return Promise.resolve(
          json(
            { error: { code: 'database_unavailable', message: 'The database is currently unavailable.' } },
            503,
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    renderWithProvider(<OverviewPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The database is currently unavailable.');
  });

  it('aborts the prior request when refreshed manually', async () => {
    const signals: AbortSignal[] = [];

    installFetch((input, init) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/overview') {
        signals.push(init?.signal as AbortSignal);
        if (signals.length === 1) {
          return new Promise<Response>(() => undefined);
        }
        return Promise.resolve(
          json(
            buildOverview({
              generatedAt: new Date().toISOString(),
            }),
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const user = userEvent.setup();

    renderWithProvider(<OverviewPage />);

    await user.click(await screen.findByRole('button', { name: 'Refresh status' }));

    expect(signals[0]?.aborted).toBe(true);
    expect(await screen.findByText('0m ago')).toBeVisible();
  });

  it('pauses polling while the tab is hidden and resumes once visible again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T08:10:00.000Z'));

    const fetchMock = installFetch((input) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/overview') {
        return Promise.resolve(json(buildOverview()));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    await act(async () => {
      renderWithProvider(<OverviewPage />);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText('5m ago')).toBeVisible();
    const initialCalls = fetchMock.mock.calls.length;

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetchMock).toHaveBeenCalledTimes(initialCalls);

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(initialCalls + 1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(initialCalls + 2);
  });
});
