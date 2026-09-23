import { type ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import type { TeamMember } from '../api/types';
import { MembersPage } from './MembersPage';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

function buildMembers(overrides: TeamMember[] = []): TeamMember[] {
  return overrides.length > 0
    ? overrides
    : [
        {
          userId: 'admin-id',
          username: 'ops-admin',
          role: 'admin',
          active: true,
          createdAt: '2026-09-22T08:00:00.000Z',
          immutable: true,
        },
        {
          userId: 'member-1',
          username: 'ops-member',
          role: 'member',
          active: true,
          createdAt: '2026-09-22T09:00:00.000Z',
          immutable: false,
        },
        {
          userId: 'member-2',
          username: 'dormant-user',
          role: 'member',
          active: false,
          createdAt: '2026-09-21T09:00:00.000Z',
          immutable: false,
        },
      ];
}

function renderWithProvider(child: ReactNode) {
  return render(<AuthProvider>{child}</AuthProvider>);
}

function memberRow(username: string): HTMLElement {
  const name = screen.getByText(username);
  return name.closest('tr') as HTMLElement;
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MembersPage', () => {
  it('renders active and inactive members and never shows an admin action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/admin/session') {
          return Promise.resolve(json(sessionBody(futureReauthenticatedUntil())));
        }
        if (url === '/api/v1/admin/members') {
          return Promise.resolve(json({ members: buildMembers() }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );

    renderWithProvider(<MembersPage />);

    const adminRow = await waitFor(() => memberRow('ops-admin'));
    expect(within(adminRow).queryByRole('button')).not.toBeInTheDocument();

    const activeRow = memberRow('ops-member');
    expect(within(activeRow).getByText('active')).toBeVisible();
    expect(within(activeRow).getByRole('button', { name: 'Deactivate ops-member' })).toBeVisible();

    const inactiveRow = memberRow('dormant-user');
    expect(within(inactiveRow).getByText('inactive')).toBeVisible();
    expect(within(inactiveRow).getByRole('button', { name: 'Activate dormant-user' })).toBeVisible();
  });

  it('requires the exact deactivate phrase and stale reauthentication before mutating', async () => {
    let patchCompleted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody(null)));
      }
      if (url === '/api/v1/admin/members') {
        if (!patchCompleted) {
          return Promise.resolve(json({ members: buildMembers() }));
        }
        return Promise.resolve(
          json({
            members: buildMembers([
              buildMembers()[0],
              {
                userId: 'member-1',
                username: 'ops-member',
                role: 'member',
                active: false,
                createdAt: '2026-09-22T09:00:00.000Z',
                immutable: false,
              },
              buildMembers()[2],
            ]),
          }),
        );
      }
      if (url === '/api/v1/admin/session/reauthenticate') {
        return Promise.resolve(json({ reauthenticatedUntil: '2026-09-23T08:30:00.000Z' }));
      }
      if (url === '/api/v1/admin/members/member-1') {
        patchCompleted = true;
        return Promise.resolve(
          json({
            member: {
              userId: 'member-1',
              username: 'ops-member',
              role: 'member',
              active: false,
              createdAt: '2026-09-22T09:00:00.000Z',
              immutable: false,
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<MembersPage />);

    await user.click(await screen.findByRole('button', { name: 'Deactivate ops-member' }));

    expect(await screen.findByRole('dialog', { name: 'Deactivate member' })).toBeVisible();
    expect(screen.getByLabelText('Type DEACTIVATE ops-member to continue')).toBeVisible();
    expect(screen.getByLabelText('Administrator password')).toBeVisible();

    const submit = screen.getByRole('button', { name: 'Continue operation' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Type DEACTIVATE ops-member to continue'), 'DEACTIVATE ops-member');
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Administrator password'), 'correct horse battery staple');
    await user.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/session/reauthenticate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse battery staple' }),
      }),
    ));
    expect(within(memberRow('ops-member')).getByText('inactive')).toBeVisible();
  });

  it('requires the exact activate phrase for an inactive member without showing the password field when the session is fresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/admin/session') {
            return Promise.resolve(json(sessionBody(futureReauthenticatedUntil())));
        }
        if (url === '/api/v1/admin/members') {
          return Promise.resolve(json({ members: buildMembers() }));
        }
        if (url === '/api/v1/admin/members/member-2') {
          return Promise.resolve(
            json({
              member: {
                userId: 'member-2',
                username: 'dormant-user',
                role: 'member',
                active: true,
                createdAt: '2026-09-21T09:00:00.000Z',
                immutable: false,
              },
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    const user = userEvent.setup();

    renderWithProvider(<MembersPage />);

    await user.click(await screen.findByRole('button', { name: 'Activate dormant-user' }));

    expect(await screen.findByRole('dialog', { name: 'Activate member' })).toBeVisible();
    expect(screen.getByLabelText('Type ACTIVATE dormant-user to continue')).toBeVisible();
    expect(screen.queryByLabelText('Administrator password')).not.toBeInTheDocument();
  });

  it('disables duplicate member submissions while a mutation is in flight', async () => {
    const patchRequest = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/admin/session') {
        return Promise.resolve(json(sessionBody(futureReauthenticatedUntil())));
      }
      if (url === '/api/v1/admin/members') {
        return Promise.resolve(json({ members: buildMembers() }));
      }
      if (url === '/api/v1/admin/members/member-1') {
        return patchRequest.promise;
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProvider(<MembersPage />);

    await user.click(await screen.findByRole('button', { name: 'Deactivate ops-member' }));
    await user.type(screen.getByLabelText('Type DEACTIVATE ops-member to continue'), 'DEACTIVATE ops-member');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    const busyButton = await screen.findByRole('button', { name: 'Confirming...' });
    expect(busyButton).toBeDisabled();
    await user.click(busyButton);

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/admin/members/member-1'),
    ).toHaveLength(1);

    patchRequest.resolve(
      json({
        member: {
          userId: 'member-1',
          username: 'ops-member',
          role: 'member',
          active: false,
          createdAt: '2026-09-22T09:00:00.000Z',
          immutable: false,
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Deactivate member' })).not.toBeInTheDocument());
  });

  it('preserves the previous member state when a mutation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/admin/session') {
            return Promise.resolve(json(sessionBody(futureReauthenticatedUntil())));
        }
        if (url === '/api/v1/admin/members') {
          return Promise.resolve(json({ members: buildMembers() }));
        }
        if (url === '/api/v1/admin/members/member-1') {
          return Promise.resolve(
            json(
              { error: { code: 'conflict', message: 'Another privileged action is already running.' } },
              409,
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    const user = userEvent.setup();

    renderWithProvider(<MembersPage />);

    await user.click(await screen.findByRole('button', { name: 'Deactivate ops-member' }));
    await user.type(screen.getByLabelText('Type DEACTIVATE ops-member to continue'), 'DEACTIVATE ops-member');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Another privileged action is already running.');
    expect(within(memberRow('ops-member')).getByText('active')).toBeVisible();
  });

  it('refetches server state after a successful mutation without applying an optimistic update', async () => {
    let patchCompleted = false;
    let refreshRequested = false;
    const refreshRequest = deferredResponse();

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/admin/session') {
            return Promise.resolve(json(sessionBody(futureReauthenticatedUntil())));
        }
        if (url === '/api/v1/admin/members') {
          if (!patchCompleted) {
            return Promise.resolve(json({ members: buildMembers() }));
          }
          refreshRequested = true;
          return refreshRequest.promise;
        }
        if (url === '/api/v1/admin/members/member-1') {
          patchCompleted = true;
          return Promise.resolve(
            json({
              member: {
                userId: 'member-1',
                username: 'ops-member',
                role: 'member',
                active: false,
                createdAt: '2026-09-22T09:00:00.000Z',
                immutable: false,
              },
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    const user = userEvent.setup();

    renderWithProvider(<MembersPage />);

    expect(within(await waitFor(() => memberRow('ops-member'))).getByText('active')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Deactivate ops-member' }));
    await user.type(screen.getByLabelText('Type DEACTIVATE ops-member to continue'), 'DEACTIVATE ops-member');
    await user.click(screen.getByRole('button', { name: 'Continue operation' }));

    await waitFor(() => expect(refreshRequested).toBe(true));
    expect(within(memberRow('ops-member')).getByText('active')).toBeVisible();
    refreshRequest.resolve(
      json({
        members: buildMembers([
          buildMembers()[0],
          {
            userId: 'member-1',
            username: 'ops-member',
            role: 'member',
            active: false,
            createdAt: '2026-09-22T09:00:00.000Z',
            immutable: false,
          },
          buildMembers()[2],
        ]),
      }),
    );
    await waitFor(() => expect(within(memberRow('ops-member')).getByText('inactive')).toBeVisible());
  });
});
