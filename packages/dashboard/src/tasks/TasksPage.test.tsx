import { type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import type { AdminOperationState } from '../api/types';
import { TasksPage } from './TasksPage';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderWithProvider(child: ReactNode) {
  return render(<AuthProvider>{child}</AuthProvider>);
}

function sessionBody(reauthenticatedUntil: string | null = null) {
  return {
    userId: 'admin-id',
    username: 'admin',
    csrfToken: 'csrf-token',
    reauthenticatedUntil,
  };
}

function futureReauthenticatedUntil(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function taskSummary(taskId: string, title: string, captureCount: number) {
  return {
    taskId,
    localId: `local-${taskId}`,
    title,
    goal: 'Inspect Ariadne history',
    status: 'in_progress',
    branch: 'feat/cloud',
    workspaceLabel: 'Ariadne',
    owner: 'admin',
    captureCount,
    createdAt: '2026-09-22T18:00:00.000Z',
    updatedAt: '2026-09-23T07:00:00.000Z',
  };
}

function captureEvent(captureId: string, path: string, byteLength = 42) {
  return {
    kind: 'capture' as const,
    id: captureId,
    occurredAt: '2026-09-23T07:00:00.000Z',
    summary: `checkpoint capture of ${path}`,
    metadata: {
      files: [{ path, contentSha256: `${captureId}-sha`, byteLength }],
    },
  };
}

function fileBody(path: string, content = '<script>alert("never execute")</script>') {
  return {
    path,
    content,
    unifiedDiff: `+updated ${path}`,
    contentSha256: 'abc',
    byteLength: 42,
  };
}

function acceptedOperation(operationId: string) {
  return {
    accepted: true as const,
    operation: {
      id: operationId,
      requestedBy: 'admin-id',
      type: 'file_capture_delete' as const,
      state: 'queued' as const,
      summary: 'Delete file capture capture-1',
      output: null,
      startedAt: null,
      completedAt: null,
      createdAt: '2026-09-23T08:01:00.000Z',
    },
  };
}

function operationBody(state: AdminOperationState) {
  return {
    operation: {
      id: 'op-1',
      requestedBy: 'admin-id',
      type: 'file_capture_delete' as const,
      state,
      summary: 'Delete file capture capture-1',
      output: null,
      startedAt: state === 'queued' ? null : '2026-09-23T08:02:00.000Z',
      completedAt: state === 'succeeded' || state === 'failed' ? '2026-09-23T08:03:00.000Z' : null,
      createdAt: '2026-09-23T08:01:00.000Z',
    },
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createEventStream() {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    },
  );

  return {
    response,
    emit(event: string, data: unknown) {
      streamController?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    close() {
      streamController?.close();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TasksPage', () => {
  it('opens a task capture and renders captured source as inert text', async () => {
    const responses = new Map<string, unknown>([
      ['/api/v1/admin/session', sessionBody()],
      [
        '/api/v1/admin/tasks?limit=100',
        { tasks: [taskSummary('task-1', 'Build cloud dashboard', 1)], hasMore: false, nextOffset: null },
      ],
      [
        '/api/v1/admin/tasks/task-1/timeline',
        { taskId: 'task-1', events: [captureEvent('capture-1', 'src/App.tsx')] },
      ],
      [
        '/api/v1/admin/tasks/task-1/file-captures/capture-1/files/src%2FApp.tsx',
        fileBody('src/App.tsx'),
      ],
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const body = responses.get(url);
        return Promise.resolve(body ? json(body) : new Response(null, { status: 404 }));
      }),
    );
    const user = userEvent.setup();

    renderWithProvider(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: /build cloud dashboard/i }));
    await user.click(await screen.findByRole('button', { name: /src\/app.tsx/i }));

    expect(await screen.findByText('<script>alert("never execute")</script>')).toBeVisible();
    expect(document.querySelector('script')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Diff' }));
    expect(screen.getByText('+updated src/App.tsx')).toBeVisible();
  });

  it('shows delete controls only for the selected capture and removes it only after a refreshed timeline confirms success', async () => {
    const refreshTimeline = deferredResponse();
    const eventStream = createEventStream();
    let operationState: AdminOperationState = 'queued';
    let timelineLoads = 0;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody(null)));
      }
      if (url === '/api/v1/admin/tasks?limit=100') {
        return Promise.resolve(
          json({
            tasks: [taskSummary('task-1', 'Build cloud dashboard', 2)],
            hasMore: false,
            nextOffset: null,
          }),
        );
      }
      if (url === '/api/v1/admin/tasks/task-1/timeline') {
        timelineLoads += 1;
        if (timelineLoads === 1) {
          return Promise.resolve(
            json({
              taskId: 'task-1',
              events: [
                captureEvent('capture-1', 'src/App.tsx'),
                captureEvent('capture-2', 'src/routes.tsx', 84),
              ],
            }),
          );
        }
        return refreshTimeline.promise;
      }
      if (url === '/api/v1/admin/tasks/task-1/file-captures/capture-1/files/src%2FApp.tsx') {
        return Promise.resolve(json(fileBody('src/App.tsx')));
      }
      if (url === '/api/v1/admin/session/reauthenticate') {
        return Promise.resolve(json({ reauthenticatedUntil: futureReauthenticatedUntil() }));
      }
      if (url === '/api/v1/admin/tasks/task-1/file-captures/capture-1') {
        expect(init?.method).toBe('DELETE');
        expect(init?.body).toBe(JSON.stringify({ confirmation: 'DELETE capture-1' }));
        return Promise.resolve(json(acceptedOperation('op-1'), 202));
      }
      if (url === '/api/v1/admin/operations/op-1/events') {
        return Promise.resolve(eventStream.response);
      }
      if (url === '/api/v1/admin/operations/op-1') {
        return Promise.resolve(json(operationBody(operationState)));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    const { container } = renderWithProvider(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: /build cloud dashboard/i }));
    expect(screen.queryByRole('button', { name: /delete capture/i })).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /src\/app.tsx/i }));
    expect(await screen.findByRole('button', { name: 'Delete capture capture-1' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete capture capture-1' }));

    expect(await screen.findByRole('dialog', { name: 'Delete file capture' })).toBeVisible();
    expect(screen.getAllByText('src/App.tsx').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Type DELETE capture-1 to continue')).toBeVisible();
    expect(screen.getByLabelText('Administrator password')).toBeVisible();

    const submit = screen.getByRole('button', { name: 'Continue operation' });
    await user.type(screen.getByLabelText('Type DELETE capture-1 to continue'), 'delete capture-1');
    await user.type(screen.getByLabelText('Administrator password'), 'correct horse battery staple');
    expect(submit).toBeDisabled();

    await user.clear(screen.getByLabelText('Type DELETE capture-1 to continue'));
    await user.type(screen.getByLabelText('Type DELETE capture-1 to continue'), 'DELETE capture-1');
    expect(submit).toBeEnabled();

    await user.click(submit);

    expect(await screen.findByLabelText('Operation progress')).toHaveTextContent('queued');

    eventStream.emit('operation_event', {
      id: 1,
      operationId: 'op-1',
      state: 'running',
      message: 'Deleting file capture',
      metadata: {},
      createdAt: '2026-09-23T08:02:00.000Z',
    });

    expect(await screen.findByText('Deleting file capture')).toBeVisible();
    expect(screen.getByLabelText('Operation progress')).toHaveTextContent('running');

    operationState = 'succeeded';
    eventStream.emit('complete', {
      operationId: 'op-1',
      state: 'succeeded',
    });

    await waitFor(() =>
      expect(screen.queryByText('<script>alert("never execute")</script>')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Capture deleted.');
    expect(screen.getByRole('button', { name: /src\/app.tsx/i })).toBeVisible();

    refreshTimeline.resolve(
      json({
        taskId: 'task-1',
        events: [captureEvent('capture-2', 'src/routes.tsx', 84)],
      }),
    );

    const nextCapture = await screen.findByRole('button', { name: /src\/routes.tsx/i });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Delete capture capture-1$/i })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: /src\/app.tsx/i })).not.toBeInTheDocument());
    await waitFor(() => expect(nextCapture).toHaveFocus());
    expect(container.querySelector('.task-workbench')).toHaveAttribute('data-active-pane', 'timeline');
  });

  it('cancels a capture deletion before submitting the protected request', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody(futureReauthenticatedUntil())));
      }
      if (url === '/api/v1/admin/tasks?limit=100') {
        return Promise.resolve(
          json({
            tasks: [taskSummary('task-1', 'Build cloud dashboard', 1)],
            hasMore: false,
            nextOffset: null,
          }),
        );
      }
      if (url === '/api/v1/admin/tasks/task-1/timeline') {
        return Promise.resolve(json({ taskId: 'task-1', events: [captureEvent('capture-1', 'src/App.tsx')] }));
      }
      if (url === '/api/v1/admin/tasks/task-1/file-captures/capture-1/files/src%2FApp.tsx') {
        return Promise.resolve(json(fileBody('src/App.tsx')));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: /build cloud dashboard/i }));
    await user.click(await screen.findByRole('button', { name: /src\/app.tsx/i }));
    await user.click(await screen.findByRole('button', { name: 'Delete capture capture-1' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Delete file capture' })).not.toBeInTheDocument(),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/admin/tasks/task-1/file-captures/capture-1'),
    ).toHaveLength(0);
  });

  it('aborts an in-flight deletion request and clears plaintext when the user changes tasks', async () => {
    let deleteRequestAborted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody(futureReauthenticatedUntil())));
      }
      if (url === '/api/v1/admin/tasks?limit=100') {
        return Promise.resolve(
          json({
            tasks: [
              taskSummary('task-1', 'First task', 1),
              taskSummary('task-2', 'Second task', 0),
            ],
            hasMore: false,
            nextOffset: null,
          }),
        );
      }
      if (url === '/api/v1/admin/tasks/task-1/timeline') {
        return Promise.resolve(json({ taskId: 'task-1', events: [captureEvent('capture-1', 'src/App.tsx')] }));
      }
      if (url === '/api/v1/admin/tasks/task-2/timeline') {
        return Promise.resolve(
          json({
            taskId: 'task-2',
            events: [
              {
                kind: 'decision',
                id: 'event-2',
                occurredAt: '2026-09-23T07:01:00.000Z',
                summary: 'Current task event',
                metadata: {},
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/tasks/task-1/file-captures/capture-1/files/src%2FApp.tsx') {
        return Promise.resolve(json(fileBody('src/App.tsx')));
      }
      if (url === '/api/v1/admin/tasks/task-1/file-captures/capture-1') {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            deleteRequestAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: /first task/i }));
    await user.click(await screen.findByRole('button', { name: /src\/app.tsx/i }));
    await user.click(await screen.findByRole('button', { name: 'Delete capture capture-1' }));
    await user.type(screen.getByLabelText('Type DELETE capture-1 to continue'), 'DELETE capture-1');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));
    await user.click(screen.getByRole('button', { name: /second task/i }));

    expect(await screen.findByText('Current task event')).toBeVisible();
    await waitFor(() => expect(deleteRequestAborted).toBe(true));
    expect(screen.queryByText('<script>alert("never execute")</script>')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Delete file capture' })).not.toBeInTheDocument();
  });

  it('shows a failed operation without removing the selected capture before the server refresh succeeds', async () => {
    const eventStream = createEventStream();
    let operationState: AdminOperationState = 'queued';
    let timelineLoads = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/admin/session') {
          return Promise.resolve(json(sessionBody(futureReauthenticatedUntil())));
        }
        if (url === '/api/v1/admin/tasks?limit=100') {
          return Promise.resolve(
            json({
              tasks: [taskSummary('task-1', 'Build cloud dashboard', 1)],
              hasMore: false,
              nextOffset: null,
            }),
          );
        }
        if (url === '/api/v1/admin/tasks/task-1/timeline') {
          timelineLoads += 1;
          return Promise.resolve(json({ taskId: 'task-1', events: [captureEvent('capture-1', 'src/App.tsx')] }));
        }
        if (url === '/api/v1/admin/tasks/task-1/file-captures/capture-1/files/src%2FApp.tsx') {
          return Promise.resolve(json(fileBody('src/App.tsx')));
        }
        if (url === '/api/v1/admin/tasks/task-1/file-captures/capture-1') {
          expect(init?.method).toBe('DELETE');
          return Promise.resolve(json(acceptedOperation('op-1'), 202));
        }
        if (url === '/api/v1/admin/operations/op-1/events') {
          return Promise.resolve(eventStream.response);
        }
        if (url === '/api/v1/admin/operations/op-1') {
          return Promise.resolve(json(operationBody(operationState)));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    const user = userEvent.setup();

    renderWithProvider(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: /build cloud dashboard/i }));
    await user.click(await screen.findByRole('button', { name: /src\/app.tsx/i }));
    await user.click(await screen.findByRole('button', { name: 'Delete capture capture-1' }));
    await user.type(screen.getByLabelText('Type DELETE capture-1 to continue'), 'DELETE capture-1');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    expect(await screen.findByLabelText('Operation progress')).toHaveTextContent('queued');

    eventStream.emit('operation_event', {
      id: 1,
      operationId: 'op-1',
      state: 'running',
      message: 'Deleting file capture',
      metadata: {},
      createdAt: '2026-09-23T08:02:00.000Z',
    });
    operationState = 'failed';
    eventStream.emit('complete', {
      operationId: 'op-1',
      state: 'failed',
    });

    await screen.findByLabelText('Operation progress');
    await waitFor(() => expect(screen.getByLabelText('Operation progress')).toHaveTextContent('failed'));
    expect(screen.getByText('<script>alert("never execute")</script>')).toBeVisible();
    expect(screen.getByRole('button', { name: /src\/app.tsx/i })).toBeVisible();
    expect(timelineLoads).toBe(1);
  });
});
