import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { DeploymentsPage } from './DeploymentsPage';

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

function renderWithProvider(child: ReactNode) {
  return render(<AuthProvider>{child}</AuthProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeploymentsPage', () => {
  it('renders deployment status, recent history, and no free-form revision input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/admin/session') {
          return Promise.resolve(
            json(sessionBody({ reauthenticatedUntil: '2026-09-23T20:00:00.000Z' })),
          );
        }
        if (url === '/api/v1/admin/deployments') {
          return Promise.resolve(
            json({
              currentRevision: 'a'.repeat(40),
              rollbackRevision: 'b'.repeat(40),
              schemaVersion: 8,
              candidates: [
                {
                  revision: 'a'.repeat(40),
                  committedAt: '2026-09-23T09:00:00.000Z',
                  subject: 'Deploy current revision',
                },
                {
                  revision: 'c'.repeat(40),
                  committedAt: '2026-09-23T09:10:00.000Z',
                  subject: 'Ship migration hardening',
                },
              ],
            }),
          );
        }
        if (url === '/api/v1/admin/operations?limit=20') {
          return Promise.resolve(
            json({
              operations: [
                {
                  id: 'op-rollback',
                  requestedBy: 'admin-id',
                  type: 'deployment_rollback',
                  state: 'succeeded',
                  summary: 'Rollback to revision bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                  output: null,
                  startedAt: '2026-09-22T08:00:00.000Z',
                  completedAt: '2026-09-22T08:01:00.000Z',
                  createdAt: '2026-09-22T08:00:00.000Z',
                },
              ],
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );

    renderWithProvider(<DeploymentsPage />);

    expect(await screen.findByText('Deploy current revision')).toBeVisible();
    expect(screen.getAllByText('Current').length).toBeGreaterThan(0);
    expect(screen.getByText('Rollback target')).toBeVisible();
    expect(screen.getByText('Schema version')).toBeVisible();
    expect(screen.getByText('Ship migration hardening')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /revision/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /ref/i })).not.toBeInTheDocument();
    expect(screen.getByText('Rollback to revision bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toBeVisible();
  });

  it('deploys only a selected candidate and rolls back only the eligible revision with exact confirmation', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(
          json(sessionBody({ reauthenticatedUntil: '2026-09-23T20:00:00.000Z' })),
        );
      }
      if (url === '/api/v1/admin/deployments') {
        return Promise.resolve(
          json({
            currentRevision: 'a'.repeat(40),
            rollbackRevision: 'b'.repeat(40),
            schemaVersion: 8,
            candidates: [
              {
                revision: 'c'.repeat(40),
                committedAt: '2026-09-23T09:10:00.000Z',
                subject: 'Ship migration hardening',
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/operations?limit=20') {
        return Promise.resolve(json({ operations: [] }));
      }
      if (url === '/api/v1/admin/operations/deploy') {
        return Promise.resolve(
          json(
            {
              accepted: true,
              operation: {
                id: 'op-deploy',
                requestedBy: 'admin-id',
                type: 'deployment_apply',
                state: 'queued',
                summary: 'Deploy revision cccccccccccccccccccccccccccccccccccccccc',
                output: null,
                startedAt: null,
                completedAt: null,
                createdAt: '2026-09-23T09:20:00.000Z',
              },
            },
            202,
          ),
        );
      }
      if (url === '/api/v1/admin/operations/op-deploy/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":1,"operationId":"op-deploy","state":"running","message":"Running migrations","metadata":{},"createdAt":"2026-09-23T09:20:01.000Z"}\n\n',
            'event: operation_event\ndata: {"id":2,"operationId":"op-deploy","state":"running","message":"Checking application health","metadata":{},"createdAt":"2026-09-23T09:20:02.000Z"}\n\n',
            'event: complete\ndata: {"operationId":"op-deploy","state":"succeeded"}\n\n',
          ]),
        );
      }
      if (url === '/api/v1/admin/operations/op-deploy') {
        return Promise.resolve(
          json({
            operation: {
              id: 'op-deploy',
              requestedBy: 'admin-id',
              type: 'deployment_apply',
              state: 'succeeded',
              summary: 'Deploy revision cccccccccccccccccccccccccccccccccccccccc',
              output: 'Deployment healthy.',
              startedAt: '2026-09-23T09:20:01.000Z',
              completedAt: '2026-09-23T09:21:00.000Z',
              createdAt: '2026-09-23T09:20:00.000Z',
            },
          }),
        );
      }
      if (url === '/api/v1/admin/operations/rollback') {
        return Promise.resolve(
          json(
            {
              accepted: true,
              operation: {
                id: 'op-rollback',
                requestedBy: 'admin-id',
                type: 'deployment_rollback',
                state: 'queued',
                summary: 'Rollback to revision bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                output: null,
                startedAt: null,
                completedAt: null,
                createdAt: '2026-09-23T09:22:00.000Z',
              },
            },
            202,
          ),
        );
      }
      if (url === '/api/v1/admin/operations/op-rollback/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":3,"operationId":"op-rollback","state":"running","message":"Restoring previous image","metadata":{},"createdAt":"2026-09-23T09:22:01.000Z"}\n\n',
            'event: complete\ndata: {"operationId":"op-rollback","state":"succeeded"}\n\n',
          ]),
        );
      }
      if (url === '/api/v1/admin/operations/op-rollback') {
        return Promise.resolve(
          json({
            operation: {
              id: 'op-rollback',
              requestedBy: 'admin-id',
              type: 'deployment_rollback',
              state: 'succeeded',
              summary: 'Rollback to revision bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              output: 'Rollback healthy.',
              startedAt: '2026-09-23T09:22:01.000Z',
              completedAt: '2026-09-23T09:23:00.000Z',
              createdAt: '2026-09-23T09:22:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<DeploymentsPage />);

    await user.click(await screen.findByRole('radio', { name: /Ship migration hardening/i }));
    await user.click(screen.getByRole('button', { name: 'Deploy selected revision' }));
    expect(await screen.findByRole('dialog', { name: 'Deploy selected revision' })).toBeVisible();
    await user.type(
      screen.getByLabelText(`Type DEPLOY ${'c'.repeat(40)} to continue`),
      `DEPLOY ${'c'.repeat(40)}`,
    );
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));
    expect(await screen.findByText('Running migrations')).toBeVisible();
    expect(await screen.findByText('Checking application health')).toBeVisible();
    expect(await screen.findByText('Deployment healthy.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Rollback to previous revision' }));
    expect(await screen.findByRole('dialog', { name: 'Rollback deployment' })).toBeVisible();
    await user.type(
      screen.getByLabelText(`Type ROLLBACK ${'b'.repeat(40)} to continue`),
      `ROLLBACK ${'b'.repeat(40)}`,
    );
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));
    expect(await screen.findByText('Restoring previous image')).toBeVisible();
    expect(await screen.findByText('Rollback healthy.')).toBeVisible();
  });

  it('forces reauthentication after a stale deploy submission while preserving the selected revision confirmation', async () => {
    let deployAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(
          json(sessionBody({ reauthenticatedUntil: '2026-09-23T20:00:00.000Z' })),
        );
      }
      if (url === '/api/v1/admin/deployments') {
        return Promise.resolve(
          json({
            currentRevision: 'a'.repeat(40),
            rollbackRevision: 'b'.repeat(40),
            schemaVersion: 8,
            candidates: [
              {
                revision: 'c'.repeat(40),
                committedAt: '2026-09-23T09:10:00.000Z',
                subject: 'Ship migration hardening',
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/admin/operations?limit=20') {
        return Promise.resolve(json({ operations: [] }));
      }
      if (url === '/api/v1/admin/operations/deploy') {
        deployAttempts += 1;
        if (deployAttempts === 1) {
          return Promise.resolve(
            json({ error: { code: 'reauthentication_required', message: 'Password required' } }, 403),
          );
        }
        return Promise.resolve(
          json(
            {
              accepted: true,
              operation: {
                id: 'op-deploy-reauth',
                requestedBy: 'admin-id',
                type: 'deployment_apply',
                state: 'queued',
                summary: 'Deploy revision cccccccccccccccccccccccccccccccccccccccc',
                output: null,
                startedAt: null,
                completedAt: null,
                createdAt: '2026-09-23T09:20:00.000Z',
              },
            },
            202,
          ),
        );
      }
      if (url === '/api/v1/admin/session/reauthenticate') {
        return Promise.resolve(json({ reauthenticatedUntil: '2026-09-23T20:05:00.000Z' }));
      }
      if (url === '/api/v1/admin/operations/op-deploy-reauth/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":41,"operationId":"op-deploy-reauth","state":"running","message":"Running migrations","metadata":{},"createdAt":"2026-09-23T09:20:01.000Z"}\n\n',
            'event: complete\ndata: {"operationId":"op-deploy-reauth","state":"succeeded"}\n\n',
          ]),
        );
      }
      if (url === '/api/v1/admin/operations/op-deploy-reauth') {
        return Promise.resolve(
          json({
            operation: {
              id: 'op-deploy-reauth',
              requestedBy: 'admin-id',
              type: 'deployment_apply',
              state: 'succeeded',
              summary: 'Deploy revision cccccccccccccccccccccccccccccccccccccccc',
              output: 'Deployment healthy.',
              startedAt: '2026-09-23T09:20:01.000Z',
              completedAt: '2026-09-23T09:21:00.000Z',
              createdAt: '2026-09-23T09:20:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<DeploymentsPage />);

    await user.click(await screen.findByRole('radio', { name: /Ship migration hardening/i }));
    await user.click(screen.getByRole('button', { name: 'Deploy selected revision' }));
    expect(await screen.findByRole('dialog', { name: 'Deploy selected revision' })).toBeVisible();
    expect(screen.queryByLabelText('Administrator password')).not.toBeInTheDocument();

    await user.type(
      screen.getByLabelText(`Type DEPLOY ${'c'.repeat(40)} to continue`),
      `DEPLOY ${'c'.repeat(40)}`,
    );
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    expect(await screen.findByLabelText('Administrator password')).toBeVisible();
    expect(await screen.findByDisplayValue(`DEPLOY ${'c'.repeat(40)}`)).toBeVisible();

    await user.type(screen.getByLabelText('Administrator password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    expect(await screen.findByText('Deployment healthy.')).toBeVisible();
  });
});
