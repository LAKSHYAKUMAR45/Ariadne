import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupsPage } from './BackupsPage';
import { LogsPage } from './LogsPage';
import { OverviewPage } from './OverviewPage';
import { ServicesPage } from './ServicesPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

it('prioritizes live health, tasks, and backup freshness on the overview', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        generatedAt: '2026-09-23T08:00:00.000Z',
        database: { healthy: true, latencyMs: 8 },
        tasks: { total: 34, active: 4, updatedLast24h: 7 },
        backup: {
          latestAt: '2026-09-23T06:00:00.000Z',
          latestVerifiedAt: '2026-09-23T06:05:00.000Z',
          status: 'verified',
        },
        operations: { running: 1, failedLast24h: 0 },
      }),
    ),
  );

  render(<OverviewPage />);

  expect((await screen.findAllByText('Operational')).length).toBeGreaterThan(0);
  expect(screen.getByText('34')).toBeVisible();
  expect(screen.getAllByText('1 running').length).toBeGreaterThan(0);
  expect(screen.getByText('Verified')).toBeVisible();
});

it('lists backups and starts a new backup with the CSRF token', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        backups: [
          {
            filename: 'ariadne-20260923.dump',
            sha256: 'a'.repeat(64),
            sizeBytes: 4096,
            status: 'verified',
            createdAt: '2026-09-23T06:00:00.000Z',
            verifiedAt: '2026-09-23T06:05:00.000Z',
            restoreVerificationMessage: null,
          },
        ],
      }),
    )
    .mockResolvedValueOnce(
      json(
        {
          accepted: true,
          operation: { id: 'op-1', state: 'queued', summary: 'Create database backup' },
        },
        202,
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<BackupsPage csrfToken="csrf-token" />);

  expect(await screen.findByText('ariadne-20260923.dump')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Create backup' }));
  expect(await screen.findByText('Backup queued')).toBeVisible();
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/v1/admin/operations/backups',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
    }),
  );
});

it('reauthenticates in place when a backup action requires a fresh password', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ backups: [] }))
    .mockResolvedValueOnce(
      json({ error: { code: 'reauthentication_required', message: 'Password required' } }, 403),
    )
    .mockResolvedValueOnce(
      json({ reauthenticatedUntil: '2026-09-23T08:05:00.000Z' }),
    )
    .mockResolvedValueOnce(
      json(
        {
          accepted: true,
          operation: { id: 'op-1', state: 'queued', summary: 'Create database backup' },
        },
        202,
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<BackupsPage csrfToken="csrf-token" />);

  await user.click(await screen.findByRole('button', { name: 'Create backup' }));
  expect(await screen.findByRole('dialog', { name: 'Confirm administrator' })).toBeVisible();

  await user.type(screen.getByLabelText('Administrator password'), 'correct horse battery staple');
  await user.click(screen.getByRole('button', { name: 'Continue operation' }));

  expect(await screen.findByText('Backup queued')).toBeVisible();
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    '/api/v1/admin/session/reauthenticate',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    }),
  );
});

it('restarts only the sync server from the MVP service controls', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        services: [
          { name: 'sync-server', state: 'running', detail: 'Serving API requests' },
          { name: 'database', state: 'running', detail: 'PostgreSQL connection healthy' },
          { name: 'operator', state: 'available', detail: 'Privileged operations enabled' },
        ],
      }),
    )
    .mockResolvedValueOnce(
      json(
        {
          accepted: true,
          operation: { id: 'op-2', state: 'queued', summary: 'Restart sync-server service' },
        },
        202,
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();

  render(<ServicesPage csrfToken="csrf-token" />);

  expect(await screen.findByText('Serving API requests')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Restart sync server' }));
  expect(await screen.findByText('Restart queued')).toBeVisible();
});

it('shows bounded redacted operation logs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        entries: [
          {
            id: 'log-1',
            source: 'backup',
            severity: 'info',
            message: 'Backup completed; TOKEN=***',
            createdAt: '2026-09-23T06:05:00.000Z',
          },
        ],
      }),
    ),
  );

  render(<LogsPage />);

  expect(await screen.findByText('Backup completed; TOKEN=***')).toBeVisible();
  expect(screen.getByText('backup')).toBeVisible();
});
