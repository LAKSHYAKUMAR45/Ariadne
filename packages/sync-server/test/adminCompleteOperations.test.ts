import { createHash } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ADMIN_SESSION_COOKIE_NAME } from '../src/adminSessions.js';
import { createPool } from '../src/db.js';
import { OperatorClientError, type OperatorSubmitRequest } from '../src/operatorClient.js';
import type { OperatorQuery } from '../src/operatorQueryClient.js';
import { createOperationsStore } from '../src/operationsStore.js';
import { confirmationFor } from '../src/operationConfirmation.js';
import { createTaskHistoryStore } from '../src/taskHistoryStore.js';
import { runMigrations } from '../src/migrate.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';
import { CORE_FIXTURE_TABLES, truncateFixtureTables } from './dbCleanup.js';
import { createTestEncryptionKeyring } from './testKeyring.js';

const PASSWORD = 'dashboard-password-123456';
const DEPLOYABLE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);
const DIFFERENT_SHA = 'c'.repeat(40);
const VERIFIED_BACKUP = 'ariadne-20260923T094609Z.dump';

interface AdminHeaders {
  Cookie: string;
  'X-CSRF-Token': string;
}

describe('sync-server: complete admin mutation APIs', () => {
  let pool: Pool;
  let app: Express;
  let adminUserId: string;
  let memberUserId: string;
  let teamId: string;
  let memberBearer: string;
  let operatorRequests: OperatorSubmitRequest[];
  let operatorQueryRequests: OperatorQuery[];
  let operatorMode: 'accept' | 'busy';
  let deploymentStatus = {
    currentRevision: 'f'.repeat(40),
    rollbackRevision: ROLLBACK_SHA,
    schemaVersion: 10,
    candidates: [
      {
        revision: DEPLOYABLE_SHA,
        committedAt: '2026-09-23T09:00:00Z',
        subject: 'feat: ready',
      },
    ],
  };

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateFixtureTables(pool, CORE_FIXTURE_TABLES);
    operatorRequests = [];
    operatorQueryRequests = [];
    operatorMode = 'accept';
    deploymentStatus = {
      currentRevision: 'f'.repeat(40),
      rollbackRevision: ROLLBACK_SHA,
      schemaVersion: 10,
      candidates: [
        {
          revision: DEPLOYABLE_SHA,
          committedAt: '2026-09-23T09:00:00Z',
          subject: 'feat: ready',
        },
      ],
    };

    app = createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      operatorClient: {
        submit: async (submitted) => {
          operatorRequests.push(submitted);
          if (operatorMode === 'busy') {
            throw new OperatorClientError(
              'operator_busy',
              409,
              'Another operator operation is already running',
            );
          }
          return { accepted: true, operationId: submitted.operationId };
        },
      },
      operatorQueryClient: {
        query: async (submitted) => {
          operatorQueryRequests.push(submitted);
          switch (submitted.type) {
            case 'deployment_status':
              return deploymentStatus;
            case 'host_metrics':
              return {
                cpuPercent: 1,
                memoryUsedBytes: 1,
                memoryTotalBytes: 2,
                filesystemUsedBytes: 3,
                filesystemTotalBytes: 4,
              };
            case 'service_status':
              return {
                services: [
                  { name: 'sync-server', state: 'running' },
                  { name: 'operator', state: 'running' },
                  { name: 'postgres', state: 'running' },
                ],
              };
            case 'logs_read':
              return { entries: [], nextCursor: null };
          }
        },
        downloadBackup: async () => {
          throw new Error('downloadBackup not used in this suite');
        },
      },
    });

    const adminRegistration = await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'ops-admin', password: PASSWORD })
      .expect(201);
    adminUserId = adminRegistration.body.userId as string;

    await request(app)
      .post('/api/v1/auth/register')
      .send({ username: 'ops-member', password: PASSWORD })
      .expect(201);
    const memberLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'ops-member', password: PASSWORD })
      .expect(200);
    memberBearer = memberLogin.body.token as string;

    const ids = await pool.query<{
      team_id: string;
      user_id: string;
      username: string;
    }>(
      `SELECT tm.team_id, tm.user_id, u.username
         FROM team_memberships tm
         JOIN users u ON u.id = tm.user_id
        ORDER BY u.username ASC`,
    );
    teamId = ids.rows[0].team_id;
    memberUserId = ids.rows.find((row) => row.username === 'ops-member')!.user_id;
  });

  async function openAdminSession(username = 'ops-admin'): Promise<AdminHeaders> {
    const login = await request(app)
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

  async function reauthenticate(headers: AdminHeaders): Promise<void> {
    await request(app)
      .post('/api/v1/admin/session/reauthenticate')
      .set(headers)
      .send({ password: PASSWORD })
      .expect(200);
  }

  async function reauthenticatedAdminHeaders(): Promise<AdminHeaders> {
    const headers = await openAdminSession();
    await reauthenticate(headers);
    return headers;
  }

  async function seedTaskCapture(
    captureId = 'capture-1234',
  ): Promise<{ taskId: string; captureId: string; plaintext: string }> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (
         local_id,
         owner_user_id,
         title,
         goal,
         status,
         branch,
         workspace_label,
         team_id,
         created_at,
         updated_at
       )
       VALUES (
         'task-ops-1',
         $1,
         'Ops task',
         'goal',
         'active',
         'main',
         'laptop:repo',
         $2,
         '2026-09-23T09:00:00Z',
         '2026-09-23T09:00:00Z'
       )
       RETURNING id`,
      [adminUserId, teamId],
    );
    const taskId = rows[0].id;
    const plaintext = 'do-not-store-this-plaintext';
    const content = Buffer.from(plaintext, 'utf8');
    await createTaskHistoryStore(pool, createTestEncryptionKeyring()).storeCapture({
      captureId,
      teamId,
      taskId,
      trigger: 'explicit',
      gitCommitSha: null,
      checkpointId: null,
      createdAt: '2026-09-23T09:10:00Z',
      entries: [
        {
          path: 'src/secret.ts',
          content,
          unifiedDiff: Buffer.from('+redacted\n', 'utf8'),
          contentSha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
    });
    return { taskId, captureId, plaintext };
  }

  it('builds exact destructive confirmation phrases', () => {
    expect(confirmationFor.serviceRestart('postgres')).toBe('RESTART postgres');
    expect(confirmationFor.restore(VERIFIED_BACKUP)).toBe(`RESTORE ${VERIFIED_BACKUP}`);
    expect(confirmationFor.deploy(DEPLOYABLE_SHA)).toBe(`DEPLOY ${DEPLOYABLE_SHA}`);
    expect(confirmationFor.rollback(ROLLBACK_SHA)).toBe(`ROLLBACK ${ROLLBACK_SHA}`);
    expect(confirmationFor.captureDelete('capture-1234')).toBe('DELETE capture-1234');
    expect(confirmationFor.memberState('alice', false)).toBe('DEACTIVATE alice');
  });

  it('rejects stale reauthentication before a member mutation', async () => {
    const staleHeaders = await openAdminSession();

    const response = await request(app)
      .patch(`/api/v1/admin/members/${memberUserId}`)
      .set(staleHeaders)
      .send({
        active: false,
        confirmation: confirmationFor.memberState('ops-member', false),
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('reauthentication_required');
  });

  it('rejects member bearer tokens and immutable admin mutations', async () => {
    const headers = await reauthenticatedAdminHeaders();

    const bearer = await request(app)
      .patch(`/api/v1/admin/members/${memberUserId}`)
      .set({ Authorization: `Bearer ${memberBearer}` })
      .send({
        active: false,
        confirmation: confirmationFor.memberState('ops-member', false),
      });
    expect(bearer.status).toBe(401);
    expect(bearer.body.error.code).toBe('missing_session');

    const immutable = await request(app)
      .patch(`/api/v1/admin/members/${adminUserId}`)
      .set(headers)
      .send({
        active: false,
        confirmation: confirmationFor.memberState('ops-admin', false),
      });
    expect(immutable.status).toBe(409);
    expect(immutable.body.error.code).toBe('admin_immutable');
  });

  it('reactivates an inactive member and records a same-transaction audit event', async () => {
    await pool.query(
      `UPDATE team_memberships
          SET active = false
        WHERE team_id = $1 AND user_id = $2 AND role = 'member'`,
      [teamId, memberUserId],
    );
    const headers = await reauthenticatedAdminHeaders();

    const response = await request(app)
      .patch(`/api/v1/admin/members/${memberUserId}`)
      .set(headers)
      .send({
        active: true,
        confirmation: confirmationFor.memberState('ops-member', true),
      });

    expect(response.status).toBe(200);
    expect(response.body.member).toMatchObject({
      userId: memberUserId,
      username: 'ops-member',
      role: 'member',
      active: true,
      immutable: false,
    });

    const { rows } = await pool.query<{
      action: string;
      metadata: { userId: string; username: string };
    }>(
      `SELECT action, metadata
         FROM admin_audit_events
        WHERE action LIKE 'member.%'
        ORDER BY id DESC`,
    );
    expect(rows[0]).toMatchObject({
      action: 'member.activate',
      metadata: { userId: memberUserId, username: 'ops-member' },
    });
  });

  it('rejects restore when the selected backup is not currently verified', async () => {
    await createOperationsStore(pool).upsertBackupRecord({
      filename: VERIFIED_BACKUP,
      sha256: 'd'.repeat(64),
      sizeBytes: 1024,
      status: 'created',
      createdAt: '2026-09-23T09:46:09Z',
    });
    const headers = await reauthenticatedAdminHeaders();

    const response = await request(app)
      .post(`/api/v1/admin/operations/backups/${VERIFIED_BACKUP}/restore`)
      .set(headers)
      .send({ confirmation: confirmationFor.restore(VERIFIED_BACKUP) });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('backup_not_verified');
    expect(operatorRequests).toEqual([]);
    expect((await createOperationsStore(pool).listOperations({ limit: 10 })).operations).toEqual([]);
  });

  it('rejects a deploy revision that is not in the latest eligible candidates', async () => {
    const headers = await reauthenticatedAdminHeaders();

    const response = await request(app)
      .post('/api/v1/admin/operations/deploy')
      .set(headers)
      .send({
        revision: DIFFERENT_SHA,
        confirmation: confirmationFor.deploy(DIFFERENT_SHA),
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('deployment_revision_not_allowed');
    expect(operatorRequests).toEqual([]);
    expect(operatorQueryRequests).toEqual([{ type: 'deployment_status' }]);
  });

  it('rejects a rollback revision that does not exactly match the eligible rollback', async () => {
    const headers = await reauthenticatedAdminHeaders();

    const response = await request(app)
      .post('/api/v1/admin/operations/rollback')
      .set(headers)
      .send({
        revision: DIFFERENT_SHA,
        confirmation: confirmationFor.rollback(DIFFERENT_SHA),
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('rollback_revision_not_allowed');
    expect(operatorRequests).toEqual([]);
    expect(operatorQueryRequests).toEqual([{ type: 'deployment_status' }]);
  });

  it('returns operator busy conflicts for guarded destructive operations', async () => {
    operatorMode = 'busy';
    const headers = await reauthenticatedAdminHeaders();

    const response = await request(app)
      .post('/api/v1/admin/operations/service-restart')
      .set(headers)
      .send({
        service: 'postgres',
        confirmation: confirmationFor.serviceRestart('postgres'),
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('operator_busy');
    const { operations } = await createOperationsStore(pool).listOperations({ limit: 10 });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ type: 'service_restart', state: 'failed' });
  });

  it('tracks local capture deletion without persisting plaintext file data or credentials', async () => {
    const { taskId, captureId, plaintext } = await seedTaskCapture();
    const headers = await reauthenticatedAdminHeaders();

    const response = await request(app)
      .delete(`/api/v1/admin/tasks/${taskId}/file-captures/${captureId}`)
      .set(headers)
      .send({ confirmation: confirmationFor.captureDelete(captureId) });

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);
    expect(response.body.operation).toMatchObject({
      type: 'file_capture_delete',
      state: 'succeeded',
    });
    expect(operatorRequests).toEqual([]);

    const historyStore = createTaskHistoryStore(pool, createTestEncryptionKeyring());
    await expect(historyStore.readCapture(teamId, taskId, captureId)).rejects.toMatchObject({
      status: 404,
      code: 'capture_not_found',
    });

    const operationId = response.body.operation.id as string;
    const events = await createOperationsStore(pool).listOperationEvents(operationId);
    const audit = await createOperationsStore(pool).listAuditEvents({ limit: 20 });
    const serialized = JSON.stringify({ events, audit: audit.events });

    expect(serialized).toContain(taskId);
    expect(serialized).toContain(captureId);
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain('src/secret.ts');
    expect(serialized).not.toContain(PASSWORD);
  });
});
