import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';
import { createTestEncryptionKeyring } from './testKeyring.js';
import {
  relaxSingletonTeamConstraints,
  restoreSingletonTeamConstraints,
} from './singletonConstraints.js';

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
    await pool.query(
      'TRUNCATE TABLE todos, decisions, errors, open_questions, commands, checkpoints, tasks, team_memberships, teams, users CASCADE',
    );
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

  async function createDirectUser(
    username: string,
  ): Promise<{ userId: string; authHeader: { Authorization: string } }> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, `hash-${username}`],
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
  });

  describe('admin member routes', () => {
    async function createAdminFixture() {
      const teamId = await createDirectTeam('Singleton Admin Team');
      const admin = await createDirectUser('singleton-admin');
      const member = await createDirectUser('teammate-member');

      await addMembership(teamId, admin.userId, 'admin');
      await addMembership(teamId, member.userId, 'member');

      return { teamId, admin, member };
    }

    it('lists members and lets the singleton admin deactivate then reactivate a member', async () => {
      const { admin, member } = await createAdminFixture();

      const listRes = await request(app)
        .get('/api/v1/admin/members')
        .set(admin.authHeader);
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
        .set(admin.authHeader)
        .send({ active: false });
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
        .set(admin.authHeader)
        .send({ active: true });
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

    it('returns 403 when a non-admin member calls admin member APIs', async () => {
      const { member } = await createAdminFixture();

      const listRes = await request(app)
        .get('/api/v1/admin/members')
        .set(member.authHeader);
      expect(listRes.status).toBe(403);

      const patchRes = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set(member.authHeader)
        .send({ active: false });
      expect(patchRes.status).toBe(403);
    });

    it('returns 403 for a non-admin member even when the patch body is malformed', async () => {
      const { member } = await createAdminFixture();

      const res = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set(member.authHeader)
        .send({ active: 'nope', role: 'admin' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('admin_required');
    });

    it('returns 404 when the singleton admin targets an unknown user', async () => {
      const { admin } = await createAdminFixture();

      const res = await request(app)
        .patch('/api/v1/admin/members/00000000-0000-0000-0000-000000000099')
        .set(admin.authHeader)
        .send({ active: false });

      expect(res.status).toBe(404);
    });

    it('returns 409 admin_immutable when attempting to mutate the singleton admin', async () => {
      const { admin } = await createAdminFixture();

      const res = await request(app)
        .patch(`/api/v1/admin/members/${admin.userId}`)
        .set(admin.authHeader)
        .send({ active: false });

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
        .set(admin.authHeader)
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
      const admin = await createDirectUser('revocation-admin');
      const member = await createDirectUser('revocation-member');
      await addMembership(teamId, admin.userId, 'admin');
      await addMembership(teamId, member.userId, 'member');

      // The member token is minted while the membership is still active, then
      // the admin deactivates them: the already-issued JWT must stop working.
      const deactivate = await request(app)
        .patch(`/api/v1/admin/members/${member.userId}`)
        .set(admin.authHeader)
        .send({ active: false });
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
});
