import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ariadne operations console', () => {
  it('shows only the admin login when no session exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'unauthorized', message: 'Authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
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
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            userId: 'admin-id',
            username: 'admin',
            reauthenticatedUntil: null,
            csrfToken: 'csrf-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText('nodem2 / production')).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'System overview' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(screen.getByRole('heading', { name: 'Task history' })).toBeVisible();
    expect(screen.getByText('Select a task to inspect its timeline and captured files.')).toBeVisible();
  });

  it('logs out from the console and returns to the login screen', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            userId: 'admin-id',
            username: 'admin',
            reauthenticatedUntil: null,
            csrfToken: 'csrf-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            generatedAt: '2026-09-23T08:00:00.000Z',
            database: { healthy: true, latencyMs: 4 },
            tasks: { total: 0, active: 0, updatedLast24h: 0 },
            backup: { latestAt: null, latestVerifiedAt: null, status: 'unavailable' },
            operations: { running: 0, failedLast24h: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
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
});
