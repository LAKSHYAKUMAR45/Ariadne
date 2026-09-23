import { type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { BackupsPage } from './BackupsPage';
import { LogsPage } from './LogsPage';
import { OverviewPage } from './OverviewPage';
import { ServicesPage } from './ServicesPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionBody() {
  return {
    userId: 'admin-id',
    username: 'admin',
    csrfToken: 'csrf-token',
    reauthenticatedUntil: null,
  };
}

function acceptedOperation(id: string, summary: string) {
  return {
    accepted: true as const,
    operation: {
      id,
      requestedBy: 'admin-id',
      type: 'backup_create' as const,
      state: 'queued' as const,
      summary,
      output: null,
      startedAt: null,
      completedAt: null,
      createdAt: '2026-09-23T08:01:00.000Z',
    },
  };
}

function renderWithProvider(child: ReactNode) {
  return render(<AuthProvider>{child}</AuthProvider>);
}

function emptyEventStream(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    },
  );
}

it('prioritizes live health, tasks, and backup freshness on the overview', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/overview') {
        return Promise.resolve(
          json({
          generatedAt: '2026-09-23T08:00:00.000Z',
          database: { status: 'healthy', healthy: true, latencyMs: 8 },
          host: null,
          databaseSizeBytes: 512,
          tasks: { total: 34, active: 4, updatedLast24h: 7 },
          members: { total: 1, active: 1, inactive: 0, admins: 1, members: 0 },
          sync: { lastPushAt: null, lastPullAt: null },
          backup: {
            latestAt: '2026-09-23T06:00:00.000Z',
            latestVerifiedAt: '2026-09-23T06:05:00.000Z',
            status: 'verified',
          },
          operations: { running: 1, failedLast24h: 0 },
          components: { database: { healthy: true }, operator: { healthy: true } },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );

  renderWithProvider(<OverviewPage />);

  expect((await screen.findAllByText('Operational')).length).toBeGreaterThan(0);
  expect(screen.getByText('34')).toBeVisible();
  expect(screen.getAllByText('1 running').length).toBeGreaterThan(0);
  expect(screen.getByText('Verified')).toBeVisible();
});

it('lists backups and starts a new backup with the CSRF token', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/v1/admin/session') {
      return Promise.resolve(json(sessionBody()));
    }
    if (url === '/api/v1/admin/backups') {
      return Promise.resolve(
        json({
        backups: [
          {
            filename: 'ariadne-20260923.dump',
            sha256: 'a'.repeat(64),
            sizeBytes: 4096,
            status: 'verified',
            createdAt: '2026-09-23T06:00:00.000Z',
            verifiedAt: '2026-09-23T06:05:00.000Z',
            restoreVerificationMessage: null,
          },
        ],
        }),
      );
    }
    if (url === '/api/v1/admin/operations/backups') {
      return Promise.resolve(json(acceptedOperation('op-1', 'Create database backup'), 202));
    }
    if (url === '/api/v1/admin/operations/op-1/events') {
      return Promise.resolve(emptyEventStream());
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  renderWithProvider(<BackupsPage />);

  expect(await screen.findByText('ariadne-20260923.dump')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Create backup' }));
  expect(await screen.findByText('Backup queued')).toBeVisible();
  expect(fetchMock.mock.calls).toContainEqual([
    '/api/v1/admin/operations/backups',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
    }),
  ]);
});

it('reauthenticates in place when a backup action requires a fresh password', async () => {
  let operationAttempts = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/v1/admin/session') {
      return Promise.resolve(json(sessionBody()));
    }
    if (url === '/api/v1/admin/backups') {
      return Promise.resolve(json({ backups: [] }));
    }
    if (url === '/api/v1/admin/operations/backups') {
      operationAttempts += 1;
      return Promise.resolve(
        operationAttempts === 1
          ? json({ error: { code: 'reauthentication_required', message: 'Password required' } }, 403)
          : json(acceptedOperation('op-1', 'Create database backup'), 202),
      );
    }
    if (url === '/api/v1/admin/session/reauthenticate') {
      return Promise.resolve(json({ reauthenticatedUntil: '2026-09-23T08:05:00.000Z' }));
    }
    if (url === '/api/v1/admin/operations/op-1/events') {
      return Promise.resolve(emptyEventStream());
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  renderWithProvider(<BackupsPage />);

  await user.click(await screen.findByRole('button', { name: 'Create backup' }));
  expect(await screen.findByRole('dialog', { name: 'Confirm administrator' })).toBeVisible();

  await user.type(screen.getByLabelText('Administrator password'), 'correct horse battery staple');
  await user.click(screen.getByRole('button', { name: 'Continue operation' }));

  expect(await screen.findByText('Backup queued')).toBeVisible();
  expect(fetchMock.mock.calls).toContainEqual([
    '/api/v1/admin/session/reauthenticate',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    }),
  ]);
});

it('restarts only the sync server from the MVP service controls', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/v1/admin/session') {
      return Promise.resolve(json(sessionBody()));
    }
    if (url === '/api/v1/admin/services') {
      return Promise.resolve(
        json({
        services: [
          { name: 'sync-server', state: 'running', detail: 'Serving API requests' },
          { name: 'database', state: 'running', detail: 'PostgreSQL connection healthy' },
          { name: 'operator', state: 'available', detail: 'Privileged operations enabled' },
        ],
        }),
      );
    }
    if (url === '/api/v1/admin/operations/service-restart') {
      return Promise.resolve(
        json(
        {
          accepted: true,
          operation: {
            id: 'op-2',
            requestedBy: 'admin-id',
            type: 'service_restart',
            state: 'queued',
            summary: 'Restart sync-server service',
            output: null,
            startedAt: null,
            completedAt: null,
            createdAt: '2026-09-23T08:01:00.000Z',
          },
        },
        202,
        ),
      );
    }
    if (url === '/api/v1/admin/operations/op-2/events') {
      return Promise.resolve(emptyEventStream());
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  renderWithProvider(<ServicesPage />);

  expect(await screen.findByText('Serving API requests')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Restart sync server' }));
  expect(await screen.findByText('Restart queued')).toBeVisible();
});

it('shows bounded redacted operation logs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/logs?source=sync-server&limit=100') {
        return Promise.resolve(
          json({
          entries: [
            {
              sequence: 1,
              timestamp: '2026-09-23T06:05:00.000Z',
              severity: 'info',
              message: 'Backup completed; TOKEN=***',
              redacted: true,
            },
          ],
          nextCursor: null,
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );

  renderWithProvider(<LogsPage />);

  expect(await screen.findByText('Backup completed; TOKEN=***')).toBeVisible();
  expect(screen.getByText('operations')).toBeVisible();
});
