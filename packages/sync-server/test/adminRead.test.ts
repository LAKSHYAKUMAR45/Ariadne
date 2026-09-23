import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ADMIN_SESSION_COOKIE_NAME } from '../src/adminSessions.js';
import { createOperationsStore } from '../src/operationsStore.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';
import { CORE_FIXTURE_TABLES, truncateFixtureTables } from './dbCleanup.js';
import { createTestEncryptionKeyring } from './testKeyring.js';

const PASSWORD = 'dashboard-password-123456';

describe('sync-server: admin dashboard read APIs', () => {
  let pool: Pool;
  let app: Express;
  let adminId: string;
  let teamId: string;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    app = createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      operatorClient: { submit: async () => ({ accepted: true, operationId: 'unused' }) },
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateFixtureTables(pool, CORE_FIXTURE_TABLES);
    const registration = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'dashboard-admin', password: PASSWORD })
      .expect(201);
    adminId = registration.body.userId as string;
    const membership = await pool.query<{ team_id: string }>(
      `SELECT team_id FROM team_memberships WHERE user_id = $1 AND role = 'admin'`,
      [adminId],
    );
    teamId = membership.rows[0].team_id;
  });

  async function session(): Promise<{ Cookie: string; 'X-CSRF-Token': string }> {
    const login = await request(app)
      .post('/api/v1/admin/session')
      .send({ username: 'dashboard-admin', password: PASSWORD })
      .expect(201);
    const setCookie = (login.headers['set-cookie'] as string[]).find((value) =>
      value.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`),
    );
    if (!setCookie) {
      throw new Error('missing admin session cookie');
    }
    return {
      Cookie: setCookie.slice(0, setCookie.indexOf(';')),
      'X-CSRF-Token': login.body.csrfToken as string,
    };
  }

  it('requires the admin session and marks successful reads no-store', async () => {
    const unauthenticated = await request(app).get('/api/v1/admin/overview');
    expect(unauthenticated.status).toBe(401);

    const headers = await session();
    await pool.query(
      `INSERT INTO tasks (
         local_id, owner_user_id, title, status, team_id, created_at, updated_at
       ) VALUES ('overview-task', $1, 'Overview task', 'active', $2, now(), now())`,
      [adminId, teamId],
    );
    const response = await request(app).get('/api/v1/admin/overview').set(headers).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      generatedAt: expect.any(String),
      database: { healthy: true, latencyMs: expect.any(Number) },
      tasks: { total: 1, active: 1, updatedLast24h: 1 },
      backup: { latestAt: null, latestVerifiedAt: null, status: 'unavailable' },
      operations: { running: 0, failedLast24h: 0 },
    });
  });

  it('returns bounded backups and validates read query parameters', async () => {
    const store = createOperationsStore(pool);
    await store.upsertBackupRecord({
      filename: 'ariadne-20260923T010000Z.dump',
      sha256: 'a'.repeat(64),
      sizeBytes: 12,
      status: 'verified',
      createdAt: '2026-09-23T01:00:00Z',
      verifiedAt: '2026-09-23T01:01:00Z',
    });

    const headers = await session();
    const backups = await request(app)
      .get('/api/v1/admin/backups?limit=1')
      .set(headers)
      .expect(200);
    expect(backups.headers['cache-control']).toBe('no-store');
    expect(backups.body.backups).toHaveLength(1);
    expect(backups.body.backups[0].verifiedAt).toBe('2026-09-23T01:01:00.000Z');

    const invalid = await request(app)
      .get('/api/v1/admin/logs?source=journal&limit=201')
      .set(headers)
      .expect(400);
    expect(invalid.body.error.code).toBe('invalid_request');
  });

  it('returns only persisted application operation logs by fixed source', async () => {
    const store = createOperationsStore(pool);
    await store.createOperation({
      id: 'backup-op',
      requestedBy: adminId,
      type: 'backup_create',
      summary: 'Create database backup',
      source: 'test',
    });
    await store.transitionOperation({
      id: 'backup-op',
      nextState: 'running',
      source: 'test',
      output: 'backup output',
    });
    await store.transitionOperation({
      id: 'backup-op',
      nextState: 'succeeded',
      source: 'test',
      output: 'backup output',
    });
    const headers = await session();
    const response = await request(app)
      .get('/api/v1/admin/logs?source=backup&limit=10')
      .set(headers)
      .expect(200);
    expect(response.body.entries).toEqual([
      expect.objectContaining({
        id: 'backup-op',
        source: 'backup',
        severity: 'info',
        message: 'backup output',
        createdAt: expect.any(String),
      }),
    ]);
    expect(response.body.entries[0].path).toBeUndefined();
  });

  it('reports database and operator service facts without claiming systemd state', async () => {
    const headers = await session();
    const response = await request(app).get('/api/v1/admin/services').set(headers).expect(200);
    expect(response.body.services).toEqual([
      {
        name: 'sync-server',
        state: 'running',
        detail: 'The sync server is serving this request',
      },
      {
        name: 'database',
        state: 'available',
        detail: expect.stringContaining('Database query succeeded'),
      },
      {
        name: 'operator',
        state: 'available',
        detail: 'The operator client is configured',
      },
    ]);
  });
});
