import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  handleUnexpectedError,
  requireAdminSession,
  requireAuth,
  requireCsrf,
} from '../src/middleware.js';
import { ADMIN_SESSION_COOKIE_NAME } from '../src/adminSessions.js';
import { confirmationFor } from '../src/operationConfirmation.js';
import { createOperatorClient, type OperatorClient } from '../src/operatorClient.js';
import {
  createOperationsStore,
  type AdminOperationType,
  type OperationsStore,
} from '../src/operationsStore.js';
import {
  ADMIN_OPERATION_SOURCE,
  createAdminOperationsRouter,
  createOperatorCallbackRouter,
} from '../src/routes/adminOperations.js';
import { createTaskHistoryRouter } from '../src/routes/taskHistory.js';
import { createTaskHistoryStore } from '../src/taskHistoryStore.js';
import { hashPassword, signToken } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';
import { TASK_HISTORY_FIXTURE_TABLES, truncateFixtureTables } from './dbCleanup.js';
import { createTestEncryptionKeyring } from './testKeyring.js';
import {
  relaxSingletonTeamConstraints,
  restoreSingletonTeamConstraints,
} from './singletonConstraints.js';


/**
 * The dashboard password shared by every admin fixture. The browser-facing
 * admin API no longer accepts the sync bearer JWT, so these suites open a real
 * database-backed session instead.
 */
const DASHBOARD_PASSWORD = 'dashboard-password-123456';

/**
 * Cookie plus CSRF header for an opened admin session. Both are sent on every
 * request: the CSRF header is ignored on safe methods and required on every
 * state change.
 */
interface AdminSessionHeaders {
  Cookie: string;
  'X-CSRF-Token': string;
}

async function openAdminSession(
  target: Express,
  username: string,
  password: string = DASHBOARD_PASSWORD,
): Promise<AdminSessionHeaders> {
  const res = await request(target)
    .post('/api/v1/admin/session')
    .send({ username, password })
    .expect(201);

  const setCookieHeader = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
  const cookie = cookies.find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`));
  if (!cookie) {
    throw new Error('admin login did not set a session cookie');
  }

  return {
    Cookie: cookie.slice(0, cookie.indexOf(';')),
    'X-CSRF-Token': res.body.csrfToken as string,
  };
}

async function reauthenticateAdminSession(
  target: Express,
  headers: AdminSessionHeaders,
  password: string = DASHBOARD_PASSWORD,
): Promise<void> {
  await request(target)
    .post('/api/v1/admin/session/reauthenticate')
    .set(headers)
    .send({ password })
    .expect(200);
}

describe('sync-server: auth + sync routes', () => {
  let pool: Pool;
  let app: Express;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    // Task 3 needs cross-team fixtures even though registration still creates
    // a single default team in production today.
    await relaxSingletonTeamConstraints(pool);
    app = createApp(pool, TEST_JWT_SECRET, { encryptionKeyring: createTestEncryptionKeyring() });
  });

  afterAll(async () => {
    await restoreSingletonTeamConstraints(pool);
    await pool.end();
  });

  beforeEach(async () => {
    // Isolate each test: wipe all sync-relevant tables (CASCADE handles FKs).
    await truncateFixtureTables(pool, TASK_HISTORY_FIXTURE_TABLES);
  });

  async function registerAndLogin(username = 'alice', password = 'hunter2') {
    await request(app).post('/api/v1/auth/register').send({ username, password }).expect(201);
    const loginRes = await request(app).post('/api/v1/auth/login').send({ username, password }).expect(200);
    return loginRes.body.token as string;
  }

  async function createDirectTeam(name: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO teams (singleton_key, name) VALUES ($1, $2) RETURNING id',
      [null, name],
    );
    return rows[0].id;
  }

  /**
   * Creates a user directly. `password` is only needed for fixtures that open
   * a dashboard session; sync-only fixtures keep the cheap placeholder hash.
   */
  async function createDirectUser(
    username: string,
    password?: string,
  ): Promise<{ userId: string; authHeader: { Authorization: string } }> {
    const passwordHash = password ? await hashPassword(password) : `hash-${username}`;
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, passwordHash],
    );
    const userId = rows[0].id;
    const token = signToken({ sub: userId, username }, TEST_JWT_SECRET);
    return { userId, authHeader: { Authorization: `Bearer ${token}` } };
  }

  async function addMembership(
    teamId: string,
    userId: string,
    role: 'admin' | 'member' = 'member',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role, active)
       VALUES ($1, $2, $3, true)`,
      [teamId, userId, role],
    );
  }

  async function createDirectTask(options: {
    taskId: string;
    teamId: string;
    ownerUserId: string;
    localId: string;
    title: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO tasks (id, local_id, owner_user_id, title, goal, status, branch, workspace_label, created_at, updated_at, team_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)`,
      [
        options.taskId,
        options.localId,
        options.ownerUserId,
        options.title,
        null,
        'active',
        null,
        null,
        '2026-09-21T00:00:00Z',
        options.teamId,
      ],
    );
  }

  describe('auth', () => {
    it('registers users with singleton-team roles', async () => {
      const first = await request(app)
        .post('/api/v1/auth/register')
        .send({ username: 'bob', password: 'pw123456' });
      expect(first.status).toBe(201);
      expect(first.body.username).toBe('bob');
      expect(first.body.userId).toBeTruthy();
      expect(first.body.role).toBe('admin');
      expect(first.body.teamId).toBeUndefined();

      const second = await request(app)
        .post('/api/v1/auth/register')
        .send({ username: 'carol', password: 'pw123456' });
      expect(second.status).toBe(201);
      expect(second.body.username).toBe('carol');
      expect(second.body.userId).toBeTruthy();
      expect(second.body.role).toBe('member');
      expect(second.body.teamId).toBeUndefined();
    });

    it('rejects registering a username that already exists', async () => {
      await request(app).post('/api/v1/auth/register').send({ username: 'bob', password: 'pw123456' }).expect(201);
      const res = await request(app).post('/api/v1/auth/register').send({ username: 'bob', password: 'other' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('username_taken');
    });

    it('logs in with correct credentials and rejects incorrect ones', async () => {
      await request(app).post('/api/v1/auth/register').send({ username: 'carol', password: 'correct-horse' }).expect(201);

      const good = await request(app).post('/api/v1/auth/login').send({ username: 'carol', password: 'correct-horse' });
      expect(good.status).toBe(200);
      expect(good.body.token).toBeTruthy();

      const bad = await request(app).post('/api/v1/auth/login').send({ username: 'carol', password: 'wrong' });
      expect(bad.status).toBe(401);
      expect(bad.body.error.code).toBe('invalid_credentials');
    });

    it('never returns the password hash in any response', async () => {
      const res = await request(app).post('/api/v1/auth/register').send({ username: 'dave', password: 'pw123456' });
      expect(JSON.stringify(res.body)).not.toContain('password');
    });

    it('rejects login attempt for SSO-provisioned user with NULL password_hash', async () => {
      // Directly insert a user with NULL password_hash (simulating SSO provisioning)
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO users (username, password_hash) VALUES ($1, NULL) RETURNING id',
        ['sso-user']
      );
      const userId = rows[0].id;

      // Ensure the user exists in the singleton team
      const teamRes = await pool.query<{ id: string }>(
        "SELECT id FROM teams WHERE singleton_key = 'default' LIMIT 1"
      );
      if (teamRes.rows.length > 0) {
        const teamId = teamRes.rows[0].id;
        await pool.query(
          'INSERT INTO team_memberships (team_id, user_id, role, active) VALUES ($1, $2, $3, true)',
          [teamId, userId, 'member']
        );
      }

      // Attempt to login with any password should return 401, not crash
      const res = await request(app).post('/api/v1/auth/login').send({ username: 'sso-user', password: 'anypassword' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_credentials');
    });
  });

  describe('admin member routes', () => {
    async function createAdminFixture() {
      const teamId = await createDirectTeam('Singleton Admin Team');
      const admin = await createDirectUser('singleton-admin', DASHBOARD_PASSWORD);
      const member = await createDirectUser('teammate-member', DASHBOARD_PASSWORD);

      await addMembership(teamId, admin.userId, 'admin');
      await addMembership(teamId, member.userId, 'member');

      const session = await openAdminSession(app, 'singleton-admin');
      await reauthenticateAdminSession(app, session);

      return { teamId, admin: { ...admin, session }, member };
    }

    it('lists members and lets the singleton admin deactivate then reactivate a member', async () => {
      const { admin, member } = await createAdminFixture();

      const listRes = await request(app)
        .get('/api/v1/admin/members')
        .set(admin.session);
      expect(listRes.status).toBe(200);
      expect(listRes.body.members).toHaveLength(2);

      const adminEntry = listRes.body.members.find((entry: { userId: string }) => entry.userId === admin.userId);
      expect(adminEntry).toMatchObject({
        userId: admin.userId,
        username: 'singleton-admin',
        role: 'admin',
        active: true,
      });
      expect(adminEntry.createdAt).toEqual(expect.any(String));

      const memberEntry = listRes.body.members.find((entry: { userId: string }) => entry.userId === member.userId);
      expect(memberEntry).toMatchObject({
        userId: member.userId,
        username: 'teammate-member',
        role: 'member',
        active: true,
      });
      expect(memberEntry.createdAt).toEqual(expect.any(String));

      const deactivateRes = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set(admin.session)
        .send({
          active: false,
          confirmation: confirmationFor.memberState('teammate-member', false),
        });
      expect(deactivateRes.status).toBe(200);
      expect(deactivateRes.body.member).toMatchObject({
        userId: member.userId,
        username: 'teammate-member',
        role: 'member',
        active: false,
      });

      const deactivatedMembership = await pool.query<{ active: boolean }>(
        'SELECT active FROM team_memberships WHERE user_id = $1',
        [member.userId],
      );
      expect(deactivatedMembership.rows[0].active).toBe(false);

      const reactivateRes = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set(admin.session)
        .send({
          active: true,
          confirmation: confirmationFor.memberState('teammate-member', true),
        });
      expect(reactivateRes.status).toBe(200);
      expect(reactivateRes.body.member).toMatchObject({
        userId: member.userId,
        username: 'teammate-member',
        role: 'member',
        active: true,
      });

      const reactivatedMembership = await pool.query<{ active: boolean }>(
        'SELECT active FROM team_memberships WHERE user_id = $1',
        [member.userId],
      );
      expect(reactivatedMembership.rows[0].active).toBe(true);
    });

    it('refuses to open a dashboard session for a non-admin member', async () => {
      await createAdminFixture();

      const res = await request(app)
        .post('/api/v1/admin/session')
        .send({ username: 'teammate-member', password: DASHBOARD_PASSWORD });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_credentials');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects a member bearer token on admin member APIs instead of authorizing it', async () => {
      const { member } = await createAdminFixture();

      const listRes = await request(app)
        .get('/api/v1/admin/members')
        .set(member.authHeader);
      expect(listRes.status).toBe(401);
      expect(listRes.body.error.code).toBe('missing_session');

      const patchRes = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set(member.authHeader)
        .send({
          active: false,
          confirmation: confirmationFor.memberState('teammate-member', false),
        });
      expect(patchRes.status).toBe(401);
      expect(patchRes.body.error.code).toBe('missing_session');
    });

    it('returns 403 admin_required once the session holder loses admin rights', async () => {
      const { admin, member } = await createAdminFixture();

      await pool.query(`UPDATE team_memberships SET role = 'member' WHERE user_id = $1`, [
        admin.userId,
      ]);

      const listRes = await request(app).get('/api/v1/admin/members').set(admin.session);
      expect(listRes.status).toBe(403);
      expect(listRes.body.error.code).toBe('admin_required');

      // The membership check runs before any body validation, so a malformed
      // patch from a demoted session still gets the authorization answer.
      const patchRes = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set(admin.session)
        .send({ active: 'nope', role: 'admin' });
      expect(patchRes.status).toBe(403);
      expect(patchRes.body.error.code).toBe('admin_required');
    });

    it('rejects a member patch that carries no CSRF token', async () => {
      const { admin, member } = await createAdminFixture();

      const res = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set({ Cookie: admin.session.Cookie })
        .send({
          active: false,
          confirmation: confirmationFor.memberState('teammate-member', false),
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('csrf_failed');

      const membership = await pool.query<{ active: boolean }>(
        'SELECT active FROM team_memberships WHERE user_id = $1',
        [member.userId],
      );
      expect(membership.rows[0].active).toBe(true);
    });

    it('returns 404 when the singleton admin targets an unknown user', async () => {
      const { admin } = await createAdminFixture();

      const res = await request(app)
        .patch('/api/v1/admin/members/00000000-0000-0000-0000-000000000099')
        .set(admin.session)
        .send({
          active: false,
          confirmation: confirmationFor.memberState('missing-member', false),
        });

      expect(res.status).toBe(404);
    });

    it('returns 409 admin_immutable when attempting to mutate the singleton admin', async () => {
      const { admin } = await createAdminFixture();

      const res = await request(app)
        .patch(`/api/v1/admin/members/${admin.userId}`)
        .set(admin.session)
        .send({
          active: false,
          confirmation: confirmationFor.memberState('singleton-admin', false),
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('admin_immutable');

      const membership = await pool.query<{ active: boolean }>(
        'SELECT active FROM team_memberships WHERE user_id = $1',
        [admin.userId],
      );
      expect(membership.rows[0].active).toBe(true);
    });

    it('returns 400 invalid_request for extra keys and does not mutate the member', async () => {
      const { admin, member } = await createAdminFixture();

      const res = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set(admin.session)
        .send({ active: false, role: 'admin' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');

      const membership = await pool.query<{ active: boolean }>(
        'SELECT active FROM team_memberships WHERE user_id = $1',
        [member.userId],
      );
      expect(membership.rows[0].active).toBe(true);
    });
  });

  describe('sync routes require authentication', () => {
    it('rejects a request with no token', async () => {
      const res = await request(app).get('/api/v1/sync/tasks');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('missing_token');
    });

    it('rejects a request with an invalid token', async () => {
      const res = await request(app).get('/api/v1/sync/tasks').set('Authorization', 'Bearer not-a-real-token');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_token');
    });
  });

  describe('deactivated membership revokes already-issued tokens', () => {
    async function seedDeactivatedMember(): Promise<{
      authHeader: { Authorization: string };
      teamId: string;
    }> {
      const teamId = await createDirectTeam('Revocation Team');
      const admin = await createDirectUser('revocation-admin', DASHBOARD_PASSWORD);
      const member = await createDirectUser('revocation-member');
      await addMembership(teamId, admin.userId, 'admin');
      await addMembership(teamId, member.userId, 'member');
      const adminSession = await openAdminSession(app, 'revocation-admin');
      await reauthenticateAdminSession(app, adminSession);

      // The member token is minted while the membership is still active, then
      // the admin deactivates them from the dashboard: the already-issued JWT
      // must stop working.
      const deactivate = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set(adminSession)
        .send({
          active: false,
          confirmation: confirmationFor.memberState('revocation-member', false),
        });
      expect(deactivate.status).toBe(200);

      return { authHeader: member.authHeader, teamId };
    }

    it('returns 403 inactive_membership on task reads and writes and creates no task', async () => {
      const { authHeader } = await seedDeactivatedMember();

      const readRes = await request(app).get('/api/v1/sync/tasks').set(authHeader);
      expect(readRes.status).toBe(403);
      expect(readRes.body.error.code).toBe('inactive_membership');

      const writeRes = await request(app)
        .post('/api/v1/sync/tasks')
        .set(authHeader)
        .send({
          tasks: [
            {
              localId: 'revoked-task',
              remoteId: null,
              title: 'Should never persist',
              status: 'active',
              createdAt: '2026-09-21T00:00:00Z',
              updatedAt: '2026-09-21T00:00:00Z',
            },
          ],
        });
      expect(writeRes.status).toBe(403);
      expect(writeRes.body.error.code).toBe('inactive_membership');

      const tasks = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM tasks',
      );
      expect(tasks.rows[0].count).toBe(0);
    });

    it('returns 403 inactive_membership before body validation on protected sync POSTs', async () => {
      const { authHeader } = await seedDeactivatedMember();

      const postPaths = [
        '/api/v1/sync/tasks',
        '/api/v1/sync/checkpoints',
        '/api/v1/sync/todos',
        '/api/v1/sync/decisions',
        '/api/v1/sync/errors',
        '/api/v1/sync/open-questions',
        '/api/v1/sync/commands',
      ];

      for (const postPath of postPaths) {
        const res = await request(app)
          .post(postPath)
          .set(authHeader)
          .send({ totally: 'malformed', tasks: 'not-an-array' });
        expect(res.status, `${postPath} status`).toBe(403);
        expect(res.body.error.code, `${postPath} code`).toBe('inactive_membership');
        expect(res.text, `${postPath} body`).not.toContain('invalid_request');
      }
    });
  });

  describe('tasks sync', () => {
    it('pushes a new task (remoteId null) and assigns a remote id', async () => {
      const token = await registerAndLogin();
      const res = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'local-1',
              remoteId: null,
              title: 'Fix login bug',
              goal: 'ship it',
              status: 'active',
              branch: 'main',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].localId).toBe('local-1');
      expect(res.body.results[0].remoteId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('re-pushing with a remoteId updates the existing row (remote-wins)', async () => {
      const token = await registerAndLogin();
      const first = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'local-1',
              remoteId: null,
              title: 'Original title',
              status: 'active',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });
      const remoteId = first.body.results[0].remoteId;

      const second = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'local-1',
              remoteId,
              title: 'Updated title',
              status: 'done',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-02T12:00:00Z',
            },
          ],
        });
      expect(second.status).toBe(200);
      expect(second.body.results[0].remoteId).toBe(remoteId);

      const pull = await request(app).get('/api/v1/sync/tasks').set('Authorization', `Bearer ${token}`);
      expect(pull.body.tasks).toHaveLength(1);
      expect(pull.body.tasks[0].title).toBe('Updated title');
      expect(pull.body.tasks[0].status).toBe('done');
    });

    it('returns 404 when pushing an update for a remoteId that does not exist', async () => {
      const token = await registerAndLogin();
      const res = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'local-1',
              remoteId: '00000000-0000-0000-0000-000000000000',
              title: 'Ghost task',
              status: 'active',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('task_not_found');
    });

    it('pulls only tasks updated after the given `since` timestamp', async () => {
      const token = await registerAndLogin();
      await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'old-task',
              remoteId: null,
              title: 'Old task',
              status: 'active',
              createdAt: '2020-01-01T00:00:00Z',
              updatedAt: '2020-01-01T00:00:00Z',
            },
          ],
        });

      const midpoint = new Date().toISOString();
      const afterMidpoint = new Date(Date.now() + 60_000).toISOString();

      await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'new-task',
              remoteId: null,
              title: 'New task',
              status: 'active',
              createdAt: afterMidpoint,
              updatedAt: afterMidpoint,
            },
          ],
        });

      const pull = await request(app)
        .get('/api/v1/sync/tasks')
        .query({ since: midpoint })
        .set('Authorization', `Bearer ${token}`);
      expect(pull.body.tasks).toHaveLength(1);
      expect(pull.body.tasks[0].title).toBe('New task');
      expect(pull.body.serverTime).toBeTruthy();
    });

    it('a different user on the same team can read and update a task they do not own', async () => {
      const aliceToken = await registerAndLogin('alice2', 'pw123456');
      const push = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({
          tasks: [
            {
              localId: 'shared-task',
              remoteId: null,
              title: "Alice's task",
              status: 'active',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });
      const remoteId = push.body.results[0].remoteId;

      const bobToken = await registerAndLogin('bob2', 'pw123456');
      const bobPull = await request(app).get('/api/v1/sync/tasks').set('Authorization', `Bearer ${bobToken}`);
      expect(bobPull.body.tasks.some((t: { remoteId: string }) => t.remoteId === remoteId)).toBe(true);

      const bobUpdate = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${bobToken}`)
        .send({
          tasks: [
            {
              localId: 'shared-task',
              remoteId,
              title: "Alice's task, edited by Bob",
              status: 'done',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-02T00:00:00Z',
            },
          ],
        });
      expect(bobUpdate.status).toBe(200);
    });

    it('stores and returns workspaceLabel, and updates it on re-push from a different workspace', async () => {
      const token = await registerAndLogin();
      const push = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'local-ws',
              remoteId: null,
              title: 'Task from atom repo',
              status: 'active',
              workspaceLabel: 'laptop1:org/atom',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });
      const remoteId = push.body.results[0].remoteId;

      const pull = await request(app).get('/api/v1/sync/tasks').set('Authorization', `Bearer ${token}`);
      const pulled = pull.body.tasks.find((t: { remoteId: string }) => t.remoteId === remoteId);
      expect(pulled.workspaceLabel).toBe('laptop1:org/atom');

      // Re-push (e.g. someone pulls it into a different workspace and pushes again) updates the label.
      await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'local-ws',
              remoteId,
              title: 'Task from atom repo',
              status: 'active',
              workspaceLabel: 'desktop2:org/atom',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-02T00:00:00Z',
            },
          ],
        });
      const pullAgain = await request(app).get('/api/v1/sync/tasks').set('Authorization', `Bearer ${token}`);
      const pulledAgain = pullAgain.body.tasks.find((t: { remoteId: string }) => t.remoteId === remoteId);
      expect(pulledAgain.workspaceLabel).toBe('desktop2:org/atom');
    });

    it('GET /tasks/all lists every task on the caller team with owner + workspaceLabel', async () => {
      const aliceToken = await registerAndLogin('alice3', 'pw123456');
      await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({
          tasks: [
            {
              localId: 'alice-task',
              remoteId: null,
              title: "Alice's task",
              status: 'active',
              workspaceLabel: 'alice-laptop:repo-a',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });

      const bobToken = await registerAndLogin('bob3', 'pw123456');
      await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${bobToken}`)
        .send({
          tasks: [
            {
              localId: 'bob-task',
              remoteId: null,
              title: "Bob's task",
              status: 'active',
              workspaceLabel: 'bob-desktop:repo-b',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });

      // Bob should see Alice's task too because both users are in the same team.
      const all = await request(app).get('/api/v1/sync/tasks/all').set('Authorization', `Bearer ${bobToken}`);
      expect(all.status).toBe(200);
      expect(all.body.tasks).toHaveLength(2);
      const aliceEntry = all.body.tasks.find((t: { title: string }) => t.title === "Alice's task");
      expect(aliceEntry.owner).toBe('alice3');
      expect(aliceEntry.workspaceLabel).toBe('alice-laptop:repo-a');
      const bobEntry = all.body.tasks.find((t: { title: string }) => t.title === "Bob's task");
      expect(bobEntry.owner).toBe('bob3');
      expect(bobEntry.workspaceLabel).toBe('bob-desktop:repo-b');
    });

    it('GET /tasks/all paginates via limit/offset, reporting hasMore/nextOffset', async () => {
      const token = await registerAndLogin('pager', 'pw123456');
      const pushBody = {
        tasks: Array.from({ length: 5 }, (_, i) => ({
          localId: `pager-task-${i}`,
          remoteId: null,
          title: `Pager task ${i}`,
          status: 'active' as const,
          createdAt: `2026-07-01T12:0${i}:00Z`,
          updatedAt: `2026-07-01T12:0${i}:00Z`,
        })),
      };
      await request(app).post('/api/v1/sync/tasks').set('Authorization', `Bearer ${token}`).send(pushBody);

      const page1 = await request(app)
        .get('/api/v1/sync/tasks/all')
        .query({ limit: 2 })
        .set('Authorization', `Bearer ${token}`);
      expect(page1.body.tasks).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.nextOffset).toBe(2);

      const page2 = await request(app)
        .get('/api/v1/sync/tasks/all')
        .query({ limit: 2, offset: page1.body.nextOffset })
        .set('Authorization', `Bearer ${token}`);
      expect(page2.body.tasks).toHaveLength(2);
      expect(page2.body.hasMore).toBe(true);

      const page3 = await request(app)
        .get('/api/v1/sync/tasks/all')
        .query({ limit: 2, offset: page2.body.nextOffset })
        .set('Authorization', `Bearer ${token}`);
      expect(page3.body.tasks).toHaveLength(1);
      expect(page3.body.hasMore).toBe(false);
      expect(page3.body.nextOffset).toBeNull();

      // No overlap/gaps across the three pages.
      const allTitles = [...page1.body.tasks, ...page2.body.tasks, ...page3.body.tasks].map((t: { title: string }) => t.title);
      expect(new Set(allTitles).size).toBe(5);
    });
  });

  describe('checkpoints sync', () => {
    async function pushTask(app: Express, token: string): Promise<string> {
      const res = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'task-for-checkpoints',
              remoteId: null,
              title: 'Task with checkpoints',
              status: 'active',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });
      return res.body.results[0].remoteId;
    }

    it('pushes a checkpoint against an existing task and assigns a remote id', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      const res = await request(app)
        .post('/api/v1/sync/checkpoints')
        .set('Authorization', `Bearer ${token}`)
        .send({
          checkpoints: [
            { localId: 'ckpt-1', remoteTaskId: taskRemoteId, level: 'milestone', summary: 'Did the thing', createdAt: '2026-07-01T13:00:00Z' },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.results[0].localId).toBe('ckpt-1');
      expect(res.body.results[0].remoteId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns 404 when pushing a checkpoint for a task that does not exist', async () => {
      const token = await registerAndLogin();
      const res = await request(app)
        .post('/api/v1/sync/checkpoints')
        .set('Authorization', `Bearer ${token}`)
        .send({
          checkpoints: [
            {
              localId: 'ckpt-1',
              remoteTaskId: '00000000-0000-0000-0000-000000000000',
              level: 'micro',
              summary: 'Orphaned',
              createdAt: '2026-07-01T13:00:00Z',
            },
          ],
        });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('task_not_found');
    });

    it('pulls checkpoints scoped to a task, filtered by `since`', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      await request(app)
        .post('/api/v1/sync/checkpoints')
        .set('Authorization', `Bearer ${token}`)
        .send({
          checkpoints: [
            { localId: 'ckpt-old', remoteTaskId: taskRemoteId, level: 'micro', summary: 'Old checkpoint', createdAt: '2020-01-01T00:00:00Z' },
          ],
        });

      const midpoint = new Date().toISOString();
      const afterMidpoint = new Date(Date.now() + 60_000).toISOString();

      await request(app)
        .post('/api/v1/sync/checkpoints')
        .set('Authorization', `Bearer ${token}`)
        .send({
          checkpoints: [
            { localId: 'ckpt-new', remoteTaskId: taskRemoteId, level: 'milestone', summary: 'New checkpoint', createdAt: afterMidpoint },
          ],
        });

      const pull = await request(app)
        .get('/api/v1/sync/checkpoints')
        .query({ taskRemoteId, since: midpoint })
        .set('Authorization', `Bearer ${token}`);
      expect(pull.body.checkpoints).toHaveLength(1);
      expect(pull.body.checkpoints[0].summary).toBe('New checkpoint');
    });

    it('stores and returns workspaceLabel + owner attribution for checkpoints', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      await request(app)
        .post('/api/v1/sync/checkpoints')
        .set('Authorization', `Bearer ${token}`)
        .send({
          checkpoints: [
            {
              localId: 'ckpt-attributed',
              remoteTaskId: taskRemoteId,
              level: 'session',
              summary: 'Attributed checkpoint',
              workspaceLabel: 'laptop1:org/atom',
              createdAt: '2026-07-01T14:00:00Z',
            },
          ],
        });

      const pull = await request(app)
        .get('/api/v1/sync/checkpoints')
        .query({ taskRemoteId })
        .set('Authorization', `Bearer ${token}`);
      const attributed = pull.body.checkpoints.find((c: { summary: string }) => c.summary === 'Attributed checkpoint');
      expect(attributed.workspaceLabel).toBe('laptop1:org/atom');
    });

  it('requires a taskRemoteId query parameter on pull', async () => {
      const token = await registerAndLogin();
      const res = await request(app).get('/api/v1/sync/checkpoints').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    });
  });

  describe('todos sync', () => {
    async function pushTask(app: Express, token: string): Promise<string> {
      const res = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'task-for-todos',
              remoteId: null,
              title: 'Task with todos',
              status: 'active',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });
      return res.body.results[0].remoteId;
    }

    it('pushes a new todo (remoteId null) and assigns a remote id', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      const res = await request(app)
        .post('/api/v1/sync/todos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          todos: [
            { localId: 'todo-1', remoteId: null, remoteTaskId: taskRemoteId, text: 'Write tests', status: 'pending', createdAt: '2026-07-01T13:00:00Z', updatedAt: '2026-07-01T13:00:00Z' },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.results[0].localId).toBe('todo-1');
      expect(res.body.results[0].remoteId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('re-pushing with a remoteId updates the existing todo (e.g. status change)', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      const first = await request(app)
        .post('/api/v1/sync/todos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          todos: [
            { localId: 'todo-1', remoteId: null, remoteTaskId: taskRemoteId, text: 'Write tests', status: 'pending', createdAt: '2026-07-01T13:00:00Z', updatedAt: '2026-07-01T13:00:00Z' },
          ],
        });
      const remoteId = first.body.results[0].remoteId;

      const second = await request(app)
        .post('/api/v1/sync/todos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          todos: [
            { localId: 'todo-1', remoteId, remoteTaskId: taskRemoteId, text: 'Write tests', status: 'done', createdAt: '2026-07-01T13:00:00Z', updatedAt: '2026-07-01T14:00:00Z' },
          ],
        });
      expect(second.status).toBe(200);
      expect(second.body.results[0].remoteId).toBe(remoteId);

      const pull = await request(app).get('/api/v1/sync/todos').query({ taskRemoteId }).set('Authorization', `Bearer ${token}`);
      expect(pull.body.todos[0].status).toBe('done');
    });

    it('returns 404 when pushing an update for a todo remoteId that does not exist', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);
      const res = await request(app)
        .post('/api/v1/sync/todos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          todos: [
            { localId: 'todo-x', remoteId: '00000000-0000-0000-0000-000000000000', remoteTaskId: taskRemoteId, text: 'x', status: 'pending', createdAt: '2026-07-01T13:00:00Z', updatedAt: '2026-07-01T13:00:00Z' },
          ],
        });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('todo_not_found');
    });

    it('returns 404 when pushing a new todo for a task that does not exist', async () => {
      const token = await registerAndLogin();
      const res = await request(app)
        .post('/api/v1/sync/todos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          todos: [
            { localId: 'todo-x', remoteId: null, remoteTaskId: '00000000-0000-0000-0000-000000000000', text: 'x', status: 'pending', createdAt: '2026-07-01T13:00:00Z', updatedAt: '2026-07-01T13:00:00Z' },
          ],
        });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('task_not_found');
    });

    it('pulls todos scoped to a task, filtered by `since`', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      await request(app)
        .post('/api/v1/sync/todos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          todos: [
            { localId: 'todo-old', remoteId: null, remoteTaskId: taskRemoteId, text: 'Old todo', status: 'pending', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' },
          ],
        });

      const midpoint = new Date().toISOString();
      const afterMidpoint = new Date(Date.now() + 60_000).toISOString();

      await request(app)
        .post('/api/v1/sync/todos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          todos: [
            { localId: 'todo-new', remoteId: null, remoteTaskId: taskRemoteId, text: 'New todo', status: 'pending', createdAt: afterMidpoint, updatedAt: afterMidpoint },
          ],
        });

      const pull = await request(app)
        .get('/api/v1/sync/todos')
        .query({ taskRemoteId, since: midpoint })
        .set('Authorization', `Bearer ${token}`);
      expect(pull.body.todos).toHaveLength(1);
      expect(pull.body.todos[0].text).toBe('New todo');
    });
  });

  describe('decisions/errors/open-questions/commands sync (bidirectional)', () => {
    async function pushTask(app: Express, token: string): Promise<string> {
      const res = await request(app)
        .post('/api/v1/sync/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({
          tasks: [
            {
              localId: 'task-for-subentities',
              remoteId: null,
              title: 'Task with sub-entities',
              status: 'active',
              createdAt: '2026-07-01T12:00:00Z',
              updatedAt: '2026-07-01T12:00:00Z',
            },
          ],
        });
      return res.body.results[0].remoteId;
    }

    it('re-pushing a decision with its remoteId updates the existing row and pull returns updatedAt', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      const first = await request(app)
        .post('/api/v1/sync/decisions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          decisions: [{
            localId: 'dec-1',
            remoteId: null,
            remoteTaskId: taskRemoteId,
            text: 'Use SQLite',
            rationale: 'Simplicity',
            supersedesId: null,
            createdAt: '2026-07-01T13:00:00Z',
            updatedAt: '2026-07-01T13:00:00Z',
          }],
        });
      const remoteId = first.body.results[0].remoteId;

      const midpoint = new Date().toISOString();
      const second = await request(app)
        .post('/api/v1/sync/decisions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          decisions: [{
            localId: 'dec-1',
            remoteId,
            remoteTaskId: taskRemoteId,
            text: 'Use Postgres',
            rationale: 'Shared remote state',
            supersedesId: null,
            createdAt: '2026-07-01T13:00:00Z',
            updatedAt: '2026-07-01T14:00:00Z',
          }],
        });
      expect(second.status).toBe(200);
      expect(new Date(second.body.results[0].updatedAt).getTime()).toBeGreaterThan(new Date(midpoint).getTime());

      const pull = await request(app)
        .get('/api/v1/sync/decisions')
        .query({ taskRemoteId, since: midpoint })
        .set('Authorization', `Bearer ${token}`);
      expect(pull.body.decisions).toHaveLength(1);
      expect(pull.body.decisions[0]).toMatchObject({
        remoteId,
        text: 'Use Postgres',
        rationale: 'Shared remote state',
        updatedAt: expect.any(String),
      });
    });

    it('re-pushing an error with its remoteId updates the existing row and pull returns updatedAt', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      const first = await request(app)
        .post('/api/v1/sync/errors')
        .set('Authorization', `Bearer ${token}`)
        .send({
          errors: [{
            localId: 'err-1',
            remoteId: null,
            remoteTaskId: taskRemoteId,
            message: 'TypeError',
            resolved: false,
            resolution: null,
            createdAt: '2026-07-01T13:00:00Z',
            updatedAt: '2026-07-01T13:00:00Z',
          }],
        });
      const remoteId = first.body.results[0].remoteId;

      const midpoint = new Date().toISOString();
      await request(app)
        .post('/api/v1/sync/errors')
        .set('Authorization', `Bearer ${token}`)
        .send({
          errors: [{
            localId: 'err-1',
            remoteId,
            remoteTaskId: taskRemoteId,
            message: 'TypeError fixed',
            resolved: true,
            resolution: 'Added guard',
            createdAt: '2026-07-01T13:00:00Z',
            updatedAt: '2026-07-01T14:00:00Z',
          }],
        })
        .expect(200);

      const pull = await request(app)
        .get('/api/v1/sync/errors')
        .query({ taskRemoteId, since: midpoint })
        .set('Authorization', `Bearer ${token}`);
      expect(pull.body.errors).toHaveLength(1);
      expect(pull.body.errors[0]).toMatchObject({
        remoteId,
        message: 'TypeError fixed',
        resolved: true,
        resolution: 'Added guard',
        updatedAt: expect.any(String),
      });
    });

    it('re-pushing an open question with its remoteId updates the existing row and pull returns updatedAt', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      const first = await request(app)
        .post('/api/v1/sync/open-questions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          openQuestions: [{
            localId: 'q-1',
            remoteId: null,
            remoteTaskId: taskRemoteId,
            text: 'Which DB?',
            resolved: false,
            createdAt: '2026-07-01T13:00:00Z',
            updatedAt: '2026-07-01T13:00:00Z',
          }],
        });
      const remoteId = first.body.results[0].remoteId;

      const midpoint = new Date().toISOString();
      await request(app)
        .post('/api/v1/sync/open-questions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          openQuestions: [{
            localId: 'q-1',
            remoteId,
            remoteTaskId: taskRemoteId,
            text: 'Which SQL engine?',
            resolved: true,
            createdAt: '2026-07-01T13:00:00Z',
            updatedAt: '2026-07-01T14:00:00Z',
          }],
        })
        .expect(200);

      const pull = await request(app)
        .get('/api/v1/sync/open-questions')
        .query({ taskRemoteId, since: midpoint })
        .set('Authorization', `Bearer ${token}`);
      expect(pull.body.openQuestions).toHaveLength(1);
      expect(pull.body.openQuestions[0]).toMatchObject({
        remoteId,
        text: 'Which SQL engine?',
        resolved: true,
        updatedAt: expect.any(String),
      });
    });

    it('re-pushing a command with its remoteId updates the existing row and pull returns updatedAt', async () => {
      const token = await registerAndLogin();
      const taskRemoteId = await pushTask(app, token);

      const first = await request(app)
        .post('/api/v1/sync/commands')
        .set('Authorization', `Bearer ${token}`)
        .send({
          commands: [{
            localId: 'cmd-1',
            remoteId: null,
            remoteTaskId: taskRemoteId,
            cmdRedacted: 'npm test',
            exitCode: 1,
            summary: 'failed',
            createdAt: '2026-07-01T13:00:00Z',
            updatedAt: '2026-07-01T13:00:00Z',
          }],
        });
      const remoteId = first.body.results[0].remoteId;

      const midpoint = new Date().toISOString();
      await request(app)
        .post('/api/v1/sync/commands')
        .set('Authorization', `Bearer ${token}`)
        .send({
          commands: [{
            localId: 'cmd-1',
            remoteId,
            remoteTaskId: taskRemoteId,
            cmdRedacted: 'pnpm test',
            exitCode: 0,
            summary: 'passed',
            createdAt: '2026-07-01T13:00:00Z',
            updatedAt: '2026-07-01T14:00:00Z',
          }],
        })
        .expect(200);

      const pull = await request(app)
        .get('/api/v1/sync/commands')
        .query({ taskRemoteId, since: midpoint })
        .set('Authorization', `Bearer ${token}`);
      expect(pull.body.commands).toHaveLength(1);
      expect(pull.body.commands[0]).toMatchObject({
        remoteId,
        cmdRedacted: 'pnpm test',
        exitCode: 0,
        summary: 'passed',
        updatedAt: expect.any(String),
      });
    });

    it('returns 404 when pushing any sub-entity for a task that does not exist', async () => {
      const token = await registerAndLogin();
      const res = await request(app)
        .post('/api/v1/sync/decisions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          decisions: [{
            localId: 'dec-x',
            remoteId: null,
            remoteTaskId: '00000000-0000-0000-0000-000000000000',
            text: 'Orphaned',
            rationale: null,
            supersedesId: null,
            createdAt: '2026-07-01T13:00:00Z',
            updatedAt: '2026-07-01T13:00:00Z',
          }],
        });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('task_not_found');
    });
  });

  describe('team-scoped sync authorization', () => {
    interface TeamScopedFixture {
      teamAId: string;
      teamBId: string;
      teamAUser: { userId: string; authHeader: { Authorization: string } };
      teamBUser: { userId: string; authHeader: { Authorization: string } };
      taskAId: string;
      taskBId: string;
    }

    async function seedTeamScopedFixture(): Promise<TeamScopedFixture> {
      const teamAId = await createDirectTeam('Team Alpha');
      const teamBId = await createDirectTeam('Team Beta');
      const teamAUser = await createDirectUser('team-alpha-user');
      const teamBUser = await createDirectUser('team-beta-user');

      await addMembership(teamAId, teamAUser.userId, 'admin');
      await addMembership(teamBId, teamBUser.userId, 'admin');

      const taskAId = '00000000-0000-0000-0000-000000000301';
      const taskBId = '00000000-0000-0000-0000-000000000302';

      await createDirectTask({
        taskId: taskAId,
        teamId: teamAId,
        ownerUserId: teamAUser.userId,
        localId: 'team-a-task',
        title: 'Team A task',
      });
      await createDirectTask({
        taskId: taskBId,
        teamId: teamBId,
        ownerUserId: teamBUser.userId,
        localId: 'team-b-task',
        title: 'Team B task',
      });

      return { teamAId, teamBId, teamAUser, teamBUser, taskAId, taskBId };
    }

    it('lists and updates only tasks inside the caller team', async () => {
      const fixture = await seedTeamScopedFixture();

      const incremental = await request(app)
        .get('/api/v1/sync/tasks')
        .set(fixture.teamBUser.authHeader)
        .expect(200);
      expect(incremental.body.tasks).toHaveLength(1);
      expect(incremental.body.tasks[0]).toMatchObject({
        remoteId: fixture.taskBId,
        title: 'Team B task',
      });

      const allTasks = await request(app)
        .get('/api/v1/sync/tasks/all')
        .set(fixture.teamBUser.authHeader)
        .expect(200);
      expect(allTasks.body.tasks).toHaveLength(1);
      expect(allTasks.body.tasks[0]).toMatchObject({
        remoteId: fixture.taskBId,
        title: 'Team B task',
      });

      const update = await request(app)
        .post('/api/v1/sync/tasks')
        .set(fixture.teamBUser.authHeader)
        .send({
          tasks: [
            {
              localId: 'team-a-task',
              remoteId: fixture.taskAId,
              title: 'Unauthorized update',
              status: 'done',
              createdAt: '2026-09-21T00:00:00Z',
              updatedAt: '2026-09-21T01:00:00Z',
            },
          ],
        });
      expect(update.status).toBe(404);
      expect(update.body.error.code).toBe('task_not_found');
    });

    it('denies cross-team checkpoint create and list routes as task_not_found', async () => {
      const fixture = await seedTeamScopedFixture();

      await pool.query(
        `INSERT INTO checkpoints (local_id, task_id, level, summary, owner_user_id, workspace_label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['checkpoint-b', fixture.taskBId, 'session', 'Team B checkpoint', fixture.teamBUser.userId, null, '2026-09-21T02:00:00Z'],
      );

      const allowed = await request(app)
        .get('/api/v1/sync/checkpoints')
        .query({ taskRemoteId: fixture.taskBId })
        .set(fixture.teamBUser.authHeader)
        .expect(200);
      expect(allowed.body.checkpoints).toHaveLength(1);
      expect(allowed.body.checkpoints[0].summary).toBe('Team B checkpoint');

      const deniedCreate = await request(app)
        .post('/api/v1/sync/checkpoints')
        .set(fixture.teamBUser.authHeader)
        .send({
          checkpoints: [
            {
              localId: 'checkpoint-a',
              remoteTaskId: fixture.taskAId,
              level: 'micro',
              summary: 'Should be denied',
              createdAt: '2026-09-21T02:00:00Z',
            },
          ],
        });
      expect(deniedCreate.status).toBe(404);
      expect(deniedCreate.body.error.code).toBe('task_not_found');

      const deniedList = await request(app)
        .get('/api/v1/sync/checkpoints')
        .query({ taskRemoteId: fixture.taskAId })
        .set(fixture.teamBUser.authHeader);
      expect(deniedList.status).toBe(404);
      expect(deniedList.body.error.code).toBe('task_not_found');
    });

    it('denies cross-team todo create, update, and list routes as task_not_found', async () => {
      const fixture = await seedTeamScopedFixture();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO todos (local_id, task_id, text, status, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id`,
        ['todo-a', fixture.taskAId, 'Team A todo', 'pending', fixture.teamAUser.userId, null, '2026-09-21T02:10:00Z'],
      );
      await pool.query(
        `INSERT INTO todos (local_id, task_id, text, status, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        ['todo-b', fixture.taskBId, 'Team B todo', 'pending', fixture.teamBUser.userId, null, '2026-09-21T02:11:00Z'],
      );

      const allowed = await request(app)
        .get('/api/v1/sync/todos')
        .query({ taskRemoteId: fixture.taskBId })
        .set(fixture.teamBUser.authHeader)
        .expect(200);
      expect(allowed.body.todos).toHaveLength(1);
      expect(allowed.body.todos[0].text).toBe('Team B todo');

      const deniedCreate = await request(app)
        .post('/api/v1/sync/todos')
        .set(fixture.teamBUser.authHeader)
        .send({
          todos: [
            {
              localId: 'todo-new',
              remoteId: null,
              remoteTaskId: fixture.taskAId,
              text: 'Blocked todo',
              status: 'pending',
              createdAt: '2026-09-21T02:12:00Z',
              updatedAt: '2026-09-21T02:12:00Z',
            },
          ],
        });
      expect(deniedCreate.status).toBe(404);
      expect(deniedCreate.body.error.code).toBe('task_not_found');

      const deniedUpdate = await request(app)
        .post('/api/v1/sync/todos')
        .set(fixture.teamBUser.authHeader)
        .send({
          todos: [
            {
              localId: 'todo-a',
              remoteId: rows[0].id,
              remoteTaskId: fixture.taskAId,
              text: 'Blocked update',
              status: 'done',
              createdAt: '2026-09-21T02:10:00Z',
              updatedAt: '2026-09-21T02:13:00Z',
            },
          ],
        });
      expect(deniedUpdate.status).toBe(404);
      expect(deniedUpdate.body.error.code).toBe('task_not_found');

      const foreignUpdate = await request(app)
        .post('/api/v1/sync/todos')
        .set(fixture.teamBUser.authHeader)
        .send({
          todos: [
            {
              localId: 'todo-a',
              remoteId: rows[0].id,
              remoteTaskId: fixture.taskBId,
              text: 'Foreign update should not apply',
              status: 'done',
              createdAt: '2026-09-21T02:10:00Z',
              updatedAt: '2026-09-21T02:14:00Z',
            },
          ],
        });
      expect(foreignUpdate.status).toBe(404);
      expect(foreignUpdate.body.error.code).toBe('todo_not_found');

      const foreignRow = await pool.query<{ text: string; status: string; task_id: string }>(
        'SELECT text, status, task_id FROM todos WHERE id = $1',
        [rows[0].id],
      );
      expect(foreignRow.rows[0]).toMatchObject({
        text: 'Team A todo',
        status: 'pending',
        task_id: fixture.taskAId,
      });

      const deniedList = await request(app)
        .get('/api/v1/sync/todos')
        .query({ taskRemoteId: fixture.taskAId })
        .set(fixture.teamBUser.authHeader);
      expect(deniedList.status).toBe(404);
      expect(deniedList.body.error.code).toBe('task_not_found');
    });

    it('denies cross-team decision create, update, and list routes as task_not_found', async () => {
      const fixture = await seedTeamScopedFixture();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO decisions (local_id, task_id, text, rationale, supersedes_id, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING id`,
        ['decision-a', fixture.taskAId, 'Team A decision', 'A rationale', null, fixture.teamAUser.userId, null, '2026-09-21T02:20:00Z'],
      );
      await pool.query(
        `INSERT INTO decisions (local_id, task_id, text, rationale, supersedes_id, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        ['decision-b', fixture.taskBId, 'Team B decision', 'B rationale', null, fixture.teamBUser.userId, null, '2026-09-21T02:21:00Z'],
      );

      const allowed = await request(app)
        .get('/api/v1/sync/decisions')
        .query({ taskRemoteId: fixture.taskBId })
        .set(fixture.teamBUser.authHeader)
        .expect(200);
      expect(allowed.body.decisions).toHaveLength(1);
      expect(allowed.body.decisions[0].text).toBe('Team B decision');

      const deniedCreate = await request(app)
        .post('/api/v1/sync/decisions')
        .set(fixture.teamBUser.authHeader)
        .send({
          decisions: [
            {
              localId: 'decision-new',
              remoteId: null,
              remoteTaskId: fixture.taskAId,
              text: 'Blocked decision',
              rationale: null,
              supersedesId: null,
              createdAt: '2026-09-21T02:22:00Z',
              updatedAt: '2026-09-21T02:22:00Z',
            },
          ],
        });
      expect(deniedCreate.status).toBe(404);
      expect(deniedCreate.body.error.code).toBe('task_not_found');

      const deniedUpdate = await request(app)
        .post('/api/v1/sync/decisions')
        .set(fixture.teamBUser.authHeader)
        .send({
          decisions: [
            {
              localId: 'decision-a',
              remoteId: rows[0].id,
              remoteTaskId: fixture.taskAId,
              text: 'Blocked update',
              rationale: 'Should fail',
              supersedesId: null,
              createdAt: '2026-09-21T02:20:00Z',
              updatedAt: '2026-09-21T02:23:00Z',
            },
          ],
        });
      expect(deniedUpdate.status).toBe(404);
      expect(deniedUpdate.body.error.code).toBe('task_not_found');

      const deniedList = await request(app)
        .get('/api/v1/sync/decisions')
        .query({ taskRemoteId: fixture.taskAId })
        .set(fixture.teamBUser.authHeader);
      expect(deniedList.status).toBe(404);
      expect(deniedList.body.error.code).toBe('task_not_found');
    });

    it('rejects cross-team supersedes ids without revealing the foreign decision', async () => {
      const fixture = await seedTeamScopedFixture();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO decisions (local_id, task_id, text, rationale, supersedes_id, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING id`,
        ['decision-a', fixture.taskAId, 'Team A decision', 'A rationale', null, fixture.teamAUser.userId, null, '2026-09-21T02:30:00Z'],
      );

      const deniedSupersede = await request(app)
        .post('/api/v1/sync/decisions')
        .set(fixture.teamBUser.authHeader)
        .send({
          decisions: [
            {
              localId: 'decision-b',
              remoteId: null,
              remoteTaskId: fixture.taskBId,
              text: 'Team B replacement',
              rationale: 'Blocked supersede',
              supersedesId: rows[0].id,
              createdAt: '2026-09-21T02:31:00Z',
              updatedAt: '2026-09-21T02:31:00Z',
            },
          ],
        });
      expect(deniedSupersede.status).toBe(400);
      expect(deniedSupersede.body.error.code).toBe('invalid_supersedes_id');
      expect(deniedSupersede.body.error.message).not.toContain('Team A decision');
    });

    it('denies cross-team error create, update, and list routes as task_not_found', async () => {
      const fixture = await seedTeamScopedFixture();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO errors (local_id, task_id, message, resolved, resolution, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING id`,
        ['error-a', fixture.taskAId, 'Team A error', false, null, fixture.teamAUser.userId, null, '2026-09-21T02:40:00Z'],
      );
      await pool.query(
        `INSERT INTO errors (local_id, task_id, message, resolved, resolution, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        ['error-b', fixture.taskBId, 'Team B error', false, null, fixture.teamBUser.userId, null, '2026-09-21T02:41:00Z'],
      );

      const allowed = await request(app)
        .get('/api/v1/sync/errors')
        .query({ taskRemoteId: fixture.taskBId })
        .set(fixture.teamBUser.authHeader)
        .expect(200);
      expect(allowed.body.errors).toHaveLength(1);
      expect(allowed.body.errors[0].message).toBe('Team B error');

      const deniedCreate = await request(app)
        .post('/api/v1/sync/errors')
        .set(fixture.teamBUser.authHeader)
        .send({
          errors: [
            {
              localId: 'error-new',
              remoteId: null,
              remoteTaskId: fixture.taskAId,
              message: 'Blocked error',
              resolved: false,
              resolution: null,
              createdAt: '2026-09-21T02:42:00Z',
              updatedAt: '2026-09-21T02:42:00Z',
            },
          ],
        });
      expect(deniedCreate.status).toBe(404);
      expect(deniedCreate.body.error.code).toBe('task_not_found');

      const deniedUpdate = await request(app)
        .post('/api/v1/sync/errors')
        .set(fixture.teamBUser.authHeader)
        .send({
          errors: [
            {
              localId: 'error-a',
              remoteId: rows[0].id,
              remoteTaskId: fixture.taskAId,
              message: 'Blocked update',
              resolved: true,
              resolution: 'Should fail',
              createdAt: '2026-09-21T02:40:00Z',
              updatedAt: '2026-09-21T02:43:00Z',
            },
          ],
        });
      expect(deniedUpdate.status).toBe(404);
      expect(deniedUpdate.body.error.code).toBe('task_not_found');

      const deniedList = await request(app)
        .get('/api/v1/sync/errors')
        .query({ taskRemoteId: fixture.taskAId })
        .set(fixture.teamBUser.authHeader);
      expect(deniedList.status).toBe(404);
      expect(deniedList.body.error.code).toBe('task_not_found');
    });

    it('denies cross-team open-question create, update, and list routes as task_not_found', async () => {
      const fixture = await seedTeamScopedFixture();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO open_questions (local_id, task_id, text, resolved, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id`,
        ['question-a', fixture.taskAId, 'Team A question', false, fixture.teamAUser.userId, null, '2026-09-21T02:50:00Z'],
      );
      await pool.query(
        `INSERT INTO open_questions (local_id, task_id, text, resolved, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        ['question-b', fixture.taskBId, 'Team B question', false, fixture.teamBUser.userId, null, '2026-09-21T02:51:00Z'],
      );

      const allowed = await request(app)
        .get('/api/v1/sync/open-questions')
        .query({ taskRemoteId: fixture.taskBId })
        .set(fixture.teamBUser.authHeader)
        .expect(200);
      expect(allowed.body.openQuestions).toHaveLength(1);
      expect(allowed.body.openQuestions[0].text).toBe('Team B question');

      const deniedCreate = await request(app)
        .post('/api/v1/sync/open-questions')
        .set(fixture.teamBUser.authHeader)
        .send({
          openQuestions: [
            {
              localId: 'question-new',
              remoteId: null,
              remoteTaskId: fixture.taskAId,
              text: 'Blocked question',
              resolved: false,
              createdAt: '2026-09-21T02:52:00Z',
              updatedAt: '2026-09-21T02:52:00Z',
            },
          ],
        });
      expect(deniedCreate.status).toBe(404);
      expect(deniedCreate.body.error.code).toBe('task_not_found');

      const deniedUpdate = await request(app)
        .post('/api/v1/sync/open-questions')
        .set(fixture.teamBUser.authHeader)
        .send({
          openQuestions: [
            {
              localId: 'question-a',
              remoteId: rows[0].id,
              remoteTaskId: fixture.taskAId,
              text: 'Blocked update',
              resolved: true,
              createdAt: '2026-09-21T02:50:00Z',
              updatedAt: '2026-09-21T02:53:00Z',
            },
          ],
        });
      expect(deniedUpdate.status).toBe(404);
      expect(deniedUpdate.body.error.code).toBe('task_not_found');

      const deniedList = await request(app)
        .get('/api/v1/sync/open-questions')
        .query({ taskRemoteId: fixture.taskAId })
        .set(fixture.teamBUser.authHeader);
      expect(deniedList.status).toBe(404);
      expect(deniedList.body.error.code).toBe('task_not_found');
    });

    it('denies cross-team command create, update, and list routes as task_not_found', async () => {
      const fixture = await seedTeamScopedFixture();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO commands (local_id, task_id, cmd_redacted, exit_code, summary, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING id`,
        ['command-a', fixture.taskAId, 'make build', 1, 'failed', fixture.teamAUser.userId, null, '2026-09-21T03:00:00Z'],
      );
      await pool.query(
        `INSERT INTO commands (local_id, task_id, cmd_redacted, exit_code, summary, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        ['command-b', fixture.taskBId, 'pnpm test', 0, 'passed', fixture.teamBUser.userId, null, '2026-09-21T03:01:00Z'],
      );

      const allowed = await request(app)
        .get('/api/v1/sync/commands')
        .query({ taskRemoteId: fixture.taskBId })
        .set(fixture.teamBUser.authHeader)
        .expect(200);
      expect(allowed.body.commands).toHaveLength(1);
      expect(allowed.body.commands[0].cmdRedacted).toBe('pnpm test');

      const deniedCreate = await request(app)
        .post('/api/v1/sync/commands')
        .set(fixture.teamBUser.authHeader)
        .send({
          commands: [
            {
              localId: 'command-new',
              remoteId: null,
              remoteTaskId: fixture.taskAId,
              cmdRedacted: 'rm -rf /tmp',
              exitCode: 1,
              summary: 'blocked',
              createdAt: '2026-09-21T03:02:00Z',
              updatedAt: '2026-09-21T03:02:00Z',
            },
          ],
        });
      expect(deniedCreate.status).toBe(404);
      expect(deniedCreate.body.error.code).toBe('task_not_found');

      const deniedUpdate = await request(app)
        .post('/api/v1/sync/commands')
        .set(fixture.teamBUser.authHeader)
        .send({
          commands: [
            {
              localId: 'command-a',
              remoteId: rows[0].id,
              remoteTaskId: fixture.taskAId,
              cmdRedacted: 'Blocked update',
              exitCode: 0,
              summary: 'should fail',
              createdAt: '2026-09-21T03:00:00Z',
              updatedAt: '2026-09-21T03:03:00Z',
            },
          ],
        });
      expect(deniedUpdate.status).toBe(404);
      expect(deniedUpdate.body.error.code).toBe('task_not_found');

      const deniedList = await request(app)
        .get('/api/v1/sync/commands')
        .query({ taskRemoteId: fixture.taskAId })
        .set(fixture.teamBUser.authHeader);
      expect(deniedList.status).toBe(404);
      expect(deniedList.body.error.code).toBe('task_not_found');
    });
  });

  // -------------------------------------------------------------------
  // Task 6 — encrypted capture upload + admin audit APIs.
  // -------------------------------------------------------------------
  describe('task file captures and admin audit', () => {
    const TASK_ID = '00000000-0000-0000-0000-000000000401';
    const OTHER_TASK_ID = '00000000-0000-0000-0000-000000000402';

    interface HistoryFixture {
      teamId: string;
      otherTeamId: string;
      admin: {
        userId: string;
        authHeader: { Authorization: string };
        session: AdminSessionHeaders;
      };
      member: { userId: string; authHeader: { Authorization: string } };
      inactive: { userId: string; authHeader: { Authorization: string } };
      outsider: { userId: string; authHeader: { Authorization: string } };
    }

    async function seedHistoryFixture(): Promise<HistoryFixture> {
      const teamId = await createDirectTeam('History team');
      const otherTeamId = await createDirectTeam('Other team');
      const admin = await createDirectUser('history-admin', DASHBOARD_PASSWORD);
      const member = await createDirectUser('history-member');
      const inactive = await createDirectUser('history-inactive');
      const outsider = await createDirectUser('history-outsider');

      await addMembership(teamId, admin.userId, 'admin');
      await addMembership(teamId, member.userId, 'member');
      await pool.query(
        `INSERT INTO team_memberships (team_id, user_id, role, active) VALUES ($1, $2, 'member', false)`,
        [teamId, inactive.userId],
      );
      await addMembership(otherTeamId, outsider.userId, 'admin');
      const adminSession = await openAdminSession(app, 'history-admin');

      await createDirectTask({
        taskId: TASK_ID,
        teamId,
        ownerUserId: admin.userId,
        localId: 'history-task',
        title: 'History task',
      });
      await createDirectTask({
        taskId: OTHER_TASK_ID,
        teamId: otherTeamId,
        ownerUserId: outsider.userId,
        localId: 'other-task',
        title: 'Other team task',
      });

      return {
        teamId,
        otherTeamId,
        admin: { ...admin, session: adminSession },
        member,
        inactive,
        outsider,
      };
    }

    function sha256(text: string): string {
      return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    }

    function captureEntry(path: string, content: string, unifiedDiff: string) {
      return {
        path,
        content,
        unifiedDiff,
        contentSha256: sha256(content),
        byteLength: Buffer.byteLength(content, 'utf8'),
      };
    }

    function captureBody(
      overrides: Partial<{
        captureId: string;
        trigger: string;
        gitCommitSha: string | null;
        checkpointId: string | null;
        createdAt: string;
        entries: unknown[];
      }> = {},
    ) {
      return {
        capture: {
          captureId: 'capture-1',
          trigger: 'explicit',
          gitCommitSha: null,
          checkpointId: null,
          createdAt: '2026-09-21T04:00:00.000Z',
          entries: [captureEntry('src/a.ts', 'export const a = 1;\n', '@@ -0,0 +1 @@\n+export const a = 1;\n')],
          ...overrides,
        },
      };
    }

    function captureUrl(taskId: string): string {
      return `/api/v1/sync/tasks/${taskId}/file-captures`;
    }

    /**
     * POSTs exact bytes to the real app over a loopback listener. supertest
     * re-serializes Buffer bodies as JSON, which would defeat any test that
     * depends on the precise request encoding.
     */
    async function postRawBytes(
      url: string,
      headers: Record<string, string>,
      body: Buffer,
    ): Promise<{ status: number; body: { error: { code: string; message: string } } }> {
      const server = app.listen(0);
      try {
        const { port } = server.address() as AddressInfo;
        return await new Promise((resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              path: url,
              method: 'POST',
              headers: {
                ...headers,
                'Content-Type': 'application/json',
                'Content-Length': String(body.length),
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
              });
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      } finally {
        server.close();
      }
    }

    it('stores an uploaded capture for an active member and is idempotent on retry', async () => {
      const fixture = await seedHistoryFixture();

      const first = await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody());
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ captureId: 'capture-1', status: 'stored', entryCount: 1 });

      const retry = await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody());
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ captureId: 'capture-1', status: 'duplicate', entryCount: 1 });

      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM task_file_captures WHERE team_id = $1',
        [fixture.teamId],
      );
      expect(rows[0].count).toBe('1');
    });

    it('never stores capture plaintext in Postgres', async () => {
      const fixture = await seedHistoryFixture();
      const secret = 'plaintext-marker-should-never-be-stored';

      await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody({ entries: [captureEntry('src/secret.ts', secret, `+${secret}`)] }))
        .expect(200);

      const { rows } = await pool.query<{ found: string }>(
        `SELECT count(*)::text AS found FROM encrypted_blobs
         WHERE position($1::bytea in ciphertext) > 0`,
        [Buffer.from(secret, 'utf8')],
      );
      expect(rows[0].found).toBe('0');
    });

    it('accepts a capture at the 10 MiB total-content limit', async () => {
      const fixture = await seedHistoryFixture();
      // Ten 1 MiB entries is exactly the documented per-capture ceiling, so the
      // route's body limit must admit a body of that size (plus JSON escaping).
      const entries = Array.from({ length: 10 }, (_unused, index) => {
        const content = `${'a'.repeat(1024 * 1024 - 8)}${String(index).padStart(8, '0')}`;
        return captureEntry(`src/big-${index}.txt`, content, `+big-${index}\n`);
      });

      const res = await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody({ entries }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'stored', entryCount: 10 });
    });

    it('rejects a capture entry over the per-file limit', async () => {
      const fixture = await seedHistoryFixture();
      const oversized = 'x'.repeat(1024 * 1024 + 1);

      const res = await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody({ entries: [captureEntry('src/huge.txt', oversized, '+huge\n')] }));
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('capture_too_large');
    });

    it('rejects request bodies over the route body limit as capture_too_large', async () => {
      const fixture = await seedHistoryFixture();
      const store = createTaskHistoryStore(pool, createTestEncryptionKeyring());
      const tinyApp = express();
      tinyApp.use(
        '/api/v1/sync',
        requireAuth(TEST_JWT_SECRET),
        createTaskHistoryRouter(pool, store, { bodyLimit: '1kb' }),
      );
      tinyApp.use(handleUnexpectedError);

      const res = await request(tinyApp)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody({ entries: [captureEntry('src/a.ts', 'y'.repeat(4096), '+y\n')] }));
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('capture_too_large');
    });

    it('rejects malformed UTF-8 request bytes', async () => {
      const fixture = await seedHistoryFixture();
      const valid = Buffer.from(JSON.stringify(captureBody()), 'utf8');
      // Splice an invalid continuation byte into the JSON payload.
      const malformed = Buffer.concat([valid.subarray(0, 10), Buffer.from([0xc3, 0x28]), valid.subarray(10)]);

      // supertest JSON-serializes Buffer bodies, so this one case talks to a
      // real listener to guarantee the exact bytes reach the server.
      const res = await postRawBytes(captureUrl(TASK_ID), fixture.member.authHeader, malformed);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_capture_encoding');
    });

    it('rejects capture text containing lone surrogates', async () => {
      const fixture = await seedHistoryFixture();
      const loneSurrogate = '\ud800';
      const body = {
        capture: {
          captureId: 'capture-surrogate',
          trigger: 'explicit',
          gitCommitSha: null,
          checkpointId: null,
          createdAt: '2026-09-21T04:00:00.000Z',
          entries: [
            {
              path: 'src/a.ts',
              content: loneSurrogate,
              unifiedDiff: '+bad\n',
              contentSha256: sha256(loneSurrogate),
              byteLength: Buffer.byteLength(loneSurrogate, 'utf8'),
            },
          ],
        },
      };

      const res = await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .set('Content-Type', 'application/json')
        // JSON.stringify emits lone surrogates as `\ud800` escapes, so the
        // request bytes stay valid UTF-8 and only the decoded string is ill-formed.
        .send(JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_capture_encoding');
    });

    it('rejects a capture entry whose content hash does not match', async () => {
      const fixture = await seedHistoryFixture();
      const entries = [captureEntry('src/a.ts', 'const a = 1;\n', '+const a = 1;\n')];
      entries[0].contentSha256 = sha256('something else');

      const res = await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody({ entries }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_capture');
    });

    it('rejects a capture entry whose byteLength does not match its content', async () => {
      const fixture = await seedHistoryFixture();
      const entries = [captureEntry('src/a.ts', 'const a = 1;\n', '+const a = 1;\n')];
      entries[0].byteLength = 4;

      const res = await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody({ entries }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_capture');
    });

    it('rejects traversal and absolute capture entry paths', async () => {
      const fixture = await seedHistoryFixture();

      for (const path of ['../outside.txt', '/etc/passwd', 'src/../../escape.txt']) {
        const res = await request(app)
          .post(captureUrl(TASK_ID))
          .set(fixture.member.authHeader)
          .send(captureBody({ entries: [captureEntry(path, 'nope\n', '+nope\n')] }));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_capture');
      }
    });

    it('denies capture upload from an inactive member before validating the body', async () => {
      const fixture = await seedHistoryFixture();

      const res = await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.inactive.authHeader)
        .set('Content-Type', 'application/json')
        .send('{"capture":');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('inactive_membership');
    });

    it('denies capture upload for a task outside the caller team before parsing the body', async () => {
      const fixture = await seedHistoryFixture();

      const res = await request(app)
        .post(captureUrl(OTHER_TASK_ID))
        .set(fixture.member.authHeader)
        .set('Content-Type', 'application/json')
        .send('{"capture":');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('task_not_found');
    });

    it('does not echo attacker-controlled schema values in validation errors', async () => {
      const fixture = await seedHistoryFixture();
      const attackerValue = 'attacker-controlled-trigger-value';

      const res = await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody({ trigger: attackerValue }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect(res.body.error.message).toBe('Capture upload body is invalid');
      expect(res.text).not.toContain(attackerValue);
    });

    it('rejects a non-UUID task id in the upload path', async () => {
      const fixture = await seedHistoryFixture();

      const res = await request(app)
        .post(captureUrl('not-a-uuid'))
        .set(fixture.member.authHeader)
        .send(captureBody());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    });

    it('restricts every admin audit route to a live singleton-admin session', async () => {
      const fixture = await seedHistoryFixture();
      await request(app).post(captureUrl(TASK_ID)).set(fixture.member.authHeader).send(captureBody()).expect(200);

      const auditUrls = [
        '/api/v1/admin/tasks',
        `/api/v1/admin/tasks/${TASK_ID}/timeline`,
        `/api/v1/admin/tasks/${TASK_ID}/file-captures/capture-1/files/src/a.ts`,
      ];

      // A member's sync bearer token carries no dashboard authority at all.
      for (const url of auditUrls) {
        const res = await request(app).get(url).set(fixture.member.authHeader);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('missing_session');
      }

      // Nor does an anonymous request.
      for (const url of auditUrls) {
        const res = await request(app).get(url);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('missing_session');
      }

      // A real session whose admin membership is gone is refused per request.
      await pool.query(`UPDATE team_memberships SET role = 'member' WHERE user_id = $1`, [
        fixture.admin.userId,
      ]);
      for (const url of auditUrls) {
        const res = await request(app).get(url).set(fixture.admin.session);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('admin_required');
      }
    });

    it('lists only the admin team tasks with capture counts', async () => {
      const fixture = await seedHistoryFixture();
      await request(app).post(captureUrl(TASK_ID)).set(fixture.member.authHeader).send(captureBody()).expect(200);

      const res = await request(app).get('/api/v1/admin/tasks').set(fixture.admin.session).expect(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0]).toMatchObject({
        taskId: TASK_ID,
        title: 'History task',
        owner: 'history-admin',
        captureCount: 1,
      });
      expect(res.body.hasMore).toBe(false);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('denies an admin timeline for a task outside the admin team', async () => {
      const fixture = await seedHistoryFixture();

      const res = await request(app)
        .get(`/api/v1/admin/tasks/${OTHER_TASK_ID}/timeline`)
        .set(fixture.admin.session);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('task_not_found');
    });

    it('returns a deterministic metadata-only timeline across every event kind', async () => {
      const fixture = await seedHistoryFixture();
      const at = (seconds: number) => `2026-09-21T05:00:${String(seconds).padStart(2, '0')}.000Z`;

      await pool.query(
        `INSERT INTO checkpoints (local_id, task_id, level, summary, owner_user_id, workspace_label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['ckpt-1', TASK_ID, 'session', 'Checkpoint summary', fixture.admin.userId, 'laptop', at(2)],
      );
      await pool.query(
        `INSERT INTO commands (local_id, task_id, cmd_redacted, exit_code, summary, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        ['cmd-1', TASK_ID, 'pnpm test', 0, 'passed', fixture.admin.userId, 'laptop', at(3)],
      );
      await pool.query(
        `INSERT INTO decisions (local_id, task_id, text, rationale, supersedes_id, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        ['dec-1', TASK_ID, 'Use Postgres', 'Because', null, fixture.admin.userId, 'laptop', at(4)],
      );
      await pool.query(
        `INSERT INTO todos (local_id, task_id, text, status, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        ['todo-1', TASK_ID, 'Write tests', 'done', fixture.admin.userId, 'laptop', at(5)],
      );
      await pool.query(
        `INSERT INTO errors (local_id, task_id, message, resolved, resolution, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        ['err-1', TASK_ID, 'TypeError', true, 'fixed', fixture.admin.userId, 'laptop', at(6)],
      );
      await pool.query(
        `INSERT INTO open_questions (local_id, task_id, text, resolved, owner_user_id, workspace_label, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        ['q-1', TASK_ID, 'Which DB?', false, fixture.admin.userId, 'laptop', at(7)],
      );

      // A commit capture and an explicit capture share one timestamp so the
      // tie-break by kind (and then id) is exercised, not just the clock.
      await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(
          captureBody({
            captureId: 'capture-commit',
            trigger: 'git_commit',
            gitCommitSha: 'abcdef1234567890abcdef1234567890abcdef12',
            createdAt: at(8),
            entries: [captureEntry('src/a.ts', 'const a = 1;\n', '+const a = 1;\n')],
          }),
        )
        .expect(200);
      await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(
          captureBody({
            captureId: 'capture-explicit',
            trigger: 'explicit',
            createdAt: at(8),
            entries: [captureEntry('src/b.ts', 'const b = 2;\n', '+const b = 2;\n')],
          }),
        )
        .expect(200);

      const res = await request(app)
        .get(`/api/v1/admin/tasks/${TASK_ID}/timeline`)
        .set(fixture.admin.session)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.taskId).toBe(TASK_ID);
      expect(res.body.events.map((event: { kind: string; id: string }) => [event.kind, event.id])).toEqual([
        ['task', TASK_ID],
        ['checkpoint', expect.any(String)],
        ['command', expect.any(String)],
        ['decision', expect.any(String)],
        ['todo', expect.any(String)],
        ['error', expect.any(String)],
        ['question', expect.any(String)],
        ['commit', 'abcdef1234567890abcdef1234567890abcdef12'],
        ['capture', 'capture-commit'],
        ['capture', 'capture-explicit'],
      ]);

      const captureEvent = res.body.events.find(
        (event: { kind: string; id: string }) => event.id === 'capture-commit',
      );
      expect(captureEvent.metadata).toMatchObject({
        trigger: 'git_commit',
        gitCommitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        checkpointId: null,
        entryCount: 1,
      });
      expect(captureEvent.metadata.files).toEqual([
        {
          path: 'src/a.ts',
          contentSha256: sha256('const a = 1;\n'),
          byteLength: Buffer.byteLength('const a = 1;\n', 'utf8'),
        },
      ]);
      // Metadata only — decrypted file content is served by its own endpoint.
      expect(JSON.stringify(res.body)).not.toContain('const a = 1;');
    });

    it('serves decrypted capture file content only from the dedicated endpoint', async () => {
      const fixture = await seedHistoryFixture();
      const content = 'export const answer = 42;\n';
      const diff = '@@ -0,0 +1 @@\n+export const answer = 42;\n';
      await request(app)
        .post(captureUrl(TASK_ID))
        .set(fixture.member.authHeader)
        .send(captureBody({ entries: [captureEntry('src/nested/answer.ts', content, diff)] }))
        .expect(200);

      const res = await request(app)
        .get(`/api/v1/admin/tasks/${TASK_ID}/file-captures/capture-1/files/src/nested/answer.ts`)
        .set(fixture.admin.session)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        path: 'src/nested/answer.ts',
        content,
        unifiedDiff: diff,
        contentSha256: sha256(content),
        byteLength: Buffer.byteLength(content, 'utf8'),
      });
    });

    it('rejects URL-encoded traversal in the audit file path', async () => {
      const fixture = await seedHistoryFixture();
      await request(app).post(captureUrl(TASK_ID)).set(fixture.member.authHeader).send(captureBody()).expect(200);

      for (const encodedPath of ['%2e%2e%2fsecret.txt', '..%2fsecret.txt', '%2Fetc%2Fpasswd', 'src%2f..%2f..%2fx.txt']) {
        const res = await request(app)
          .get(`/api/v1/admin/tasks/${TASK_ID}/file-captures/capture-1/files/${encodedPath}`)
          .set(fixture.admin.session);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
      }
    });

    it('returns 404 for an unknown capture or an unknown path inside a capture', async () => {
      const fixture = await seedHistoryFixture();
      await request(app).post(captureUrl(TASK_ID)).set(fixture.member.authHeader).send(captureBody()).expect(200);

      const unknownCapture = await request(app)
        .get(`/api/v1/admin/tasks/${TASK_ID}/file-captures/capture-missing/files/src/a.ts`)
        .set(fixture.admin.session);
      expect(unknownCapture.status).toBe(404);
      expect(unknownCapture.body.error.code).toBe('capture_not_found');

      const unknownPath = await request(app)
        .get(`/api/v1/admin/tasks/${TASK_ID}/file-captures/capture-1/files/src/missing.ts`)
        .set(fixture.admin.session);
      expect(unknownPath.status).toBe(404);
      expect(unknownPath.body.error.code).toBe('capture_file_not_found');
    });

    it('denies audit file reads for a capture on a task outside the admin team', async () => {
      const fixture = await seedHistoryFixture();
      await request(app)
        .post(captureUrl(OTHER_TASK_ID))
        .set(fixture.outsider.authHeader)
        .send(captureBody())
        .expect(200);

      const res = await request(app)
        .get(`/api/v1/admin/tasks/${OTHER_TASK_ID}/file-captures/capture-1/files/src/a.ts`)
        .set(fixture.admin.session);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('task_not_found');
    });
  });
});

describe('sync-server: admin operator operations', () => {
  let pool: Pool;
  let store: OperationsStore;
  let adminApp: Express;
  let failClosedApp: Express;
  let operator: FakeOperator;
  let operatorBehaviour: FakeOperatorBehaviour;

  interface RecordedOperatorRequest {
    url: string;
    method: string;
    body: unknown;
  }

  interface FakeOperator {
    socketPath: string;
    dir: string;
    requests: RecordedOperatorRequest[];
    close(): Promise<void>;
  }

  type FakeOperatorBehaviour =
    | { kind: 'accept' }
    | { kind: 'busy' }
    | { kind: 'malformed' }
    | { kind: 'reset' }
    | { kind: 'hang' };

  async function startFakeOperator(): Promise<FakeOperator> {
    const dir = await mkdtemp(path.join(tmpdir(), 'ariadne-admin-ops-'));
    const socketPath = path.join(dir, 'operator.sock');
    const requests: RecordedOperatorRequest[] = [];

    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        requests.push({ url: req.url ?? '', method: req.method ?? '', body: parsed });

        if (operatorBehaviour.kind === 'hang') {
          return;
        }
        if (operatorBehaviour.kind === 'busy') {
          res.statusCode = 409;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'operator_busy' }));
          return;
        }
        if (operatorBehaviour.kind === 'malformed') {
          res.statusCode = 202;
          res.end('definitely not json');
          return;
        }
        if (operatorBehaviour.kind === 'reset') {
          res.socket?.destroy();
          return;
        }
        const operationId = (parsed as { operationId?: string }).operationId ?? '';
        res.statusCode = 202;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ operationId, accepted: true }));
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
      dir,
      requests,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  /**
   * The operations router behind the real dashboard middleware: a database
   * session, the CSRF/Origin check, and the reauthentication marker derived
   * from the session's own five-minute window. Nothing here injects the marker
   * by hand, so these tests exercise the shipped authorization path.
   */
  function buildAdminOperationsApp(options: {
    operatorClient: OperatorClient | null;
    heartbeatIntervalMs?: number;
    pollIntervalMs?: number;
    maxStreamDurationMs?: number;
  }): Express {
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/v1/admin', (req, _res, next) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (req.method === 'POST' && req.path === '/operations/service-restart') {
        if (typeof body.service === 'string' && typeof body.confirmation !== 'string') {
          body.confirmation = confirmationFor.serviceRestart(
            body.service as 'sync-server' | 'postgres',
          );
        }
      } else if (req.method === 'POST' && req.path === '/operations/deploy') {
        if (typeof body.revision === 'string' && typeof body.confirmation !== 'string') {
          body.confirmation = confirmationFor.deploy(body.revision);
        }
      } else if (req.method === 'POST' && /\/operations\/backups\/.+\/restore$/.test(req.path)) {
        const backupName = decodeURIComponent(req.path.split('/').at(-2) ?? '');
        if (backupName && typeof body.confirmation !== 'string') {
          body.confirmation = confirmationFor.restore(backupName);
        }
      }
      req.body = body;
      next();
    });
    testApp.use(
      '/api/v1/admin',
      requireAdminSession(pool),
      requireCsrf({ allowedOrigin: null }),
      createAdminOperationsRouter(pool, {
        operationsStore: store,
        operatorClient: options.operatorClient,
        operatorQueryClient: {
          query: async (operatorQuery) => {
            switch (operatorQuery.type) {
              case 'deployment_status':
                return {
                  currentRevision: 'a'.repeat(40),
                  rollbackRevision: 'b'.repeat(40),
                  schemaVersion: 10,
                  candidates: [
                    {
                      revision: 'b'.repeat(40),
                      committedAt: '2026-09-23T09:00:00Z',
                      subject: 'feat: deployable',
                    },
                    {
                      revision: 'c'.repeat(40),
                      committedAt: '2026-09-23T10:00:00Z',
                      subject: 'feat: second deployable',
                    },
                  ],
                };
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
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        pollIntervalMs: options.pollIntervalMs,
        maxStreamDurationMs: options.maxStreamDurationMs,
      }),
    );
    testApp.use(handleUnexpectedError);
    return testApp;
  }

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    store = createOperationsStore(pool);
    operator = await startFakeOperator();
    operatorBehaviour = { kind: 'accept' };
    adminApp = buildAdminOperationsApp({
      operatorClient: createOperatorClient({
        socketPath: operator.socketPath,
        requestTimeoutMs: 400,
      }),
    });
    failClosedApp = createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      operatorClient: createOperatorClient({ socketPath: operator.socketPath }),
    });
  });

  afterAll(async () => {
    await operator.close();
    await rm(operator.dir, { recursive: true, force: true });
    await pool.end();
  });

  let adminUserId: string;
  let adminSession: AdminSessionHeaders;
  let staleSession: AdminSessionHeaders;
  let memberToken: string;

  beforeEach(async () => {
    await truncateFixtureTables(pool, TASK_HISTORY_FIXTURE_TABLES);
    operator.requests.length = 0;
    operatorBehaviour = { kind: 'accept' };

    await request(failClosedApp)
      .post('/api/v1/auth/register')
      .send({ username: 'ops-admin', password: DASHBOARD_PASSWORD })
      .expect(201);
    const adminRow = await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [
      'ops-admin',
    ]);
    adminUserId = adminRow.rows[0].id;

    await request(failClosedApp)
      .post('/api/v1/auth/register')
      .send({ username: 'ops-member', password: DASHBOARD_PASSWORD })
      .expect(201);
    const memberLogin = await request(failClosedApp)
      .post('/api/v1/auth/login')
      .send({ username: 'ops-member', password: DASHBOARD_PASSWORD })
      .expect(200);
    memberToken = memberLogin.body.token as string;

    // Two live sessions for the same admin: one that has just proved its
    // password, and one that never did.
    adminSession = await openAdminSession(failClosedApp, 'ops-admin');
    await reauthenticateAdminSession(failClosedApp, adminSession);
    staleSession = await openAdminSession(failClosedApp, 'ops-admin');
  });

  /** A reauthenticated dashboard session, as every privileged action requires. */
  function adminAuth(): AdminSessionHeaders {
    return adminSession;
  }

  /** A valid session that has not reauthenticated within the last five minutes. */
  function staleAuth(): AdminSessionHeaders {
    return staleSession;
  }

  it('accepts a service restart, persisting the queued record before submission', async () => {
    const res = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.operation).toMatchObject({
      type: 'service_restart',
      state: 'queued',
      requestedBy: adminUserId,
    });

    const operationId = res.body.operation.id as string;
    expect(operator.requests).toEqual([
      {
        url: '/v1/operations',
        method: 'POST',
        body: { operationId, type: 'service_restart', service: 'sync-server' },
      },
    ]);

    const persisted = await store.getOperation(operationId);
    expect(persisted).toMatchObject({ state: 'queued', type: 'service_restart' });

    const events = await store.listOperationEvents(operationId);
    expect(events.map((event) => event.state)).toEqual(['queued']);

    const { events: audit } = await store.listAuditEvents({ limit: 50 });
    expect(audit.some((event) => event.action === 'admin_operation.created')).toBe(true);
  });

  it('lists and fetches persisted operations for the admin', async () => {
    const created = await request(adminApp)
      .post('/api/v1/admin/operations/backups')
      .set(adminAuth())
      .send({})
      .expect(202);
    const operationId = created.body.operation.id as string;

    const list = await request(adminApp)
      .get('/api/v1/admin/operations')
      .set(adminAuth())
      .expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.operations.map((operation: { id: string }) => operation.id)).toContain(
      operationId,
    );

    const single = await request(adminApp)
      .get(`/api/v1/admin/operations/${operationId}`)
      .set(adminAuth())
      .expect(200);
    expect(single.body.operation).toMatchObject({ id: operationId, type: 'backup_create' });

    const missing = await request(adminApp)
      .get('/api/v1/admin/operations/does-not-exist')
      .set(adminAuth());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('operation_not_found');
  });

  it('creates a distinct operation id per request instead of reusing one', async () => {
    const first = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'postgres',
        confirmation: confirmationFor.serviceRestart('postgres'),
      })
      .expect(202);
    const second = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'postgres',
        confirmation: confirmationFor.serviceRestart('postgres'),
      })
      .expect(202);

    expect(second.body.operation.id).not.toBe(first.body.operation.id);
    expect(operator.requests).toHaveLength(2);
  });

  it('fails closed for a session that has not reauthenticated', async () => {
    const res = await request(failClosedApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(staleAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('reauthentication_required');
    expect(operator.requests).toHaveLength(0);
    expect((await store.listOperations({ limit: 50 })).operations).toEqual([]);
  });

  it('refuses a member bearer token instead of authorizing it as a dashboard session', async () => {
    const res = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set({ Authorization: `Bearer ${memberToken}` })
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('missing_session');
    expect(operator.requests).toHaveLength(0);
    expect((await store.listOperations({ limit: 50 })).operations).toEqual([]);
  });

  it('denies a reauthenticated session whose admin membership was revoked', async () => {
    await pool.query(`UPDATE team_memberships SET role = 'member' WHERE user_id = $1`, [
      adminUserId,
    ]);

    const res = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('admin_required');
    expect(operator.requests).toHaveLength(0);
    expect((await store.listOperations({ limit: 50 })).operations).toEqual([]);
  });

  it('rejects a privileged operation that carries no CSRF token', async () => {
    const res = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set({ Cookie: adminAuth().Cookie })
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
    expect(operator.requests).toHaveLength(0);
    expect((await store.listOperations({ limit: 50 })).operations).toEqual([]);
  });

  it('rejects a privileged operation sent from a foreign origin', async () => {
    const res = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .set('Origin', 'https://evil.example.test')
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('origin_not_allowed');
    expect(operator.requests).toHaveLength(0);
    expect((await store.listOperations({ limit: 50 })).operations).toEqual([]);
  });

  it('requires authentication', async () => {
    const res = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });
    expect(res.status).toBe(401);
  });

  it('rejects invalid operation parameters before creating a record', async () => {
    const badService = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({ service: 'rm -rf' });
    expect(badService.status).toBe(400);
    expect(badService.body.error.code).toBe('invalid_request');

    const badRevision = await request(adminApp)
      .post('/api/v1/admin/operations/deploy')
      .set(adminAuth())
      .send({ revision: 'HEAD' });
    expect(badRevision.status).toBe(400);
    expect(badRevision.body.error.code).toBe('invalid_request');

    // Already percent-encoded: a literal `..` segment is normalised away before
    // routing, so the encoded forms are what actually reach the handler.
    for (const encodedName of ['%2e%2e%2fetc%2fpasswd', 'nested%2Fbackup.dump', '.hidden']) {
      const badBackup = await request(adminApp)
        .post(`/api/v1/admin/operations/backups/${encodedName}/verify`)
        .set(adminAuth())
        .send({});
      expect(badBackup.status).toBe(400);
      expect(badBackup.body.error.code).toBe('invalid_request');
    }

    // A bare `..` segment is normalised away by the client/router and never
    // reaches the handler at all.
    const dotSegment = await request(adminApp)
      .post('/api/v1/admin/operations/backups/%2e%2e/verify')
      .set(adminAuth())
      .send({});
    expect(dotSegment.status).toBe(404);

    expect(operator.requests).toHaveLength(0);
    expect((await store.listOperations({ limit: 50 })).operations).toEqual([]);
  });

  it('submits deploy and backup verify/restore with the operator wire shape', async () => {
    const revision = 'b'.repeat(40);
    await store.upsertBackupRecord({
      filename: 'ariadne-2026-09-21.dump',
      sha256: 'd'.repeat(64),
      sizeBytes: 1024,
      status: 'verified',
      createdAt: '2026-09-21T00:00:00Z',
      verifiedAt: '2026-09-21T00:01:00Z',
    });
    const deploy = await request(adminApp)
      .post('/api/v1/admin/operations/deploy')
      .set(adminAuth())
      .send({ revision, confirmation: confirmationFor.deploy(revision) })
      .expect(202);
    const verify = await request(adminApp)
      .post('/api/v1/admin/operations/backups/ariadne-2026-09-21.dump/verify')
      .set(adminAuth())
      .send({})
      .expect(202);
    const restore = await request(adminApp)
      .post('/api/v1/admin/operations/backups/ariadne-2026-09-21.dump/restore')
      .set(adminAuth())
      .send({ confirmation: confirmationFor.restore('ariadne-2026-09-21.dump') })
      .expect(202);

    expect(operator.requests.map((recorded) => recorded.body)).toEqual([
      { operationId: deploy.body.operation.id, type: 'deployment_apply', revision },
      {
        operationId: verify.body.operation.id,
        type: 'backup_verify',
        backupName: 'ariadne-2026-09-21.dump',
      },
      {
        operationId: restore.body.operation.id,
        type: 'backup_restore',
        backupName: 'ariadne-2026-09-21.dump',
      },
    ]);
    expect(deploy.body.operation.type).toBe('deployment_apply');
    expect(verify.body.operation.type).toBe('backup_verify');
    expect(restore.body.operation.type).toBe('backup_restore');
  });

  it('fails the operation when the operator socket is absent before any acceptance is possible', async () => {
    const unavailableApp = buildAdminOperationsApp({
      operatorClient: createOperatorClient({
        socketPath: path.join(operator.dir, 'absent.sock'),
        requestTimeoutMs: 400,
      }),
    });

    const res = await request(unavailableApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('operator_connect_failed');
    expect(res.body.error.message).not.toContain('absent.sock');
    expect(res.body.error.message).not.toContain(operator.dir);

    const { operations } = await store.listOperations({ limit: 50 });
    expect(operations).toHaveLength(1);
    expect(operations[0].state).toBe('failed');
    const { events: audit } = await store.listAuditEvents({ limit: 50 });
    expect(
      audit.some(
        (event) =>
          event.action === 'admin_operation.state_changed' &&
          event.outcome === 'failed' &&
          event.metadata.operationId === operations[0].id &&
          event.metadata.toState === 'failed' &&
          event.metadata.reason === 'operator_connect_failed',
      ),
    ).toBe(true);
  });

  it('fails the operation when the operator socket path refuses the connection', async () => {
    const closedOperator = await startFakeOperator();
    await closedOperator.close();
    const refusedApp = buildAdminOperationsApp({
      operatorClient: createOperatorClient({
        socketPath: closedOperator.socketPath,
        requestTimeoutMs: 400,
      }),
    });

    const res = await request(refusedApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('operator_connect_failed');

    const { operations } = await store.listOperations({ limit: 50 });
    expect(operations).toHaveLength(1);
    expect(operations[0].state).toBe('failed');
  });

  it('keeps the operation queued when transport loss is ambiguous and later success arrives', async () => {
    operatorBehaviour = { kind: 'reset' };

    const res = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('operator_unavailable');

    const { operations } = await store.listOperations({ limit: 50 });
    expect(operations).toHaveLength(1);
    expect(operations[0].state).toBe('queued');
    const { events: audit } = await store.listAuditEvents({ limit: 50 });
    expect(
      audit.some(
        (event) =>
          event.action === 'admin_operation.submission_uncertain' &&
          event.outcome === 'queued' &&
          event.metadata.operationId === operations[0].id &&
          event.metadata.reason === 'operator_unavailable' &&
          event.metadata.message ===
            'Operator submission status is uncertain; awaiting callback or reconciliation',
      ),
    ).toBe(true);

    await store.transitionOperation({
      id: operations[0].id,
      nextState: 'running',
      source: 'operator_callback',
      message: 'Operator attached after delayed acceptance',
    });
    await store.transitionOperation({
      id: operations[0].id,
      nextState: 'succeeded',
      source: 'operator_callback',
      message: 'Operator completed after delayed acceptance',
    });

    const afterCallback = await store.getOperation(operations[0].id);
    expect(afterCallback?.state).toBe('succeeded');
    const events = await store.listOperationEvents(operations[0].id);
    expect(events.some((event) => event.state === 'running')).toBe(true);
    expect(events.some((event) => event.state === 'succeeded')).toBe(true);
  });

  it('returns 503 and records a failure when no operator socket is configured', async () => {
    const unconfiguredApp = buildAdminOperationsApp({ operatorClient: null });

    const res = await request(unconfiguredApp)
      .post('/api/v1/admin/operations/backups')
      .set(adminAuth())
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('operator_unavailable');
    const { operations } = await store.listOperations({ limit: 50 });
    expect(operations).toHaveLength(1);
    expect(operations[0].state).toBe('failed');
  });

  it('maps an operator timeout to 504, keeps the operation queued, and allows later failure callbacks', async () => {
    operatorBehaviour = { kind: 'hang' };

    const res = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('operator_timeout');
    const { operations } = await store.listOperations({ limit: 50 });
    expect(operations[0].state).toBe('queued');
    const { events: audit } = await store.listAuditEvents({ limit: 50 });
    expect(
      audit.some(
        (event) =>
          event.action === 'admin_operation.submission_uncertain' &&
          event.outcome === 'queued' &&
          event.metadata.operationId === operations[0].id &&
          event.metadata.reason === 'operator_timeout' &&
          event.metadata.message ===
            'Operator submission status is uncertain; awaiting callback or reconciliation',
      ),
    ).toBe(true);

    await store.transitionOperation({
      id: operations[0].id,
      nextState: 'running',
      source: 'operator_callback',
      message: 'Operator reported late start',
    });
    await store.transitionOperation({
      id: operations[0].id,
      nextState: 'failed',
      source: 'operator_callback',
      message: 'Operator eventually reported failure',
    });

    const afterCallback = await store.getOperation(operations[0].id);
    expect(afterCallback?.state).toBe('failed');
  });

  it('keeps the operation queued when the operator response is unusable after acceptance', async () => {
    operatorBehaviour = { kind: 'malformed' };

    const res = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('operator_invalid_response');

    // A malformed or oversized acceptance body can be produced *after* the
    // operator already admitted the operation, so the submission is uncertain
    // rather than failed: the operation stays queued and awaits the callback.
    const { operations } = await store.listOperations({ limit: 50 });
    expect(operations).toHaveLength(1);
    expect(operations[0].state).toBe('queued');

    const { events: audit } = await store.listAuditEvents({ limit: 50 });
    expect(
      audit.some(
        (event) =>
          event.action === 'admin_operation.submission_uncertain' &&
          event.outcome === 'queued' &&
          event.metadata.operationId === operations[0].id &&
          event.metadata.reason === 'operator_invalid_response' &&
          event.metadata.message ===
            'Operator submission status is uncertain; awaiting callback or reconciliation',
      ),
    ).toBe(true);

    await store.transitionOperation({
      id: operations[0].id,
      nextState: 'running',
      source: 'operator_callback',
      message: 'Operator reported start after an unusable acceptance body',
    });
    await store.transitionOperation({
      id: operations[0].id,
      nextState: 'succeeded',
      source: 'operator_callback',
      message: 'Operator completed after an unusable acceptance body',
    });

    expect((await store.getOperation(operations[0].id))?.state).toBe('succeeded');
  });

  it('maps a busy operator to 409 so the dashboard can reattach instead of retrying', async () => {
    operatorBehaviour = { kind: 'busy' };

    const res = await request(adminApp)
      .post('/api/v1/admin/operations/deploy')
      .set(adminAuth())
      .send({
        revision: 'c'.repeat(40),
        confirmation: confirmationFor.deploy('c'.repeat(40)),
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('operator_busy');
    const { operations } = await store.listOperations({ limit: 50 });
    expect(operations[0].state).toBe('failed');
  });

  it('surfaces failed-state persistence uncertainty instead of returning an ordinary operator error', async () => {
    const transitionSpy = vi
      .spyOn(store, 'transitionOperation')
      .mockRejectedValueOnce(
        Object.assign(new Error('database write failed'), {
          code: '57P01',
          severity: 'ERROR',
        }),
      );
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unconfiguredApp = buildAdminOperationsApp({ operatorClient: null });

    const res = await request(unconfiguredApp)
      .post('/api/v1/admin/operations/backups')
      .set(adminAuth())
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'database_unavailable',
      message: 'Database is unavailable',
    });
    expect(logSpy).toHaveBeenCalledWith(
      'Failed to record operator submission failure',
      expect.objectContaining({ reason: 'operator_unavailable' }),
    );
    const { operations } = await store.listOperations({ limit: 50 });
    expect(operations).toHaveLength(1);
    expect(operations[0].state).toBe('queued');

    transitionSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('emits a timeout event before closing a long-lived nonterminal stream', async () => {
    const created = await request(adminApp)
      .post('/api/v1/admin/operations/backups')
      .set(adminAuth())
      .send({})
      .expect(202);
    const operationId = created.body.operation.id as string;
    const streamingApp = buildAdminOperationsApp({
      operatorClient: null,
      heartbeatIntervalMs: 100,
      pollIntervalMs: 100,
      maxStreamDurationMs: 20,
    });

    const stream = await request(streamingApp)
      .get(`/api/v1/admin/operations/${operationId}/events`)
      .set(adminAuth())
      .expect(200);

    expect(stream.text).toContain('event: timeout');
    expect(stream.text).toContain(`"operationId":"${operationId}"`);
  });

  it('streams persisted events plus a heartbeat and closes on a terminal state', async () => {
    const created = await request(adminApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
      })
      .expect(202);
    const operationId = created.body.operation.id as string;

    const streamingApp = buildAdminOperationsApp({
      operatorClient: null,
      heartbeatIntervalMs: 40,
      pollIntervalMs: 25,
    });
    const server = streamingApp.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const stream = await new Promise<{ status: number; headers: Record<string, unknown>; text: string }>(
        (resolve, reject) => {
          const chunks: string[] = [];
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              path: `/api/v1/admin/operations/${operationId}/events`,
              method: 'GET',
              headers: { ...adminAuth(), Accept: 'text/event-stream' },
            },
            (response) => {
              response.setEncoding('utf8');
              response.on('data', (chunk: string) => {
                chunks.push(chunk);
                if (chunks.join('').includes(': heartbeat')) {
                  void store
                    .transitionOperation({
                      id: operationId,
                      nextState: 'running',
                      source: 'test',
                      message: 'Operation running',
                    })
                    .then(() =>
                      store.transitionOperation({
                        id: operationId,
                        nextState: 'succeeded',
                        source: 'test',
                        message: 'Operation succeeded',
                      }),
                    )
                    .catch(() => undefined);
                }
              });
              response.on('end', () =>
                resolve({
                  status: response.statusCode ?? 0,
                  headers: response.headers as Record<string, unknown>,
                  text: chunks.join(''),
                }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        },
      );

      expect(stream.status).toBe(200);
      expect(String(stream.headers['content-type'])).toContain('text/event-stream');
      expect(stream.headers['cache-control']).toBe('no-store');
      expect(stream.text).toContain(': heartbeat');
      expect(stream.text).toContain('event: operation_event');
      expect(stream.text).toContain('"state":"queued"');
      expect(stream.text).toContain('"state":"running"');
      expect(stream.text).toContain('"state":"succeeded"');
      expect(stream.text).toContain('event: complete');
    } finally {
      server.close();
    }
  });

  it('refuses event streams for unknown operations and unauthenticated callers', async () => {
    const missing = await request(adminApp)
      .get('/api/v1/admin/operations/nope/events')
      .set(adminAuth());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('operation_not_found');

    const created = await request(adminApp)
      .post('/api/v1/admin/operations/backups')
      .set(adminAuth())
      .send({})
      .expect(202);

    const withoutReauth = await request(failClosedApp)
      .get(`/api/v1/admin/operations/${created.body.operation.id}/events`)
      .set(staleAuth());
    expect(withoutReauth.status).toBe(403);
    expect(withoutReauth.body.error.code).toBe('reauthentication_required');

    const asMember = await request(adminApp)
      .get(`/api/v1/admin/operations/${created.body.operation.id}/events`)
      .set({ Authorization: `Bearer ${memberToken}` });
    expect(asMember.status).toBe(401);
    expect(asMember.body.error.code).toBe('missing_session');
  });

  it('never persists request secrets or OS paths in operation metadata', async () => {
    const unavailableApp = buildAdminOperationsApp({
      operatorClient: createOperatorClient({
        socketPath: path.join(operator.dir, 'absent.sock'),
        requestTimeoutMs: 400,
      }),
    });
    await request(unavailableApp)
      .post('/api/v1/admin/operations/service-restart')
      .set(adminAuth())
      .send({
        service: 'sync-server',
        confirmation: confirmationFor.serviceRestart('sync-server'),
        password: 'super-secret-value',
      })
      .expect(503);

    const { operations } = await store.listOperations({ limit: 50 });
    const events = await store.listOperationEvents(operations[0].id);
    const { events: audit } = await store.listAuditEvents({ limit: 50 });
    const serialized = JSON.stringify({ operations, events, audit });
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain(operator.dir);
    expect(serialized).not.toContain('.sock');
  });

  describe('operator result callbacks', () => {
    const OPERATOR_TOKEN = 'a'.repeat(64);
    let callbackApp: Express;
    let callbackToken: string | null;
    let peerUid: number | null;

    beforeAll(() => {
      callbackApp = express();
      // Mirrors app.ts: the callback router carries its own bounded parser and
      // is mounted ahead of the 100 KB global parser.
      callbackApp.use(
        '/api/v1/admin',
        createOperatorCallbackRouter({
          operationsStore: store,
          readCallbackToken: () => callbackToken,
          verifyPeerUid: () => peerUid,
        }),
      );
      callbackApp.use(express.json());
      callbackApp.post('/api/v1/other', (req, res) => {
        res.status(200).json({ received: typeof req.body });
      });
      callbackApp.use(handleUnexpectedError);
    });

    beforeEach(() => {
      callbackToken = OPERATOR_TOKEN;
      peerUid = null;
    });

    async function queueOperation(
      id: string,
      type: AdminOperationType = 'backup_create',
    ): Promise<string> {
      await store.createOperation({
        id,
        requestedBy: adminUserId,
        type,
        summary: `Operation ${type}`,
        source: ADMIN_OPERATION_SOURCE,
        metadata: {},
      });
      return id;
    }

    const BACKUP_DESCRIPTION = {
      filename: 'ariadne-20260401T021500Z.dump',
      sha256: 'a'.repeat(64),
      sizeBytes: 4096,
      createdAt: '2026-04-01T02:15:00Z',
      message: 'backup published and checksummed',
    };

    function callback(operationId: string, body: unknown, token: string | null = OPERATOR_TOKEN) {
      const pending = request(callbackApp).post(
        `/api/v1/admin/operations/${operationId}/callback`,
      );
      if (token !== null) {
        pending.set('x-ariadne-operator-token', token);
      }
      return pending.send(body as object);
    }

    it('records a started then succeeded operation using legal transitions', async () => {
      const operationId = await queueOperation('cb-success');

      const started = await callback(operationId, {
        operationId,
        state: 'running',
        message: 'Operation started',
      });
      expect(started.status).toBe(200);
      expect(started.body.operation.state).toBe('running');

      const finished = await callback(operationId, {
        operationId,
        state: 'succeeded',
        message: 'Operation succeeded',
        output: 'published backup ariadne-20260101T000000Z.dump',
        metadata: { exitCode: 0 },
      });
      expect(finished.status).toBe(200);
      expect(finished.body.operation.state).toBe('succeeded');

      const persisted = await store.getOperation(operationId);
      expect(persisted).toMatchObject({ state: 'succeeded' });
      expect(persisted?.output).toContain('published backup');
      expect(persisted?.startedAt).not.toBeNull();
      expect(persisted?.completedAt).not.toBeNull();

      const events = await store.listOperationEvents(operationId);
      expect(events.map((event) => event.state)).toEqual(['queued', 'running', 'succeeded']);

      const { events: audit } = await store.listAuditEvents({ limit: 50 });
      expect(
        audit.some(
          (event) =>
            event.action === 'admin_operation.state_changed' &&
            event.source === 'operator_callback' &&
            event.outcome === 'succeeded',
        ),
      ).toBe(true);
    });

    it('starts a queued operation before recording a terminal result', async () => {
      const operationId = await queueOperation('cb-terminal-only');

      const finished = await callback(operationId, {
        operationId,
        state: 'failed',
        message: 'Operation failed',
        output: 'exited with code 2',
      });
      expect(finished.status).toBe(200);

      const events = await store.listOperationEvents(operationId);
      expect(events.map((event) => event.state)).toEqual(['queued', 'running', 'failed']);
    });

    it('treats a repeated running callback as idempotent', async () => {
      const operationId = await queueOperation('cb-repeat-running');

      await callback(operationId, { operationId, state: 'running' }).expect(200);
      const repeated = await callback(operationId, { operationId, state: 'running' });
      expect(repeated.status).toBe(200);

      const events = await store.listOperationEvents(operationId);
      expect(events.map((event) => event.state)).toEqual(['queued', 'running']);
    });

    it('refuses to reopen a terminal operation', async () => {
      const operationId = await queueOperation('cb-terminal-guard');
      await callback(operationId, { operationId, state: 'running' }).expect(200);
      await callback(operationId, { operationId, state: 'succeeded' }).expect(200);

      const reopened = await callback(operationId, { operationId, state: 'running' });
      expect(reopened.status).toBe(409);
      expect(reopened.body.error.code).toBe('illegal_transition');
      expect((await store.getOperation(operationId))?.state).toBe('succeeded');
    });

    it('records a backup artifact reported by a terminal backup_create callback', async () => {
      const operationId = await queueOperation('cb-backup-created', 'backup_create');

      const finished = await callback(operationId, {
        operationId,
        state: 'succeeded',
        message: 'Operation succeeded',
        output: 'published backup ariadne-20260401T021500Z.dump',
        backup: BACKUP_DESCRIPTION,
      });
      expect(finished.status).toBe(200);

      const records = await store.listBackupRecords();
      expect(records).toContainEqual({
        filename: BACKUP_DESCRIPTION.filename,
        sha256: BACKUP_DESCRIPTION.sha256,
        sizeBytes: BACKUP_DESCRIPTION.sizeBytes,
        status: 'created',
        createdAt: '2026-04-01T02:15:00.000Z',
        verifiedAt: null,
        restoreVerificationMessage: BACKUP_DESCRIPTION.message,
      });
    });

    it('records verification outcomes against the backup that was examined', async () => {
      const verified = await queueOperation('cb-backup-verified', 'backup_verify');
      await callback(verified, {
        operationId: verified,
        state: 'succeeded',
        backup: { ...BACKUP_DESCRIPTION, message: 'verified: schema 0008, 12 tables' },
      }).expect(200);

      const afterSuccess = (await store.listBackupRecords()).find(
        (record) => record.filename === BACKUP_DESCRIPTION.filename,
      );
      expect(afterSuccess).toMatchObject({
        status: 'verified',
        restoreVerificationMessage: 'verified: schema 0008, 12 tables',
      });
      expect(afterSuccess?.verifiedAt).not.toBeNull();

      const failed = await queueOperation('cb-backup-verify-failed', 'backup_verify');
      await callback(failed, {
        operationId: failed,
        state: 'failed',
        backup: { ...BACKUP_DESCRIPTION, message: undefined },
      }).expect(200);

      const afterFailure = (await store.listBackupRecords()).find(
        (record) => record.filename === BACKUP_DESCRIPTION.filename,
      );
      expect(afterFailure).toMatchObject({
        status: 'verify_failed',
        createdAt: '2026-04-01T02:15:00.000Z',
      });
      // The historical verification timestamp survives a later failure.
      expect(afterFailure?.verifiedAt).toBe(afterSuccess?.verifiedAt);
    });

    it('records a restore outcome for the backup it restored', async () => {
      const operationId = await queueOperation('cb-backup-restored', 'backup_restore');

      await callback(operationId, {
        operationId,
        state: 'succeeded',
        backup: {
          ...BACKUP_DESCRIPTION,
          message: 'restored; previous database retained under a timestamped name',
        },
      }).expect(200);

      expect(
        (await store.listBackupRecords()).find(
          (record) => record.filename === BACKUP_DESCRIPTION.filename,
        ),
      ).toMatchObject({
        status: 'restored',
        restoreVerificationMessage: 'restored; previous database retained under a timestamped name',
      });
    });

    it('writes no backup record for a failed backup_create or a non-backup operation', async () => {
      const unpublished = { ...BACKUP_DESCRIPTION, filename: 'ariadne-20260402T021500Z.dump' };

      const created = await queueOperation('cb-backup-create-failed', 'backup_create');
      await callback(created, {
        operationId: created,
        state: 'failed',
        backup: unpublished,
      }).expect(200);

      const restart = await queueOperation('cb-restart-with-backup', 'service_restart');
      await callback(restart, {
        operationId: restart,
        state: 'succeeded',
        backup: unpublished,
      }).expect(200);

      expect(
        (await store.listBackupRecords()).some(
          (record) => record.filename === unpublished.filename,
        ),
      ).toBe(false);
    });

    it('accepts a retried terminal callback as success without duplicating state', async () => {
      const operationId = await queueOperation('cb-terminal-retry', 'backup_create');

      const first = await callback(operationId, {
        operationId,
        state: 'succeeded',
        output: 'published',
        backup: BACKUP_DESCRIPTION,
      });
      expect(first.status).toBe(200);

      const retried = await callback(operationId, {
        operationId,
        state: 'succeeded',
        output: 'published',
        backup: BACKUP_DESCRIPTION,
      });
      expect(retried.status).toBe(200);
      expect(retried.body.operation.state).toBe('succeeded');

      const events = await store.listOperationEvents(operationId);
      expect(events.map((event) => event.state)).toEqual(['queued', 'running', 'succeeded']);
      expect(
        (await store.listBackupRecords()).filter(
          (record) => record.filename === BACKUP_DESCRIPTION.filename,
        ),
      ).toHaveLength(1);
    });

    it('still refuses a terminal callback that contradicts the recorded outcome', async () => {
      const operationId = await queueOperation('cb-terminal-conflict', 'backup_create');
      await callback(operationId, { operationId, state: 'succeeded' }).expect(200);

      const conflicting = await callback(operationId, { operationId, state: 'failed' });
      expect(conflicting.status).toBe(409);
      expect(conflicting.body.error.code).toBe('illegal_transition');
      expect((await store.getOperation(operationId))?.state).toBe('succeeded');
    });

    it('rejects a backup description that is not a validated backup artifact', async () => {
      const operationId = await queueOperation('cb-backup-invalid', 'backup_create');
      const candidate = { ...BACKUP_DESCRIPTION, filename: 'ariadne-20260403T021500Z.dump' };

      for (const backup of [
        { ...candidate, filename: '../../etc/passwd' },
        { ...candidate, sha256: 'not-a-digest' },
        { ...candidate, sizeBytes: -1 },
        { ...candidate, createdAt: 'yesterday' },
        { ...candidate, message: 'x'.repeat(5000) },
        { ...candidate, extra: 'field' },
      ]) {
        const res = await callback(operationId, { operationId, state: 'succeeded', backup });
        expect(res.status, JSON.stringify(backup).slice(0, 60)).toBe(400);
      }

      expect(
        (await store.listBackupRecords()).some(
          (record) => record.filename === candidate.filename,
        ),
      ).toBe(false);
      expect((await store.getOperation(operationId))?.state).toBe('queued');
    });

    it('never stores secrets or archive bytes in a backup record', async () => {
      const operationId = await queueOperation('cb-backup-secrets', 'backup_create');

      await callback(operationId, {
        operationId,
        state: 'succeeded',
        output: 'POSTGRES_PASSWORD=super-secret-value\nPGDMP binary bytes',
        backup: { ...BACKUP_DESCRIPTION, message: 'backup published and checksummed' },
      }).expect(200);

      const serialized = JSON.stringify(await store.listBackupRecords());
      expect(serialized).not.toContain('super-secret-value');
      expect(serialized).not.toContain('PGDMP');
    });

    it('rejects a missing or incorrect callback token', async () => {
      const operationId = await queueOperation('cb-bad-token');

      const missing = await callback(operationId, { operationId, state: 'running' }, null);
      expect(missing.status).toBe(403);
      expect(missing.body.error.code).toBe('callback_forbidden');

      const wrong = await callback(operationId, { operationId, state: 'running' }, 'b'.repeat(64));
      expect(wrong.status).toBe(403);

      const shorter = await callback(operationId, { operationId, state: 'running' }, 'b');
      expect(shorter.status).toBe(403);

      expect((await store.getOperation(operationId))?.state).toBe('queued');
      expect(await store.listOperationEvents(operationId)).toHaveLength(1);
    });

    it('rejects a dashboard session cookie when the callback token is absent', async () => {
      const operationId = await queueOperation('cb-cookie-without-token');
      const cookieOnlySession = await openAdminSession(failClosedApp, 'ops-admin');

      const res = await request(callbackApp)
        .post(`/api/v1/admin/operations/${operationId}/callback`)
        .set('Cookie', cookieOnlySession.Cookie)
        .send({ operationId, state: 'running' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('callback_forbidden');
      expect((await store.getOperation(operationId))?.state).toBe('queued');
      expect(await store.listOperationEvents(operationId)).toHaveLength(1);
    });

    it('fails closed when no callback credential is provisioned', async () => {
      const operationId = await queueOperation('cb-unconfigured');
      callbackToken = null;

      const res = await callback(operationId, { operationId, state: 'running' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('callback_unavailable');
      expect((await store.getOperation(operationId))?.state).toBe('queued');
    });

    it('rejects a peer that is not the root operator when peer credentials are available', async () => {
      const operationId = await queueOperation('cb-peer-uid');
      peerUid = 1000;

      const res = await callback(operationId, { operationId, state: 'running' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('callback_forbidden');
      expect((await store.getOperation(operationId))?.state).toBe('queued');
    });

    it('refuses to update any operation other than its own', async () => {
      const own = await queueOperation('cb-own');
      const other = await queueOperation('cb-other');

      const res = await callback(own, { operationId: other, state: 'running' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect((await store.getOperation(own))?.state).toBe('queued');
      expect((await store.getOperation(other))?.state).toBe('queued');
    });

    it('rejects unknown operations and malformed payloads', async () => {
      const unknown = await callback('cb-missing', { operationId: 'cb-missing', state: 'running' });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe('operation_not_found');

      const operationId = await queueOperation('cb-malformed');
      const badState = await callback(operationId, { operationId, state: 'queued' });
      expect(badState.status).toBe(400);

      const badShape = await callback(operationId, { operationId, state: 'running', output: 42 });
      expect(badShape.status).toBe(400);
      expect((await store.getOperation(operationId))?.state).toBe('queued');
    });

    it('sanitises secrets in callback output before persisting it', async () => {
      const operationId = await queueOperation('cb-secrets');

      await callback(operationId, {
        operationId,
        state: 'failed',
        output: 'POSTGRES_PASSWORD=super-secret-value\nfailed to connect',
      }).expect(200);

      const persisted = await store.getOperation(operationId);
      expect(persisted?.output).not.toContain('super-secret-value');
      expect(persisted?.output).toContain('failed to connect');
    });

    it('does not accept a dashboard session token in place of the callback credential', async () => {
      const operationId = await queueOperation('cb-jwt-rejected');

      const res = await request(callbackApp)
        .post(`/api/v1/admin/operations/${operationId}/callback`)
        .set(adminAuth())
        .send({ operationId, state: 'running' });


      expect(res.status).toBe(403);
      expect((await store.getOperation(operationId))?.state).toBe('queued');
    });

    it('accepts a terminal callback carrying a full 256 KiB operator output tail', async () => {
      const operationId = await queueOperation('cb-large-output');
      // The operator's bounded tail is 256 KiB, which is far beyond the 100 KB
      // default of `express.json()`; this body is what a chatty deploy really
      // sends back.
      const output = 'deploy log line\n'.repeat(16 * 1024);
      expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(256 * 1000);

      const res = await callback(operationId, {
        operationId,
        state: 'succeeded',
        message: 'Operation succeeded',
        output,
        metadata: { exitCode: 0, signal: null, truncated: true },
      });

      expect(res.status).toBe(200);
      const persisted = await store.getOperation(operationId);
      expect(persisted?.state).toBe('succeeded');
      expect(Buffer.byteLength(persisted?.output ?? '', 'utf8')).toBeGreaterThan(100 * 1024);
      expect(persisted?.output).toContain('deploy log line');

      const events = await store.listOperationEvents(operationId);
      expect(events.some((event) => event.state === 'running')).toBe(true);
      expect(events.some((event) => event.state === 'succeeded')).toBe(true);
    });

    it('accepts a terminal callback whose escaped output fills the reporter ceiling', async () => {
      const operationId = await queueOperation('cb-escape-saturated');
      // Mirrors MAX_CALLBACK_REQUEST_BODY_BYTES in @ariadne-dev/operator: the
      // reporter fits its serialized request under 1 MiB, so this route has to
      // parse a body of that size even though the raw tail is only ~254 KiB.
      // Quotes escape 2x and control characters 6x, which is the inflation the
      // old 512 KB route limit could not absorb.
      const maxCallbackBodyBytes = 1024 * 1024;
      const output = '"\u0001'.repeat(130 * 1000);
      const payload = {
        operationId,
        state: 'succeeded' as const,
        message: 'Operation succeeded',
        output,
        metadata: { exitCode: 0, signal: null, truncated: true },
      };
      const serializedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(256 * 1024);
      expect(serializedBytes).toBeGreaterThan(900 * 1024);
      expect(serializedBytes).toBeLessThanOrEqual(maxCallbackBodyBytes);

      const res = await callback(operationId, payload);

      expect(res.status).toBe(200);
      const persisted = await store.getOperation(operationId);
      expect(persisted?.state).toBe('succeeded');
      expect((persisted?.output ?? '').length).toBeGreaterThan(0);
    });

    it('rejects a callback beyond the route limit with a stable 413 and no body echo', async () => {
      const operationId = await queueOperation('cb-oversize');
      const marker = 'OVERSIZE-CANARY';
      const output = `${marker}${'z'.repeat(3 * 1024 * 1024)}`;

      const res = await callback(operationId, { operationId, state: 'succeeded', output });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('callback_payload_too_large');
      expect(JSON.stringify(res.body)).not.toContain(marker);
      expect(JSON.stringify(res.body)).not.toContain('zzzz');
      expect((await store.getOperation(operationId))?.state).toBe('queued');
    });

    it('leaves unrelated routes on the 100 KB global parser limit', async () => {
      const small = await request(callbackApp)
        .post('/api/v1/other')
        .send({ value: 'x'.repeat(1024) });
      expect(small.status).toBe(200);

      const large = await request(callbackApp)
        .post('/api/v1/other')
        .send({ value: 'x'.repeat(200 * 1024) });
      expect(large.status).toBe(413);
    });
  });
});
