import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { BackupsPage } from './BackupsPage';
import { LogsPage } from './LogsPage';
import { OverviewPage } from './OverviewPage';
import { ServicesPage } from './ServicesPage';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function eventStream(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    },
  );
}

function sessionBody(overrides: Partial<{ reauthenticatedUntil: string | null }> = {}) {
  return {
    userId: 'admin-id',
    username: 'admin',
    csrfToken: 'csrf-token',
    reauthenticatedUntil: null,
    ...overrides,
  };
}

function futureReauthenticatedUntil(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function renderWithProvider(child: ReactNode) {
  return render(<AuthProvider>{child}</AuthProvider>);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('operations pages', () => {
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

    expect(await screen.findByText('No active failures')).toBeVisible();
    expect(screen.getByText('Recovery point is fresh and verified.')).toBeVisible();
  });

  it('explains backup eligibility, downloads verified backups, and restores with exact confirmation after reauthentication', async () => {
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
                filename: 'ariadne-20260923T032200Z.dump',
                sha256: 'a'.repeat(64),
                sizeBytes: 4096,
                status: 'verified',
                createdAt: '2026-09-23T03:22:00.000Z',
                verifiedAt: '2026-09-23T03:23:00.000Z',
                restoreVerificationMessage: 'verified: schema 0008, 12 tables',
              },
              {
                filename: 'ariadne-20260923T052200Z.dump',
                sha256: 'b'.repeat(64),
                sizeBytes: 2048,
                status: 'created',
                createdAt: '2026-09-23T05:22:00.000Z',
                verifiedAt: null,
                restoreVerificationMessage: null,
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/backups/ariadne-20260923T032200Z.dump/download') {
        return Promise.resolve(new Response('backup-bytes', { status: 200 }));
      }
      if (url === '/api/v1/admin/operations/backups/ariadne-20260923T032200Z.dump/restore') {
        return Promise.resolve(
          json(
            {
              accepted: true,
              operation: {
                id: 'op-restore',
                requestedBy: 'admin-id',
                type: 'backup_restore',
                state: 'queued',
                summary: 'Restore backup ariadne-20260923T032200Z.dump',
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
      if (url === '/api/v1/admin/session/reauthenticate') {
        return Promise.resolve(json({ reauthenticatedUntil: '2026-09-23T08:10:00.000Z' }));
      }
      if (url === '/api/v1/admin/operations/op-restore/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":1,"operationId":"op-restore","state":"running","message":"Creating fresh safety backup","metadata":{},"createdAt":"2026-09-23T08:01:01.000Z"}\n\n',
            'event: operation_event\ndata: {"id":2,"operationId":"op-restore","state":"running","message":"Applying migrations","metadata":{},"createdAt":"2026-09-23T08:01:02.000Z"}\n\n',
            'event: operation_event\ndata: {"id":3,"operationId":"op-restore","state":"running","message":"Restarting dependent services","metadata":{},"createdAt":"2026-09-23T08:01:03.000Z"}\n\n',
            'event: operation_event\ndata: {"id":4,"operationId":"op-restore","state":"running","message":"Health checks passed","metadata":{},"createdAt":"2026-09-23T08:01:04.000Z"}\n\n',
            'event: complete\ndata: {"operationId":"op-restore","state":"succeeded"}\n\n',
          ]),
        );
      }
      if (url === '/api/v1/admin/operations/op-restore') {
        return Promise.resolve(
          json({
            operation: {
              id: 'op-restore',
              requestedBy: 'admin-id',
              type: 'backup_restore',
              state: 'succeeded',
              summary: 'Restore backup ariadne-20260923T032200Z.dump',
              output: 'Restore completed successfully.',
              startedAt: '2026-09-23T08:01:01.000Z',
              completedAt: '2026-09-23T08:01:05.000Z',
              createdAt: '2026-09-23T08:01:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:backup');
    const revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL,
    });
    const user = userEvent.setup();

    renderWithProvider(<BackupsPage />);

    expect(await screen.findByText('ariadne-20260923T032200Z.dump')).toBeVisible();
    expect(screen.getByText('verified: schema 0008, 12 tables')).toBeVisible();
    expect(screen.getByText('Verification required before restore or download.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Download ariadne-20260923T032200Z.dump' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:backup');

    await user.click(screen.getByRole('button', { name: 'Restore ariadne-20260923T032200Z.dump' }));
    expect(await screen.findByRole('dialog', { name: 'Restore verified backup' })).toBeVisible();
    const continueButton = screen.getByRole('button', { name: 'Continue operation' });
    expect(continueButton).toBeDisabled();

    await user.type(
      screen.getByLabelText('Type RESTORE ariadne-20260923T032200Z.dump to continue'),
      'RESTORE ariadne-20260923T032200Z.dump',
    );
    await user.type(screen.getByLabelText('Administrator password'), 'correct horse battery staple');
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);

    expect(await screen.findByText('Creating fresh safety backup')).toBeVisible();
    expect(await screen.findByText('Applying migrations')).toBeVisible();
    expect(await screen.findByText('Restarting dependent services')).toBeVisible();
    expect(await screen.findByText('Health checks passed')).toBeVisible();
    expect(await screen.findByText('Restore completed successfully.')).toBeVisible();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/session/reauthenticate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse battery staple' }),
      }),
    );
  });

  it('shows the operator as read-only, reconnects active service restarts, and surfaces operator unavailability', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(
          json(sessionBody({ reauthenticatedUntil: futureReauthenticatedUntil() })),
        );
      }
      if (url === '/api/v1/admin/services') {
        return Promise.resolve(
          json({
            services: [
              { name: 'sync-server', state: 'running', detail: 'Serving requests' },
              { name: 'operator', state: 'running', detail: 'Socket ready' },
              { name: 'postgres', state: 'running', detail: 'Primary database available' },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/operations?limit=20') {
        return Promise.resolve(
          json({
            operations: [
              {
                id: 'op-restart',
                requestedBy: 'admin-id',
                type: 'service_restart',
                state: 'running',
                summary: 'Restart postgres service',
                output: null,
                startedAt: '2026-09-23T08:01:00.000Z',
                completedAt: null,
                createdAt: '2026-09-23T08:00:59.000Z',
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/operations/op-restart/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":1,"operationId":"op-restart","state":"running","message":"Waiting for PostgreSQL readiness","metadata":{},"createdAt":"2026-09-23T08:01:01.000Z"}\n\n',
          ]),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderWithProvider(<ServicesPage />);

    expect(await screen.findByText('Socket ready')).toBeVisible();
    expect(await screen.findByText('Waiting for PostgreSQL readiness')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Restart operator' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart sync-server' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restart postgres' })).toBeDisabled();

    unmount();

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/admin/session') {
          return Promise.resolve(json(sessionBody()));
        }
        if (url === '/api/v1/admin/services') {
          return Promise.resolve(
            json({ error: { code: 'operator_unavailable', message: 'The operator service is not configured' } }, 503),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );

    renderWithProvider(<ServicesPage />);

    expect(
      (await screen.findAllByRole('alert')).some((alert) =>
        alert.textContent?.includes('The operator service is not configured'),
      ),
    ).toBe(true);
  });

  it('refreshes service status when a reconnected restart reaches a terminal state', async () => {
    let serviceReads = 0;
    let operationCompleted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(
          json(sessionBody({ reauthenticatedUntil: futureReauthenticatedUntil() })),
        );
      }
      if (url === '/api/v1/admin/services') {
        serviceReads += 1;
        return Promise.resolve(
          json({
            services: [
              {
                name: 'sync-server',
                state: 'running',
                detail:
                  operationCompleted
                    ? 'HTTP listener healthy after restart.'
                    : 'HTTP listener healthy.',
              },
              { name: 'operator', state: 'running', detail: 'Socket ready' },
              { name: 'postgres', state: 'running', detail: 'Primary database available' },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/operations?limit=20') {
        return Promise.resolve(
          json({
            operations:
              !operationCompleted
                ? [
                    {
                      id: 'op-restart',
                      requestedBy: 'admin-id',
                      type: 'service_restart',
                      state: 'running',
                      summary: 'Restart sync-server',
                      output: null,
                      startedAt: '2026-09-23T08:01:00.000Z',
                      completedAt: null,
                      createdAt: '2026-09-23T08:00:59.000Z',
                    },
                  ]
                : [],
          }),
        );
      }
      if (url === '/api/v1/admin/operations/op-restart/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":1,"operationId":"op-restart","state":"succeeded","message":"sync-server restart completed.","metadata":{},"createdAt":"2026-09-23T08:01:02.000Z"}\n\n',
            'event: complete\ndata: {"operationId":"op-restart","state":"succeeded"}\n\n',
          ]),
        );
      }
      if (url === '/api/v1/admin/operations/op-restart') {
        operationCompleted = true;
        return Promise.resolve(
          json({
            operation: {
              id: 'op-restart',
              requestedBy: 'admin-id',
              type: 'service_restart',
              state: 'succeeded',
              summary: 'Restart sync-server',
              output: 'sync-server restarted and healthy.',
              startedAt: '2026-09-23T08:01:00.000Z',
              completedAt: '2026-09-23T08:01:02.000Z',
              createdAt: '2026-09-23T08:00:59.000Z',
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProvider(<ServicesPage />);

    expect(await screen.findByText('HTTP listener healthy after restart.')).toBeVisible();
    expect(serviceReads).toBeGreaterThan(1);
  });

  it('restarts postgres with exact confirmation and shows terminal failure details', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/services') {
        return Promise.resolve(
          json({
            services: [
              { name: 'sync-server', state: 'running', detail: 'Serving requests' },
              { name: 'operator', state: 'running', detail: 'Socket ready' },
              { name: 'postgres', state: 'running', detail: 'Primary database available' },
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
                id: 'op-postgres',
                requestedBy: 'admin-id',
                type: 'service_restart',
                state: 'queued',
                summary: 'Restart postgres service',
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
      if (url === '/api/v1/admin/session/reauthenticate') {
        return Promise.resolve(json({ reauthenticatedUntil: '2026-09-23T08:10:00.000Z' }));
      }
      if (url === '/api/v1/admin/operations/op-postgres/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":1,"operationId":"op-postgres","state":"running","message":"Restarting PostgreSQL","metadata":{},"createdAt":"2026-09-23T08:01:01.000Z"}\n\n',
            'event: complete\ndata: {"operationId":"op-postgres","state":"failed"}\n\n',
          ]),
        );
      }
      if (url === '/api/v1/admin/operations/op-postgres') {
        return Promise.resolve(
          json({
            operation: {
              id: 'op-postgres',
              requestedBy: 'admin-id',
              type: 'service_restart',
              state: 'failed',
              summary: 'Restart postgres service',
              output: 'postgres remained unhealthy after restart',
              startedAt: '2026-09-23T08:01:01.000Z',
              completedAt: '2026-09-23T08:02:00.000Z',
              createdAt: '2026-09-23T08:01:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<ServicesPage />);

    await user.click(await screen.findByRole('button', { name: 'Restart postgres' }));
    expect(await screen.findByRole('dialog', { name: 'Restart service' })).toBeVisible();
    await user.type(screen.getByLabelText('Type RESTART postgres to continue'), 'RESTART postgres');
    await user.type(screen.getByLabelText('Administrator password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    expect(await screen.findByText('Restarting PostgreSQL')).toBeVisible();
    expect(await screen.findByText('postgres remained unhealthy after restart')).toBeVisible();
  });

  it('forces reauthentication after a stale restore submission while preserving exact confirmation text', async () => {
    let restoreAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(
          json(sessionBody({ reauthenticatedUntil: futureReauthenticatedUntil() })),
        );
      }
      if (url === '/api/v1/admin/backups') {
        return Promise.resolve(
          json({
            backups: [
              {
                filename: 'ariadne-20260923T032200Z.dump',
                sha256: 'a'.repeat(64),
                sizeBytes: 4096,
                status: 'verified',
                createdAt: '2026-09-23T03:22:00.000Z',
                verifiedAt: '2026-09-23T03:23:00.000Z',
                restoreVerificationMessage: 'verified: schema 0008, 12 tables',
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/operations?limit=20') {
        return Promise.resolve(json({ operations: [] }));
      }
      if (url === '/api/v1/admin/operations/backups/ariadne-20260923T032200Z.dump/restore') {
        restoreAttempts += 1;
        if (restoreAttempts === 1) {
          return Promise.resolve(
            json({ error: { code: 'reauthentication_required', message: 'Password required' } }, 403),
          );
        }
        return Promise.resolve(
          json(
            {
              accepted: true,
              operation: {
                id: 'op-restore-reauth',
                requestedBy: 'admin-id',
                type: 'backup_restore',
                state: 'queued',
                summary: 'Restore backup ariadne-20260923T032200Z.dump',
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
      if (url === '/api/v1/admin/session/reauthenticate') {
        return Promise.resolve(json({ reauthenticatedUntil: futureReauthenticatedUntil() }));
      }
      if (url === '/api/v1/admin/operations/op-restore-reauth/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":1,"operationId":"op-restore-reauth","state":"running","message":"Creating fresh safety backup","metadata":{},"createdAt":"2026-09-23T08:01:01.000Z"}\n\n',
            'event: complete\ndata: {"operationId":"op-restore-reauth","state":"succeeded"}\n\n',
          ]),
        );
      }
      if (url === '/api/v1/admin/operations/op-restore-reauth') {
        return Promise.resolve(
          json({
            operation: {
              id: 'op-restore-reauth',
              requestedBy: 'admin-id',
              type: 'backup_restore',
              state: 'succeeded',
              summary: 'Restore backup ariadne-20260923T032200Z.dump',
              output: 'Restore completed successfully.',
              startedAt: '2026-09-23T08:01:01.000Z',
              completedAt: '2026-09-23T08:01:05.000Z',
              createdAt: '2026-09-23T08:01:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<BackupsPage />);

    await user.click(await screen.findByRole('button', { name: 'Restore ariadne-20260923T032200Z.dump' }));
    expect(await screen.findByRole('dialog', { name: 'Restore verified backup' })).toBeVisible();
    expect(screen.queryByLabelText('Administrator password')).not.toBeInTheDocument();

    await user.type(
      screen.getByLabelText('Type RESTORE ariadne-20260923T032200Z.dump to continue'),
      'RESTORE ariadne-20260923T032200Z.dump',
    );
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    expect(await screen.findByLabelText('Administrator password')).toBeVisible();
    expect(
      await screen.findByDisplayValue('RESTORE ariadne-20260923T032200Z.dump'),
    ).toBeVisible();

    await user.type(screen.getByLabelText('Administrator password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    expect(await screen.findByText('Restore completed successfully.')).toBeVisible();
  });

  it('forces reauthentication after a stale restart submission and shows operator conflict reasons', async () => {
    let restartAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(
          json(sessionBody({ reauthenticatedUntil: futureReauthenticatedUntil() })),
        );
      }
      if (url === '/api/v1/admin/services') {
        return Promise.resolve(
          json({
            services: [
              { name: 'sync-server', state: 'running', detail: 'Serving requests' },
              { name: 'operator', state: 'running', detail: 'Socket ready' },
              { name: 'postgres', state: 'running', detail: 'Primary database available' },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/operations?limit=20') {
        return Promise.resolve(json({ operations: [] }));
      }
      if (url === '/api/v1/admin/operations/service-restart') {
        restartAttempts += 1;
        if (restartAttempts === 1) {
          return Promise.resolve(
            json({ error: { code: 'reauthentication_required', message: 'Password required' } }, 403),
          );
        }
        return Promise.resolve(
          json(
            {
              error: {
                code: 'operator_busy',
                message: 'Another operator operation is already running: Create database backup',
              },
            },
            409,
          ),
        );
      }
      if (url === '/api/v1/admin/session/reauthenticate') {
        return Promise.resolve(json({ reauthenticatedUntil: futureReauthenticatedUntil() }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<ServicesPage />);

    await user.click(await screen.findByRole('button', { name: 'Restart postgres' }));
    expect(await screen.findByRole('dialog', { name: 'Restart service' })).toBeVisible();
    expect(screen.queryByLabelText('Administrator password')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Type RESTART postgres to continue'), 'RESTART postgres');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    expect(await screen.findByLabelText('Administrator password')).toBeVisible();
    expect(await screen.findByDisplayValue('RESTART postgres')).toBeVisible();

    await user.type(screen.getByLabelText('Administrator password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Another operator operation is already running: Create database backup',
    );
  });

  it('disables both restart controls when any unrelated admin operation is already active', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(
          json(sessionBody({ reauthenticatedUntil: futureReauthenticatedUntil() })),
        );
      }
      if (url === '/api/v1/admin/services') {
        return Promise.resolve(
          json({
            services: [
              { name: 'sync-server', state: 'running', detail: 'Serving requests' },
              { name: 'operator', state: 'running', detail: 'Socket ready' },
              { name: 'postgres', state: 'running', detail: 'Primary database available' },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/operations?limit=20') {
        return Promise.resolve(
          json({
            operations: [
              {
                id: 'op-backup',
                requestedBy: 'admin-id',
                type: 'backup_create',
                state: 'running',
                summary: 'Create database backup',
                output: null,
                startedAt: '2026-09-23T08:01:00.000Z',
                completedAt: null,
                createdAt: '2026-09-23T08:00:59.000Z',
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/operations/op-backup/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":11,"operationId":"op-backup","state":"running","message":"Streaming WAL archive","metadata":{},"createdAt":"2026-09-23T08:01:01.000Z"}\n\n',
          ]),
        );
      }
      if (url === '/api/v1/admin/operations/op-backup') {
        return Promise.resolve(
          json({
            operation: {
              id: 'op-backup',
              requestedBy: 'admin-id',
              type: 'backup_create',
              state: 'running',
              summary: 'Create database backup',
              output: null,
              startedAt: '2026-09-23T08:01:00.000Z',
              completedAt: null,
              createdAt: '2026-09-23T08:00:59.000Z',
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProvider(<ServicesPage />);

    expect(await screen.findByText('Streaming WAL archive')).toBeVisible();
    expect(
      await screen.findByText('Create database backup is still running. Restart controls stay locked until it completes.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restart sync-server' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restart postgres' })).toBeDisabled();
  });

  it('requests fixed-source logs with server-side filters, paginates with opaque cursors, and pauses live refresh', async () => {
    vi.setSystemTime(new Date('2026-09-23T09:30:00.000Z'));

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://example.test');
      if (url.pathname === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url.pathname === '/api/v1/admin/logs') {
        const source = url.searchParams.get('source');
        const severity = url.searchParams.get('severity');
        const since = url.searchParams.get('since');
        const cursor = url.searchParams.get('cursor');
        if (
          source === 'deployment' &&
          severity === 'warning' &&
          since === '2026-09-22T09:30:00.000Z' &&
          cursor === null
        ) {
          return Promise.resolve(
            json({
              entries: [
                {
                  sequence: 10,
                  timestamp: '2026-09-23T09:05:00.000Z',
                  severity: 'warning',
                  message: 'Cutover complete; TOKEN=***',
                  redacted: true,
                },
                {
                  sequence: 11,
                  timestamp: '2026-09-23T09:06:00.000Z',
                  severity: 'warning',
                  message: 'Health check recovered',
                  redacted: false,
                },
              ],
              nextCursor: 'opaque-cursor',
            }),
          );
        }
        if (
          source === 'deployment' &&
          severity === 'warning' &&
          since === '2026-09-22T09:30:00.000Z' &&
          cursor === 'opaque-cursor'
        ) {
          return Promise.resolve(
            json({
              entries: [
                {
                  sequence: 12,
                  timestamp: '2026-09-23T09:04:00.000Z',
                  severity: 'warning',
                  message: 'Migration finished',
                  redacted: false,
                },
              ],
              nextCursor: null,
            }),
          );
        }
        return Promise.resolve(json({ entries: [], nextCursor: null }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<LogsPage />);

    await user.selectOptions(await screen.findByLabelText('Source'), 'deployment');
    await user.selectOptions(screen.getByLabelText('Severity'), 'warning');
    await user.selectOptions(screen.getByLabelText('Time window'), '24h');

    expect(await screen.findByText('Cutover complete; TOKEN=***')).toBeVisible();
    expect(screen.getByText('Redacted')).toBeVisible();
    expect(screen.queryByText('\u001b[31mfailed\u001b[0m')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Filter loaded lines'), 'cutover');
    expect(screen.getByText('Cutover complete; TOKEN=***')).toBeVisible();
    expect(screen.queryByText('Health check recovered')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Filter loaded lines'));
    await user.click(screen.getByRole('button', { name: 'Load older lines' }));
    expect(await screen.findByText('Migration finished')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Pause live refresh' }));
    expect(screen.getByRole('button', { name: 'Resume live refresh' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Resume live refresh' }));
    expect(screen.getByRole('button', { name: 'Pause live refresh' })).toBeVisible();
    expect(within(screen.getByRole('group', { name: 'Log filters' })).getAllByRole('option')).toHaveLength(11);
  });
});
