import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TasksPage } from './TasksPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('opens a task capture and renders captured source as inert text', async () => {
  const responses = new Map<string, unknown>([
    [
      '/api/v1/admin/tasks?limit=100',
      {
        tasks: [
          {
            taskId: 'task-1',
            localId: 'local-1',
            title: 'Build cloud dashboard',
            goal: 'Inspect Ariadne history',
            status: 'in_progress',
            branch: 'feat/cloud',
            workspaceLabel: 'Ariadne',
            owner: 'admin',
            captureCount: 1,
            createdAt: '2026-09-22T18:00:00.000Z',
            updatedAt: '2026-09-23T07:00:00.000Z',
          },
        ],
        hasMore: false,
        nextOffset: null,
      },
    ],
    [
      '/api/v1/admin/tasks/task-1/timeline',
      {
        taskId: 'task-1',
        events: [
          {
            kind: 'capture',
            id: 'capture-1',
            occurredAt: '2026-09-23T07:00:00.000Z',
            summary: 'checkpoint capture of 1 file(s)',
            metadata: {
              files: [{ path: 'src/App.tsx', contentSha256: 'abc', byteLength: 42 }],
            },
          },
        ],
      },
    ],
    [
      '/api/v1/admin/tasks/task-1/file-captures/capture-1/files/src%2FApp.tsx',
      {
        path: 'src/App.tsx',
        content: '<script>alert("never execute")</script>',
        unifiedDiff: '+const dashboard = true;',
        contentSha256: 'abc',
        byteLength: 42,
      },
    ],
  ]);

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = responses.get(url);
      return Promise.resolve(
        body
          ? new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          : new Response(null, { status: 404 }),
      );
    }),
  );
  const user = userEvent.setup();

  render(<TasksPage />);

  await user.click(await screen.findByRole('button', { name: /build cloud dashboard/i }));
  await user.click(await screen.findByRole('button', { name: /src\/app.tsx/i }));

  expect(await screen.findByText('<script>alert("never execute")</script>')).toBeVisible();
  expect(document.querySelector('script')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Diff' }));
  expect(screen.getByText('+const dashboard = true;')).toBeVisible();
});

it('ignores a stale timeline response after the user selects another task', async () => {
  let resolveFirstTimeline: ((response: Response) => void) | undefined;
  const firstTimeline = new Promise<Response>((resolve) => {
    resolveFirstTimeline = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/tasks?limit=100') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              tasks: [
                {
                  taskId: 'task-1',
                  localId: 'local-1',
                  title: 'First task',
                  goal: null,
                  status: 'active',
                  branch: null,
                  workspaceLabel: 'Ariadne',
                  owner: 'admin',
                  captureCount: 0,
                  createdAt: '2026-09-22T18:00:00.000Z',
                  updatedAt: '2026-09-23T07:00:00.000Z',
                },
                {
                  taskId: 'task-2',
                  localId: 'local-2',
                  title: 'Second task',
                  goal: null,
                  status: 'active',
                  branch: null,
                  workspaceLabel: 'Ariadne',
                  owner: 'admin',
                  captureCount: 0,
                  createdAt: '2026-09-22T18:00:00.000Z',
                  updatedAt: '2026-09-23T07:01:00.000Z',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.endsWith('/task-1/timeline')) {
        return firstTimeline;
      }
      if (url.endsWith('/task-2/timeline')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
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
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
  const user = userEvent.setup();

  render(<TasksPage />);

  await user.click(await screen.findByRole('button', { name: /first task/i }));
  await user.click(screen.getByRole('button', { name: /second task/i }));
  expect(await screen.findByText('Current task event')).toBeVisible();

  resolveFirstTimeline?.(
    new Response(
      JSON.stringify({
        taskId: 'task-1',
        events: [
          {
            kind: 'error',
            id: 'stale-event',
            occurredAt: '2026-09-23T07:00:00.000Z',
            summary: 'Stale task event',
            metadata: {},
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  expect(await screen.findByText('Current task event')).toBeVisible();
  expect(screen.queryByText('Stale task event')).not.toBeInTheDocument();
});
