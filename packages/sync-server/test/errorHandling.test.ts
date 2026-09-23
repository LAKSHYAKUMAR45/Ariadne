import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ADMIN_SESSION_COOKIE_NAME } from '../src/adminSessions.js';
import { signToken } from '../src/auth.js';
import { TEST_JWT_SECRET } from './testConfig.js';
import { createTestEncryptionKeyring } from './testKeyring.js';

interface QueryResultShape<TRow> {
  rows: TRow[];
}

function result<TRow>(rows: TRow[]): QueryResultShape<TRow> {
  return { rows };
}

function createPoolWithQuery(query: Pool['query']): Pool {
  return {
    query,
    connect: vi.fn(),
  } as unknown as Pool;
}

function createPoolWithClient(query: Pool['query'], client: PoolClient): Pool {
  return {
    query,
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function expectInternalErrorResponse(response: request.Response, leakedValues: string[]): void {
  expect(response.status).toBe(500);
  expect(response.headers['content-type']).toMatch(/application\/json/);
  expect(response.body).toEqual({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred',
    },
  });

  const responseText = response.text;
  for (const leakedValue of leakedValues) {
    expect(responseText).not.toContain(leakedValue);
  }
}

function expectInvalidRequestResponse(response: request.Response): void {
  expect(response.status).toBe(400);
  expect(response.headers['content-type']).toMatch(/application\/json/);
  expect(response.body).toEqual({
    error: {
      code: 'invalid_request',
      message: 'Invalid request body',
    },
  });
}

function activeAdminSessionRow(csrfToken: string) {
  return {
    id: 'session-1',
    user_id: 'admin-1',
    csrf_hash: createHash('sha256').update(csrfToken).digest('hex'),
    expires_at: new Date('2126-09-21T00:00:00Z'),
    reauthenticated_until: null,
    revoked_at: null,
    created_at: new Date('2026-09-21T00:00:00Z'),
    last_seen_at: new Date('2026-09-21T00:00:00Z'),
  };
}

function postgresFailure(message: string) {
  return Object.assign(new Error(message), {
    code: '57P01',
    severity: 'ERROR',
    routine: 'ExecProcNode',
  });
}

describe('sync-server: unexpected error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a sanitized JSON 500 when registration hits an unexpected service error', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = {
      query: vi
        .fn<PoolClient['query']>()
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([]))
        .mockRejectedValueOnce(
          new Error('SQLSTATE 42P01 relation "users" from /srv/db/registration.sql'),
        )
        .mockResolvedValueOnce(result([])),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = createPoolWithClient(
      vi.fn<Pool['query']>().mockResolvedValue(result([])),
      client,
    );
    const app = createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
    });

    const response = await request(app).post('/api/v1/auth/register').send({
      username: 'alice',
      password: 'super-secret-password',
    });

    expectInternalErrorResponse(response, [
      'SQLSTATE',
      '42P01',
      '/srv/db/registration.sql',
      'super-secret-password',
    ]);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain('Unhandled');
    expect(logSpy.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      path: '/api/v1/auth/register',
      userId: null,
    });
    expect(logSpy.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('returns 404 member_not_found when the member disappears mid-update', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sessionToken = 'a'.repeat(64);
    const csrfToken = 'b'.repeat(64);
    const query = vi
      .fn<Pool['query']>()
      // 1-2. first /api/v1/admin mount auth + admin recheck
      // 3-4. second /api/v1/admin mount auth + admin recheck
      // 5. members router admin check, 6. member read, 7. member update.
      .mockResolvedValueOnce(
        result([
          {
            id: 'session-1',
            user_id: 'admin-1',
            csrf_hash: createHash('sha256').update(csrfToken).digest('hex'),
            expires_at: new Date('2126-09-21T00:00:00Z'),
            reauthenticated_until: null,
            revoked_at: null,
            created_at: new Date('2026-09-21T00:00:00Z'),
            last_seen_at: new Date('2026-09-21T00:00:00Z'),
          },
        ]),
      )
      .mockResolvedValueOnce(result([{ teamId: 'team-1', role: 'admin' as const }]))
      .mockResolvedValueOnce(
        result([
          {
            id: 'session-1',
            user_id: 'admin-1',
            csrf_hash: createHash('sha256').update(csrfToken).digest('hex'),
            expires_at: new Date('2126-09-21T00:00:00Z'),
            reauthenticated_until: null,
            revoked_at: null,
            created_at: new Date('2026-09-21T00:00:00Z'),
            last_seen_at: new Date('2026-09-21T00:00:00Z'),
          },
        ]),
      )
      .mockResolvedValueOnce(result([{ teamId: 'team-1', role: 'admin' as const }]))
      .mockResolvedValueOnce(result([{ teamId: 'team-1', role: 'admin' as const }]))
      .mockResolvedValueOnce(
        result([
          {
            userId: 'member-1',
            username: 'member',
            role: 'member' as const,
            active: true,
            createdAt: new Date('2026-09-21T00:00:00Z'),
          },
        ]),
      )
      .mockResolvedValueOnce(result([]));
    const pool = createPoolWithQuery(query);
    const app = createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
    });

    const response = await request(app)
      .patch('/api/v1/admin/members/member-1')
      .set('Cookie', `${ADMIN_SESSION_COOKIE_NAME}=${sessionToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ active: false });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'member_not_found',
        message: 'No team member with userId member-1',
      },
    });
    expect(response.text).not.toContain('returned no row');
    expect(response.text).not.toContain('/home/lkumar');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns a stable 400 invalid_request for malformed JSON and does not leak parser details', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp(
      createPoolWithQuery(vi.fn<Pool['query']>().mockResolvedValue(result([]))),
      TEST_JWT_SECRET,
      { encryptionKeyring: createTestEncryptionKeyring() },
    );
    const malformedBody = '{"password":s3cr3t}';

    const response = await request(app)
      .post('/api/v1/auth/register')
      .set('Content-Type', 'application/json')
      .send(malformedBody);

    expectInvalidRequestResponse(response);
    expect(response.text).not.toContain(malformedBody);
    expect(response.text).not.toContain('s3cr3t');
    expect(response.text).not.toContain('Unexpected token');
    expect(response.text).not.toContain('SyntaxError');
    expect(response.text).not.toContain('stack');
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain('Malformed JSON request');
    expect(logSpy.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      path: '/api/v1/auth/register',
      userId: null,
    });
    expect(logSpy.mock.calls[0][1]).not.toHaveProperty('body');

    // V8 parser messages can echo raw request fragments (including secrets),
    // so the log payload must never carry the parser message or the body.
    const loggedPayload = JSON.stringify(logSpy.mock.calls[0][1]);
    expect(loggedPayload).not.toContain('s3cr3t');
    expect(loggedPayload).not.toContain('password');
    expect(loggedPayload).not.toContain(malformedBody);
    expect(loggedPayload).not.toContain('Unexpected token');
  });

  it('translates admin database failures to 503 database_unavailable with no-store', async () => {
    const sessionToken = 'c'.repeat(64);
    const csrfToken = 'd'.repeat(64);
    const query = vi
      .fn<Pool['query']>()
      .mockRejectedValueOnce(postgresFailure('admin session lookup failed'));
    const app = createApp(createPoolWithQuery(query), TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
    });

    const response = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', `${ADMIN_SESSION_COOKIE_NAME}=${sessionToken}`)
      .set('X-CSRF-Token', csrfToken);

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      error: {
        code: 'database_unavailable',
        message: 'Database is unavailable',
      },
    });
  });
});
