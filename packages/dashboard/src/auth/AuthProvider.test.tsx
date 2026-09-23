import { type ReactNode, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAcceptedOperationResponse, isOverviewResponse } from '../api/guards';
import { LoginPage } from './LoginPage';
import { AuthProvider, useAuth } from './AuthProvider';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderWithProvider(child: ReactNode) {
  return render(<AuthProvider>{child}</AuthProvider>);
}

function ApiHarness() {
  const { api, ready, session, login, error } = useAuth();
  const [message, setMessage] = useState<string>('');

  if (!ready) {
    return <p>Booting...</p>;
  }

  return (
    <div>
      <p>{session ? `Session:${session.username}` : 'Signed out'}</p>
      {error ? <p role="alert">{error}</p> : null}
      <p data-testid="message">{message}</p>
      <button type="button" onClick={() => void login('admin', 'password-123')}>
        Log in
      </button>
      <button
        type="button"
        onClick={() =>
          void api
            .get('/api/v1/admin/overview', isOverviewResponse)
            .then(() => setMessage('loaded'))
            .catch((loadError: unknown) =>
              setMessage(loadError instanceof Error ? loadError.message : 'failed'),
            )
        }
      >
        Load overview
      </button>
      <button
        type="button"
        onClick={() =>
          void api
            .mutate(
              'POST',
              '/api/v1/admin/operations/backups',
              {},
              isAcceptedOperationResponse,
            )
            .then(() => setMessage('mutated'))
            .catch((loadError: unknown) =>
              setMessage(loadError instanceof Error ? loadError.message : 'failed'),
            )
        }
      >
        Start backup
      </button>
      <button
        type="button"
        onClick={() => {
          const controller = new AbortController();
          const promise = api
            .get('/api/v1/admin/overview', isOverviewResponse, controller.signal)
            .then(() => setMessage('unexpected'))
            .catch((loadError: unknown) =>
              setMessage(loadError instanceof DOMException ? loadError.name : 'failed'),
            );
          controller.abort();
          void promise;
        }}
      >
        Abort load
      </button>
      <button
        type="button"
        onClick={() =>
          void api
            .download('/api/v1/admin/backups/ariadne-20260923T032200Z.dump/download')
            .then(() => setMessage('downloaded'))
            .catch((loadError: unknown) =>
              setMessage(loadError instanceof Error ? loadError.message : 'failed'),
            )
        }
      >
        Download backup
      </button>
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthProvider', () => {
  it('restores the session, rotates the csrf token, and sends csrf only on mutations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          userId: 'admin-id',
          username: 'admin',
          csrfToken: 'rotated-csrf-token',
          reauthenticatedUntil: null,
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
      .mockResolvedValueOnce(
        json(
          {
            accepted: true,
            operation: {
              id: 'op-1',
              requestedBy: 'admin-id',
              type: 'backup_create',
              state: 'queued',
              summary: 'Create database backup',
              output: null,
              startedAt: null,
              completedAt: null,
              createdAt: '2026-09-23T08:01:00.000Z',
            },
          },
          202,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<ApiHarness />);

    expect(await screen.findByText('Session:admin')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Load overview' }));
    await waitFor(() => expect(screen.getByTestId('message')).toHaveTextContent('loaded'));

    await user.click(screen.getByRole('button', { name: 'Start backup' }));
    await waitFor(() => expect(screen.getByTestId('message')).toHaveTextContent('mutated'));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/admin/overview',
      expect.objectContaining({
        credentials: 'same-origin',
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty('headers');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/v1/admin/operations/backups',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-CSRF-Token': 'rotated-csrf-token',
        }),
      }),
    );
  });

  it('rejects malformed JSON responses and propagates aborts and download errors', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(
          json({
            userId: 'admin-id',
            username: 'admin',
            csrfToken: 'csrf-token',
            reauthenticatedUntil: null,
          }),
        );
      }
      if (url === '/api/v1/admin/overview' && init?.signal) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        });
      }
      if (url === '/api/v1/admin/overview') {
        return Promise.resolve(json({ generatedAt: 123 }));
      }
      if (url.endsWith('/download')) {
        return Promise.resolve(
          json(
            {
              error: {
                code: 'backup_not_verified',
                message: 'Only currently verified backups can be downloaded',
              },
            },
            409,
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<ApiHarness />);

    expect(await screen.findByText('Session:admin')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Load overview' }));
    await waitFor(() =>
      expect(screen.getByTestId('message')).toHaveTextContent('The server returned an invalid response.'),
    );

    await user.click(screen.getByRole('button', { name: 'Abort load' }));
    await waitFor(() => expect(screen.getByTestId('message')).toHaveTextContent('AbortError'));

    await user.click(screen.getByRole('button', { name: 'Download backup' }));
    await waitFor(() =>
      expect(screen.getByTestId('message')).toHaveTextContent(
        'Only currently verified backups can be downloaded',
      ),
    );
  });

  it('logs out on an expired session and keeps password and tokens out of browser storage', async () => {
    const localStorageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: { code: 'missing_session', message: 'Authentication required' } }, 401),
      )
      .mockResolvedValueOnce(
        json({
          userId: 'admin-id',
          username: 'admin',
          csrfToken: 'fresh-csrf-token',
          reauthenticatedUntil: null,
        }, 201),
      )
      .mockResolvedValueOnce(
        json({ error: { code: 'missing_session', message: 'Authentication required' } }, 401),
      );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<><LoginPage /><ApiHarness /></>);

    await user.type(await screen.findByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'top-secret-password');
    await user.click(screen.getByRole('button', { name: 'Open console' }));

    expect(await screen.findByText('Session:admin')).toBeVisible();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/admin/session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'top-secret-password' }),
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Load overview' }));
    await screen.findAllByRole('alert');
    expect(screen.getAllByRole('alert').some((element) =>
      element.textContent?.includes('Session expired. Sign in again.'),
    )).toBe(true);
    expect(await screen.findByText('Signed out')).toBeVisible();
    expect(localStorageSpy).not.toHaveBeenCalled();
  });
});
