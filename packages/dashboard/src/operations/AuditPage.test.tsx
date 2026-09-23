import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { AuditPage } from './AuditPage';

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

function renderWithProvider(child: ReactNode) {
  return render(<AuthProvider>{child}</AuthProvider>);
}

function eventStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuditPage', () => {
  it('filters, paginates, opens an in-page operation detail target, and renders operation links for immutable audit history', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody()));
      }
      if (url === '/api/v1/admin/audit?limit=50') {
        return Promise.resolve(
          json({
            events: [
              {
                id: 22,
                actorUserId: 'admin-id',
                action: 'admin_operation.state_changed',
                source: 'operator',
                outcome: 'failed',
                metadata: {
                  operationId: 'op-22',
                  type: 'deployment_apply',
                  revision: 'c'.repeat(40),
                },
                createdAt: '2026-09-23T09:22:00.000Z',
              },
            ],
            nextCursor: '21',
          }),
        );
      }
      if (url === '/api/v1/admin/audit?limit=50&action=admin_operation.state_changed&outcome=failed') {
        return Promise.resolve(
          json({
            events: [
              {
                id: 22,
                actorUserId: 'admin-id',
                action: 'admin_operation.state_changed',
                source: 'operator',
                outcome: 'failed',
                metadata: {
                  operationId: 'op-22',
                  type: 'deployment_apply',
                  revision: 'c'.repeat(40),
                },
                createdAt: '2026-09-23T09:22:00.000Z',
              },
            ],
            nextCursor: '21',
          }),
        );
      }
      if (
        url ===
        '/api/v1/admin/audit?limit=50&action=admin_operation.state_changed&outcome=failed&cursor=21'
      ) {
        return Promise.resolve(
          json({
            events: [
              {
                id: 21,
                actorUserId: null,
                action: 'member.activate',
                source: 'admin_api',
                outcome: 'succeeded',
                metadata: {
                  username: 'ops-member',
                  userId: 'member-1',
                },
                createdAt: '2026-09-23T09:21:00.000Z',
              },
            ],
            nextCursor: null,
          }),
        );
      }
      if (url === '/api/v1/admin/operations/op-22/events') {
        return Promise.resolve(
          eventStream([
            'event: operation_event\ndata: {"id":2201,"operationId":"op-22","state":"running","message":"Applying migration bundle","metadata":{},"createdAt":"2026-09-23T09:22:10.000Z"}\n\n',
            'event: complete\ndata: {"operationId":"op-22","state":"failed"}\n\n',
          ]),
        );
      }
      if (url === '/api/v1/admin/operations/op-22') {
        return Promise.resolve(
          json({
            operation: {
              id: 'op-22',
              requestedBy: 'admin-id',
              type: 'deployment_apply',
              state: 'failed',
              summary: 'Deploy revision cccccccccccccccccccccccccccccccccccccccc',
              output: 'Health checks timed out after cutover.',
              startedAt: '2026-09-23T09:22:10.000Z',
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

    renderWithProvider(<AuditPage />);

    expect(await screen.findByText('admin_operation.state_changed')).toBeVisible();
    const operationLink = screen.getByRole('link', { name: 'Operation op-22' });
    expect(operationLink).toHaveAttribute(
      'href',
      '#operation-op-22',
    );

    await user.click(operationLink);

    const operationPanel = await screen.findByLabelText('Operation progress');
    expect(operationPanel).toHaveAttribute('id', 'operation-op-22');
    expect(operationPanel).toHaveFocus();
    expect(await screen.findByText('Applying migration bundle')).toBeVisible();
    expect(await screen.findByText('Health checks timed out after cutover.')).toBeVisible();

    await user.type(screen.getByLabelText('Action'), 'admin_operation.state_changed');
    await user.type(screen.getByLabelText('Outcome'), 'failed');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText(`revision ${'c'.repeat(12)}`)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Load older events' }));
    expect(await screen.findByText('ops-member')).toBeVisible();
    expect(screen.getByText('system')).toBeVisible();
  });
});
