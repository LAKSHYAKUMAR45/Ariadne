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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuditPage', () => {
  it('filters, paginates, and renders operation links for immutable audit history', async () => {
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
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<AuditPage />);

    expect(await screen.findByText('admin_operation.state_changed')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Operation op-22' })).toHaveAttribute(
      'href',
      '#operation-op-22',
    );

    await user.type(screen.getByLabelText('Action'), 'admin_operation.state_changed');
    await user.type(screen.getByLabelText('Outcome'), 'failed');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText(`revision ${'c'.repeat(12)}`)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Load older events' }));
    expect(await screen.findByText('ops-member')).toBeVisible();
    expect(screen.getByText('system')).toBeVisible();
  });
});
