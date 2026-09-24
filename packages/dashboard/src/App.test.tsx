import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AdminApiClient } from './api/types';
import { OperationProgress } from './components/OperationProgress';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionBody(role: 'admin' | 'member' = 'admin', reauthenticatedUntil: string | null = null) {
  return {
    userId: 'admin-id',
    username: 'admin',
    role,
    reauthenticatedUntil,
    csrfToken: 'csrf-token',
  };
}

function overviewBody() {
  return {
    generatedAt: '2026-09-23T08:00:00.000Z',
    database: { status: 'healthy', healthy: true, latencyMs: 4 },
    host: null,
    databaseSizeBytes: 512,
    tasks: { total: 0, active: 0, updatedLast24h: 0 },
    members: { total: 2, active: 1, inactive: 1, admins: 1, members: 1 },
    sync: { lastPushAt: null, lastPullAt: null },
    backup: { latestAt: null, latestVerifiedAt: null, status: 'unavailable' },
    operations: { running: 0, failedLast24h: 0 },
    components: { database: { healthy: true }, operator: { healthy: true } },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ariadne operations console', () => {
  it('shows only the admin login when no session exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { code: 'missing_session', message: 'Authentication required' } }, 401)),
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Command your Ariadne cloud' })).toBeVisible();
    expect(screen.getByLabelText('Username')).toBeVisible();
    expect(screen.getByLabelText('Password')).toBeVisible();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('renders the operational shell and switches sections for an active session', async () => {
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
              database: { status: 'healthy', healthy: true, latencyMs: 4 },
              host: null,
              databaseSizeBytes: 512,
              tasks: { total: 0, active: 0, updatedLast24h: 0 },
              members: { total: 2, active: 1, inactive: 1, admins: 1, members: 1 },
              sync: { lastPushAt: null, lastPullAt: null },
              backup: { latestAt: null, latestVerifiedAt: null, status: 'unavailable' },
              operations: { running: 0, failedLast24h: 0 },
              components: { database: { healthy: true }, operator: { healthy: true } },
            }),
          );
        }
        if (url === '/api/v1/admin/members') {
          return Promise.resolve(
            json({
              members: [
                {
                  userId: 'admin-id',
                  username: 'admin',
                  role: 'admin',
                  active: true,
                  createdAt: '2026-09-22T08:00:00.000Z',
                  immutable: true,
                },
                {
                  userId: 'member-1',
                  username: 'ops-member',
                  role: 'member',
                  active: false,
                  createdAt: '2026-09-22T09:00:00.000Z',
                  immutable: false,
                },
              ],
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText('nodem2 / production')).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'System overview' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Members' })).toHaveAttribute('id', 'nav-members');
    expect(screen.getByRole('button', { name: 'Deployments' })).toHaveAttribute('id', 'nav-deployments');
    expect(screen.getByRole('button', { name: 'Audit' })).toHaveAttribute('id', 'nav-audit');

    await user.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(screen.getByRole('heading', { name: 'Task history' })).toBeVisible();
    expect(screen.getByText('Select a task to inspect its timeline and captured files.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Members' }));
    expect(screen.getByRole('heading', { name: 'Members' })).toBeVisible();
    expect(await screen.findByText('ops-member')).toBeVisible();
    expect(screen.getByText('Activate ops-member')).toBeVisible();
  });

  it('hides non-Tasks navigation entries for a member-role session and keeps the back-link visible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/admin/session') {
          return Promise.resolve(json(sessionBody('member')));
        }
        if (url === '/api/v1/admin/overview') {
          return Promise.resolve(json(overviewBody()));
        }
        if (url === '/api/v1/admin/tasks?limit=100') {
          return Promise.resolve(json({ tasks: [], hasMore: false, nextOffset: null }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText('nodem2 / production')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Members' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Backups' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Services' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deployments' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Logs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Audit' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to jcnr-triage' }),
    ).toHaveAttribute('href', 'https://nodem2:8090/');

    await user.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(screen.getByRole('heading', { name: 'Task history' })).toBeVisible();
  });

  it('shows every navigation entry for an admin-role session including the back-link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/admin/session') {
          return Promise.resolve(json(sessionBody('admin')));
        }
        if (url === '/api/v1/admin/overview') {
          return Promise.resolve(json(overviewBody()));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );

    render(<App />);

    expect(await screen.findByText('nodem2 / production')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Overview' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Members' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Backups' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Services' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Deployments' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Logs' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Audit' })).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Back to jcnr-triage' }),
    ).toHaveAttribute('href', 'https://nodem2:8090/');
  });

  it('logs out from the console and returns to the login screen', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          ...sessionBody(),
        }),
      )
      .mockResolvedValueOnce(
        json({
          generatedAt: '2026-09-23T08:00:00.000Z',
          database: { status: 'healthy', healthy: true, latencyMs: 4 },
          host: null,
          databaseSizeBytes: 512,
          tasks: { total: 0, active: 0, updatedLast24h: 0 },
          members: { total: 1, active: 1, inactive: 0, admins: 1, members: 0 },
          sync: { lastPushAt: null, lastPullAt: null },
          backup: { latestAt: null, latestVerifiedAt: null, status: 'unavailable' },
          operations: { running: 0, failedLast24h: 0 },
          components: { database: { healthy: true }, operator: { healthy: true } },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Command your Ariadne cloud' })).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/admin/session',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
  });

  it('prompts for reauthentication when protected reads report an expired window', async () => {
    let operationsRequestCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(
        json(sessionBody('admin', '2026-09-23T08:05:00.000Z')),
        );
      }
      if (url === '/api/v1/admin/overview') {
        return Promise.resolve(
          json({
            generatedAt: '2026-09-23T08:00:00.000Z',
            database: { status: 'healthy', healthy: true, latencyMs: 4 },
            host: null,
            databaseSizeBytes: 512,
            tasks: { total: 0, active: 0, updatedLast24h: 0 },
            members: { total: 1, active: 1, inactive: 0, admins: 1, members: 0 },
            sync: { lastPushAt: null, lastPullAt: null },
            backup: { latestAt: null, latestVerifiedAt: null, status: 'unavailable' },
            operations: { running: 0, failedLast24h: 0 },
            components: { database: { healthy: true }, operator: { healthy: true } },
          }),
        );
      }
      if (url === '/api/v1/admin/backups') {
        return Promise.resolve(json({ backups: [] }));
      }
      if (url === '/api/v1/admin/operations?limit=20') {
        operationsRequestCount += 1;
        if (operationsRequestCount === 1) {
          return Promise.resolve(
            json(
              {
                error: {
                  code: 'reauthentication_required',
                  message: 'This action requires a freshly reauthenticated dashboard session',
                },
              },
              403,
            ),
          );
        }
        return Promise.resolve(json({ operations: [] }));
      }
      if (url === '/api/v1/admin/session/reauthenticate') {
        return Promise.resolve(json({ reauthenticatedUntil: '2026-09-23T08:10:00.000Z' }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Backups' }));

    expect(await screen.findByRole('dialog', { name: 'Confirm administrator' })).toBeVisible();
    await user.type(screen.getByLabelText('Administrator password'), 'password-123');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Confirm administrator' })).not.toBeInTheDocument(),
    );
    expect(operationsRequestCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/session/reauthenticate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ password: 'password-123' }),
      }),
    );
  });

  it('reconnects an operation stream after remount and reloads the persisted terminal operation', async () => {
    const eventStreamChunks = [
      'id: 1\nevent: operation_event\ndata: {"id":1,"operationId":"op-1","state":"running","message":"Operation started","metadata":{},"createdAt":"2026-09-23T08:00:00.000Z"}\n\n',
      'event: complete\ndata: {"operationId":"op-1","state":"succeeded"}\n\n',
    ];

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/admin/operations/op-1/events') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(eventStreamChunks.shift() ?? ''));
            controller.close();
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const api: AdminApiClient = {
      get: vi.fn().mockResolvedValue({
        operation: {
          id: 'op-1',
          requestedBy: 'admin-id',
          type: 'backup_create',
          state: 'succeeded',
          summary: 'Create database backup',
          output: null,
          startedAt: '2026-09-23T08:00:00.000Z',
          completedAt: '2026-09-23T08:01:00.000Z',
          createdAt: '2026-09-23T08:00:00.000Z',
        },
      }),
      mutate: vi.fn(),
      download: vi.fn(),
    };

    const first = render(<OperationProgress api={api} operationId="op-1" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<OperationProgress api={api} operationId="op-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Create database backup')).toBeVisible();
    expect(screen.getByText('succeeded')).toBeVisible();
  });

  it('does not reconnect the operation stream when the same operation receives persisted updates', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start() {},
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api: AdminApiClient = {
      get: vi.fn(),
      mutate: vi.fn(),
      download: vi.fn(),
    };
    const queuedOperation = {
      id: 'op-1',
      requestedBy: 'admin-id',
      type: 'backup_create' as const,
      state: 'queued' as const,
      summary: 'Create database backup',
      output: null,
      startedAt: null,
      completedAt: null,
      createdAt: '2026-09-23T08:00:00.000Z',
    };

    const { rerender } = render(
      <OperationProgress
        api={api}
        operationId="op-1"
        initialOperation={queuedOperation}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(
      <OperationProgress
        api={api}
        operationId="op-1"
        initialOperation={{
          ...queuedOperation,
          state: 'running',
          startedAt: '2026-09-23T08:00:30.000Z',
        }}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces malformed SSE JSON as an invalid response without falling back to polling', async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/admin/operations/op-1/events') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('event: operation_event\ndata: {"id":1\n\n'),
            );
            controller.close();
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const api: AdminApiClient = {
      get: vi.fn(),
      mutate: vi.fn(),
      download: vi.fn(),
    };

    render(<OperationProgress api={api} operationId="op-1" />);

    expect(
      await screen.findByRole('alert', { name: '' }).catch(async () => screen.findByRole('alert')),
    ).toHaveTextContent('The server returned an invalid response.');
    expect(api.get).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Waiting for the persisted operation state.')).toBeVisible();
  });

  it('surfaces structurally invalid operation events as an invalid response and aborts the stream', async () => {
    let streamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/admin/operations/op-1/events') {
        streamSignal = init?.signal ?? undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: operation_event\ndata: {"id":"bad","operationId":"op-1","state":"running","message":"Operation started","metadata":{},"createdAt":"2026-09-23T08:00:00.000Z"}\n\n',
              ),
            );
            controller.close();
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const api: AdminApiClient = {
      get: vi.fn(),
      mutate: vi.fn(),
      download: vi.fn(),
    };

    render(<OperationProgress api={api} operationId="op-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The server returned an invalid response.');
    expect(api.get).not.toHaveBeenCalled();
    expect(streamSignal?.aborted).toBe(true);
    expect(screen.queryByText('Operation started')).not.toBeInTheDocument();
  });

  it('surfaces structurally invalid complete events as an invalid response instead of terminal success', async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/admin/operations/op-1/events') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: complete\ndata: {"operationId":"op-1","state":"running"}\n\n',
              ),
            );
            controller.close();
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const api: AdminApiClient = {
      get: vi.fn(),
      mutate: vi.fn(),
      download: vi.fn(),
    };

    render(
      <OperationProgress
        api={api}
        operationId="op-1"
        initialOperation={{
          id: 'op-1',
          requestedBy: 'admin-id',
          type: 'backup_create',
          state: 'queued',
          summary: 'Create database backup',
          output: null,
          startedAt: null,
          completedAt: null,
          createdAt: '2026-09-23T08:00:00.000Z',
        }}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('The server returned an invalid response.');
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.getByText('queued')).toBeVisible();
  });

  it('treats the server timeout event as a normal disconnect and polls persisted state', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: timeout\ndata: {"operationId":"op-timeout"}\n\n',
                ),
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          },
        ),
      ),
    );
    const api: AdminApiClient = {
      get: vi.fn().mockResolvedValue({
        operation: {
          id: 'op-timeout',
          requestedBy: 'admin-id',
          type: 'backup_create',
          state: 'running',
          summary: 'Create database backup',
          output: null,
          startedAt: '2026-09-23T08:00:00.000Z',
          completedAt: null,
          createdAt: '2026-09-23T08:00:00.000Z',
        },
      }),
      mutate: vi.fn(),
      download: vi.fn(),
    };

    render(<OperationProgress api={api} operationId="op-timeout" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Live updates disconnected; polling persisted status.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps polling beyond five attempts until the persisted operation becomes terminal and exposes a stable anchor target', async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === '/api/v1/admin/operations/op-long/events') {
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.close();
                },
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
              },
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );

    let pollCount = 0;
    const api: AdminApiClient = {
      get: vi.fn().mockImplementation(async () => {
        pollCount += 1;
        return {
          operation: {
            id: 'op-long',
            requestedBy: 'admin-id',
            type: 'backup_restore',
            state: pollCount >= 7 ? 'succeeded' : 'running',
            summary: 'Restore backup ariadne-20260923T032200Z.dump',
            output: pollCount >= 7 ? 'Restore completed successfully.' : null,
            startedAt: '2026-09-23T08:00:00.000Z',
            completedAt: pollCount >= 7 ? '2026-09-23T08:06:00.000Z' : null,
            createdAt: '2026-09-23T08:00:00.000Z',
          },
        };
      }),
      mutate: vi.fn(),
      download: vi.fn(),
    };

    render(
      <OperationProgress
        api={api}
        operationId="op-long"
        initialOperation={{
          id: 'op-long',
          requestedBy: 'admin-id',
          type: 'backup_restore',
          state: 'queued',
          summary: 'Restore backup ariadne-20260923T032200Z.dump',
          output: null,
          startedAt: null,
          completedAt: null,
          createdAt: '2026-09-23T08:00:00.000Z',
        }}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(125_000);
    });

    expect(api.get).toHaveBeenCalledTimes(7);
    expect(screen.getByText('Restore completed successfully.')).toBeVisible();
    expect(screen.getByLabelText('Operation progress')).toHaveAttribute('id', 'operation-op-long');
  });
});
