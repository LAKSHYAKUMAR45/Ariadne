import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';

describe('sync-server: auth + sync routes', () => {
  let pool: Pool;
  let app: Express;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    app = createApp(pool, TEST_JWT_SECRET);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Isolate each test: wipe all sync-relevant tables (CASCADE handles FKs).
    await pool.query('TRUNCATE TABLE checkpoints, tasks, users CASCADE');
  });

  async function registerAndLogin(username = 'alice', password = 'hunter2') {
    await request(app).post('/api/v1/auth/register').send({ username, password }).expect(201);
    const loginRes = await request(app).post('/api/v1/auth/login').send({ username, password }).expect(200);
    return loginRes.body.token as string;
  }

  describe('auth', () => {
    it('registers a new user', async () => {
      const res = await request(app).post('/api/v1/auth/register').send({ username: 'bob', password: 'pw123456' });
      expect(res.status).toBe(201);
      expect(res.body.username).toBe('bob');
      expect(res.body.userId).toBeTruthy();
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

    it('a different user can read and update a task they do not own (flat access model)', async () => {
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

    it('GET /tasks/all lists every task on the server (including from other users) with owner + workspaceLabel', async () => {
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

      // Bob should see Alice's task too (flat access model) with her username and workspace label.
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

    it('requires a taskRemoteId query parameter on pull', async () => {
      const token = await registerAndLogin();
      const res = await request(app).get('/api/v1/sync/checkpoints').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    });
  });
});
