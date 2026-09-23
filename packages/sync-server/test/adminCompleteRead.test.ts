import { mkdtemp, rm } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ADMIN_SESSION_COOKIE_NAME } from '../src/adminSessions.js';
import { createPool } from '../src/db.js';
import { createOperatorQueryClient, type OperatorQuery } from '../src/operatorQueryClient.js';
import { createOperationsStore } from '../src/operationsStore.js';
import { runMigrations } from '../src/migrate.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';
import { CORE_FIXTURE_TABLES, truncateFixtureTables } from './dbCleanup.js';
import { createTestEncryptionKeyring } from './testKeyring.js';

const PASSWORD = 'dashboard-password-123456';

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

interface FakeOperator {
  socketPath: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type QueryResponder = (
  recorded: RecordedRequest,
  query: OperatorQuery,
  res: ServerResponse,
) => void | Promise<void>;

describe('sync-server: complete admin read APIs', () => {
  let pool: Pool;
  let app: Express;
  let operator: FakeOperator;
  let queryResponder: QueryResponder;
  let adminId: string;
  let memberId: string;
  let teamId: string;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    operator = await startFakeOperator(async (recorded, query, res) => {
      await queryResponder(recorded, query, res);
    });
    app = createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      operatorClient: { submit: async () => ({ accepted: true, operationId: 'unused' }) },
      operatorQueryClient: createOperatorQueryClient({
        socketPath: operator.socketPath,
        maxDownloadBytes: 1024,
      }),
    });
  });

  afterAll(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
    await operator.close();
    await rm(path.dirname(operator.socketPath), { recursive: true, force: true });
    await pool.end();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  beforeEach(async () => {
    await truncateFixtureTables(pool, CORE_FIXTURE_TABLES);
    queryResponder = defaultQueryResponder;

    const adminRegistration = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'dashboard-admin', password: PASSWORD })
      .expect(201);
    adminId = adminRegistration.body.userId as string;

    const memberRegistration = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'dashboard-member', password: PASSWORD })
      .expect(201);
    memberId = memberRegistration.body.userId as string;

    const membership = await pool.query<{ team_id: string }>(
      `SELECT team_id FROM team_memberships WHERE user_id = $1 AND role = 'admin'`,
      [adminId],
    );
    teamId = membership.rows[0].team_id;
  });

  async function session(
    target: Express = app,
    username: string = 'dashboard-admin',
  ): Promise<{ Cookie: string; 'X-CSRF-Token': string }> {
    const login = await request(target)
      .post('/api/v1/admin/session')
      .send({ username, password: PASSWORD })
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

  async function adminRequest(pathname: string, target: Express = app) {
    return request(target).get(pathname).set(await session(target));
  }

  async function seedOverviewData(): Promise<void> {
    await pool.query(
      `INSERT INTO tasks (
         local_id, owner_user_id, title, status, team_id, created_at, updated_at
       )
       VALUES
         ('overview-active', $1, 'Active task', 'active', $2, now() - interval '1 hour', now() - interval '1 hour'),
         ('overview-done', $1, 'Done task', 'done', $2, now() - interval '3 days', now() - interval '2 days')`,
      [adminId, teamId],
    );

    await pool.query(
      `UPDATE team_memberships
          SET active = false
        WHERE team_id = $1 AND user_id = $2 AND role = 'member'`,
      [teamId, memberId],
    );

    const store = createOperationsStore(pool);
    await store.createOperation({
      id: 'op-running',
      requestedBy: adminId,
      type: 'backup_create',
      summary: 'Create backup',
      source: 'admin_api',
      createdAt: '2026-09-23T09:00:00.000Z',
    });
    await store.transitionOperation({
      id: 'op-running',
      nextState: 'running',
      source: 'operator',
      occurredAt: '2026-09-23T09:00:05.000Z',
    });
    await store.createOperation({
      id: 'op-failed',
      requestedBy: adminId,
      type: 'deployment_apply',
      summary: 'Deploy revision',
      source: 'admin_api',
      createdAt: '2026-09-23T10:00:00.000Z',
    });
    await store.transitionOperation({
      id: 'op-failed',
      nextState: 'failed',
      source: 'operator',
      occurredAt: '2026-09-23T10:00:05.000Z',
      output: 'deployment failed',
    });
    await store.upsertBackupRecord({
      filename: 'ariadne-20260923T094609Z.dump',
      sha256: 'a'.repeat(64),
      sizeBytes: 12,
      status: 'verified',
      createdAt: '2026-09-23T09:46:09.000Z',
      verifiedAt: '2026-09-23T09:47:09.000Z',
    });
  }

  it('returns the complete overview summaries and marks the response no-store', async () => {
    await seedOverviewData();

    const response = await adminRequest('/api/v1/admin/overview');
    expect(response.status).toBe(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      generatedAt: expect.any(String),
      database: { healthy: true, latencyMs: expect.any(Number) },
      host: {
        cpuPercent: 12.5,
        memoryUsedBytes: 10,
        memoryTotalBytes: 20,
        filesystemUsedBytes: 30,
        filesystemTotalBytes: 40,
      },
      databaseSizeBytes: expect.any(Number),
      tasks: { total: 2, active: 1, updatedLast24h: 1 },
      members: { total: 2, active: 1, inactive: 1, admins: 1, members: 1 },
      sync: { lastPushAt: null, lastPullAt: null },
      backup: {
        latestAt: '2026-09-23T09:46:09.000Z',
        latestVerifiedAt: '2026-09-23T09:47:09.000Z',
        status: 'verified',
      },
      operations: { running: 1, failedLast24h: 1 },
      components: {
        database: { healthy: true },
        operator: { healthy: true },
      },
    });
  });

  it('keeps database facts while reporting operator metrics unavailable', async () => {
    await seedOverviewData();
    queryResponder = async (_recorded, query, res) => {
      if (query.type === 'host_metrics') {
        jsonResponse(res, 503, { error: 'dependency_unavailable' });
        return;
      }
      await defaultQueryResponder(_recorded, query, res);
    };

    const response = await adminRequest('/api/v1/admin/overview');
    expect(response.status).toBe(200);

    expect(response.body.tasks.total).toBe(2);
    expect(response.body.host).toBeNull();
    expect(response.body.components.operator).toEqual({
      healthy: false,
      code: 'operator_unavailable',
    });
  });

  it('returns active and inactive members with the immutable admin marker', async () => {
    await pool.query(
      `UPDATE team_memberships
          SET active = false
        WHERE team_id = $1 AND user_id = $2 AND role = 'member'`,
      [teamId, memberId],
    );

    const response = await adminRequest('/api/v1/admin/members');
    expect(response.status).toBe(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.members).toEqual([
      expect.objectContaining({
        userId: adminId,
        username: 'dashboard-admin',
        role: 'admin',
        active: true,
        immutable: true,
      }),
      expect.objectContaining({
        userId: memberId,
        username: 'dashboard-member',
        role: 'member',
        active: false,
        immutable: false,
      }),
    ]);
  });

  it('downloads only verified backups with attachment headers and rejects oversized artifacts', async () => {
    const store = createOperationsStore(pool);
    await store.upsertBackupRecord({
      filename: 'ariadne-20260923T032200Z.dump',
      sha256: 'b'.repeat(64),
      sizeBytes: 12,
      status: 'verified',
      createdAt: '2026-09-23T03:22:00.000Z',
      verifiedAt: '2026-09-23T03:23:00.000Z',
    });
    await store.upsertBackupRecord({
      filename: 'ariadne-20260923T042200Z.dump',
      sha256: 'c'.repeat(64),
      sizeBytes: 2048,
      status: 'verified',
      createdAt: '2026-09-23T04:22:00.000Z',
      verifiedAt: '2026-09-23T04:23:00.000Z',
    });
    await store.upsertBackupRecord({
      filename: 'ariadne-20260923T052200Z.dump',
      sha256: 'd'.repeat(64),
      sizeBytes: 12,
      status: 'created',
      createdAt: '2026-09-23T05:22:00.000Z',
    });

    const headers = await session();

    const verified = await request(app)
      .get('/api/v1/admin/backups/ariadne-20260923T032200Z.dump/download')
      .set(headers)
      .expect(200);
    expect(verified.headers['cache-control']).toBe('no-store');
    expect(verified.headers['content-type']).toBe('application/octet-stream');
    expect(verified.headers['content-disposition']).toContain(
      'filename="ariadne-20260923T032200Z.dump"',
    );
    expect(verified.headers['x-ariadne-backup-sha256']).toBe('b'.repeat(64));
    expect(Buffer.from(verified.body).toString('utf8')).toBe('backup-bytes');

    const tooLarge = await request(app)
      .get('/api/v1/admin/backups/ariadne-20260923T042200Z.dump/download')
      .set(headers)
      .expect(502);
    expect(tooLarge.body.error.code).toBe('operator_invalid_response');

    const unverified = await request(app)
      .get('/api/v1/admin/backups/ariadne-20260923T052200Z.dump/download')
      .set(headers)
      .expect(409);
    expect(unverified.body.error.code).toBe('backup_not_verified');
  });

  it('aborts the operator backup stream when the client disconnects', async () => {
    const store = createOperationsStore(pool);
    await store.upsertBackupRecord({
      filename: 'ariadne-20260923T062200Z.dump',
      sha256: 'e'.repeat(64),
      sizeBytes: 1024,
      status: 'verified',
      createdAt: '2026-09-23T06:22:00.000Z',
      verifiedAt: '2026-09-23T06:23:00.000Z',
    });

    let destroyed = false;
    queryResponder = async (_recorded, query, res) => {
      if (query.type !== 'backup_read') {
        await defaultQueryResponder(_recorded, query, res);
        return;
      }
      const stream = new PassThrough({
        destroy(error, callback) {
          destroyed = true;
          callback(error);
        },
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', '1024');
      res.setHeader('x-ariadne-backup-sha256', 'e'.repeat(64));
      res.setHeader('content-disposition', 'attachment; filename="ariadne-20260923T062200Z.dump"');
      res.on('close', () => {
        if (!res.writableFinished && !stream.destroyed) {
          stream.destroy();
        }
      });
      stream.pipe(res);
      stream.write(Buffer.alloc(128, 'x'));
    };

    const server = app.listen(0);
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const address = server.address() as AddressInfo;
    const headers = await session();

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/api/v1/admin/backups/ariadne-20260923T062200Z.dump/download',
          headers: {
            cookie: headers.Cookie,
          },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') {
          return;
        }
        reject(error);
      });
      req.end();
    });

    for (let attempt = 0; attempt < 50 && !destroyed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(destroyed).toBe(true);
  });

  it('returns services, deployments, and bounded logs with strict query validation', async () => {
    const services = await adminRequest('/api/v1/admin/services');
    expect(services.status).toBe(200);
    expect(services.headers['cache-control']).toBe('no-store');
    expect(services.body.services).toEqual([
      {
        name: 'sync-server',
        state: 'running',
        detail: 'Serving requests',
      },
      {
        name: 'operator',
        state: 'running',
        detail: 'Socket ready',
      },
      {
        name: 'postgres',
        state: 'running',
        detail: 'Primary database available',
      },
    ]);

    const deployments = await adminRequest('/api/v1/admin/deployments');
    expect(deployments.status).toBe(200);
    expect(deployments.headers['cache-control']).toBe('no-store');
    expect(deployments.body).toMatchObject({
      currentRevision: 'a'.repeat(40),
      rollbackRevision: 'b'.repeat(40),
      schemaVersion: 8,
      candidates: [
        {
          revision: 'a'.repeat(40),
          committedAt: '2026-09-23T09:00:00.000Z',
          subject: 'Deploy current revision',
        },
      ],
    });

    const cursor = Buffer.from(
      JSON.stringify({ timestamp: '2026-09-23T09:00:00.000Z', sequence: 4 }),
      'utf8',
    ).toString('base64url');
    const logs = await adminRequest(
      `/api/v1/admin/logs?source=deployment&cursor=${encodeURIComponent(cursor)}&limit=2&severity=warning&since=${encodeURIComponent('2026-09-23T08:00:00.000Z')}`,
    );
    expect(logs.status).toBe(200);
    expect(logs.headers['cache-control']).toBe('no-store');
    expect(logs.body).toEqual({
      entries: [
        {
          sequence: 5,
          timestamp: '2026-09-23T09:05:00.000Z',
          severity: 'warning',
          message: 'deployment warning (token=***)',
          redacted: true,
        },
      ],
      nextCursor: 'next-cursor',
    });

    const recorded = operator.requests.at(-1);
    expect(recorded && JSON.parse(recorded.body)).toEqual({
      type: 'logs_read',
      source: 'deployment',
      cursor,
      limit: 2,
      severity: 'warning',
      since: '2026-09-23T08:00:00.000Z',
    });

    const invalid = await adminRequest('/api/v1/admin/logs?source=deployment&limit=501');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_request');
  });

  it('paginates and filters audit events while preserving operation linkage', async () => {
    const store = createOperationsStore(pool);
    await store.createOperation({
      id: 'op-audit-1',
      requestedBy: adminId,
      type: 'backup_verify',
      summary: 'Verify backup',
      source: 'admin_api',
      createdAt: '2026-09-23T08:00:00.000Z',
    });
    await store.transitionOperation({
      id: 'op-audit-1',
      nextState: 'failed',
      source: 'operator',
      occurredAt: '2026-09-23T08:10:00.000Z',
      output: 'verification failed',
    });
    await store.createOperation({
      id: 'op-audit-2',
      requestedBy: adminId,
      type: 'backup_create',
      summary: 'Create backup',
      source: 'admin_api',
      createdAt: '2026-09-23T08:20:00.000Z',
    });
    await store.transitionOperation({
      id: 'op-audit-2',
      nextState: 'failed',
      source: 'operator',
      occurredAt: '2026-09-23T08:30:00.000Z',
      output: 'creation failed',
    });

    const first = await adminRequest(
      '/api/v1/admin/audit?limit=1&action=admin_operation.state_changed&outcome=failed',
    );
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body.events).toHaveLength(1);
    expect(first.body.events[0]).toMatchObject({
      action: 'admin_operation.state_changed',
      outcome: 'failed',
      metadata: expect.objectContaining({ operationId: 'op-audit-2' }),
    });
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await adminRequest(
      `/api/v1/admin/audit?limit=1&action=admin_operation.state_changed&outcome=failed&cursor=${first.body.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.events).toHaveLength(1);
    expect(second.body.events[0].metadata.operationId).toBe('op-audit-1');
  });

  it('returns 503 when the overview database summary fails instead of faking emptiness', async () => {
    const failingPool = createSelectiveFailurePool(pool, (queryText) =>
      queryText.includes('pg_database_size') || queryText.includes('FROM tasks'),
    );
    const failingApp = createApp(failingPool as Pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      operatorClient: { submit: async () => ({ accepted: true, operationId: 'unused' }) },
      operatorQueryClient: createOperatorQueryClient({
        socketPath: operator.socketPath,
        maxDownloadBytes: 1024,
      }),
    });

    const response = await adminRequest('/api/v1/admin/overview', failingApp);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('database_unavailable');
  });

  async function startFakeOperator(
    handler: QueryResponder,
  ): Promise<FakeOperator> {
    const dir = await mkdtemp(path.join(tmpdir(), 'ariadne-admin-read-'));
    const socketPath = path.join(dir, 'operator.sock');
    const requests: RecordedRequest[] = [];

    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const recorded: RecordedRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          body,
        };
        requests.push(recorded);
        await handler(recorded, JSON.parse(body) as OperatorQuery, res);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    return {
      socketPath,
      requests,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  async function defaultQueryResponder(
    _recorded: RecordedRequest,
    query: OperatorQuery,
    res: ServerResponse,
  ): Promise<void> {
    switch (query.type) {
      case 'host_metrics':
        jsonResponse(res, 200, {
          type: 'host_metrics',
          value: {
            cpuPercent: 12.5,
            memoryUsedBytes: 10,
            memoryTotalBytes: 20,
            filesystemUsedBytes: 30,
            filesystemTotalBytes: 40,
          },
        });
        return;
      case 'service_status':
        jsonResponse(res, 200, {
          type: 'service_status',
          value: {
            services: [
              { name: 'sync-server', state: 'running', detail: 'Serving requests' },
              { name: 'operator', state: 'running', detail: 'Socket ready' },
              { name: 'postgres', state: 'running', detail: 'Primary database available' },
            ],
          },
        });
        return;
      case 'deployment_status':
        jsonResponse(res, 200, {
          type: 'deployment_status',
          value: {
            currentRevision: 'a'.repeat(40),
            rollbackRevision: 'b'.repeat(40),
            schemaVersion: 8,
            candidates: [
              {
                revision: 'a'.repeat(40),
                committedAt: '2026-09-23T09:00:00.000Z',
                subject: 'Deploy current revision',
              },
            ],
          },
        });
        return;
      case 'logs_read':
        jsonResponse(res, 200, {
          type: 'logs_read',
          value: {
            entries: [
              {
                sequence: 5,
                timestamp: '2026-09-23T09:05:00.000Z',
                severity: 'warning',
                message: 'deployment warning (token=***)',
                redacted: true,
              },
            ],
            nextCursor: 'next-cursor',
          },
        });
        return;
      case 'backup_read':
        if (query.backupName === 'ariadne-20260923T042200Z.dump') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('content-length', '2048');
          res.setHeader('x-ariadne-backup-sha256', 'c'.repeat(64));
          res.setHeader('content-disposition', `attachment; filename="${query.backupName}"`);
          res.end('x');
          return;
        }

        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-length', '12');
        res.setHeader(
          'x-ariadne-backup-sha256',
          query.backupName === 'ariadne-20260923T062200Z.dump' ? 'e'.repeat(64) : 'b'.repeat(64),
        );
        res.setHeader('content-disposition', `attachment; filename="${query.backupName}"`);
        Readable.from(['backup-bytes']).pipe(res);
        return;
    }
  }
});

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function createSelectiveFailurePool(
  pool: Pool,
  shouldFail: (queryText: string) => boolean,
): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') {
        return async (text: string, values?: unknown[]) => {
          if (shouldFail(text)) {
            throw new Error('forced database failure');
          }
          return target.query(text, values);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as Pool;
}
