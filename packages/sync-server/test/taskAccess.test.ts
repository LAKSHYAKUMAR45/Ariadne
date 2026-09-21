import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { ApiError } from '../src/errors.js';
import { runMigrations } from '../src/migrate.js';
import { inaccessibleTaskError, requireTeamTask } from '../src/taskAccess.js';
import { TEST_DATABASE_URL } from './testConfig.js';
import {
  relaxSingletonTeamConstraints,
  restoreSingletonTeamConstraints,
} from './singletonConstraints.js';

describe('taskAccess', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    // Task 3 needs cross-team fixtures even though registration still creates
    // a single default team in production today.
    await relaxSingletonTeamConstraints(pool);
  });

  afterAll(async () => {
    await restoreSingletonTeamConstraints(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE todos, decisions, errors, open_questions, commands, checkpoints, tasks, team_memberships, teams, users CASCADE',
    );
  });

  async function createTeam(name: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO teams (singleton_key, name) VALUES ($1, $2) RETURNING id',
      [null, name],
    );
    return rows[0].id;
  }

  async function createUser(username: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, `hash-${username}`],
    );
    return rows[0].id;
  }

  async function createTask(taskId: string, teamId: string, ownerUserId: string): Promise<void> {
    await pool.query(
      `INSERT INTO tasks (id, local_id, owner_user_id, title, goal, status, branch, created_at, updated_at, team_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
      [
        taskId,
        `local-${taskId}`,
        ownerUserId,
        `Task ${taskId}`,
        null,
        'active',
        null,
        '2026-09-21T00:00:00Z',
        teamId,
      ],
    );
  }

  it('allows access only when the task belongs to the requested team', async () => {
    const teamId = await createTeam('Team Alpha');
    const userId = await createUser('alpha-user');
    const taskId = '00000000-0000-0000-0000-000000000101';

    await createTask(taskId, teamId, userId);

    await expect(requireTeamTask(pool, teamId, taskId)).resolves.toBeUndefined();
  });

  it('returns the same task_not_found error for missing and foreign-team task ids', async () => {
    const teamAId = await createTeam('Team Alpha');
    const teamBId = await createTeam('Team Beta');
    const ownerId = await createUser('owner-user');
    const foreignTaskId = '00000000-0000-0000-0000-000000000201';
    const missingTaskId = '00000000-0000-0000-0000-000000000202';

    await createTask(foreignTaskId, teamAId, ownerId);

    await expect(requireTeamTask(pool, teamBId, foreignTaskId)).rejects.toEqual(
      inaccessibleTaskError(foreignTaskId),
    );
    await expect(requireTeamTask(pool, teamBId, missingTaskId)).rejects.toEqual(
      inaccessibleTaskError(missingTaskId),
    );
  });

  it('builds a stable task_not_found ApiError', () => {
    expect(inaccessibleTaskError('task-123')).toEqual(
      new ApiError(404, 'task_not_found', 'No task with remoteId task-123'),
    );
  });
});
