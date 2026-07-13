import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ApiError, errorBody } from '../errors.js';
import type { AuthenticatedRequest } from '../middleware.js';

const pushTaskSchema = z.object({
  localId: z.string().min(1),
  remoteId: z.string().uuid().nullable(),
  title: z.string().min(1),
  goal: z.string().nullable().optional(),
  status: z.enum(['active', 'paused', 'done', 'archived']),
  branch: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const pushTasksSchema = z.object({ tasks: z.array(pushTaskSchema) });

interface TaskRow {
  id: string;
  local_id: string;
  title: string;
  goal: string | null;
  status: string;
  branch: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Push + pull endpoints for tasks and checkpoints, per
 * docs/07-CLOUD-SYNC-API-CONTRACT.md §4.2/§4.3. Additive-only (no delete
 * endpoint), flat access (any authenticated user may read/write any row —
 * `owner_user_id` is bookkeeping, not an access gate), per
 * docs/06-CLOUD-SYNC-DESIGN.md v0.2 §6.
 */
export function createSyncRouter(pool: Pool): Router {
  const router = Router();

  router.post('/tasks', async (req: AuthenticatedRequest, res) => {
    const parsed = pushTasksSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const results: { localId: string; remoteId: string; updatedAt: string }[] = [];
    for (const task of parsed.data.tasks) {
      let row: TaskRow;
      if (task.remoteId) {
        // Remote-wins upsert for Phase 1 (see docs/07-CLOUD-SYNC-API-CONTRACT.md §4.2).
        const { rows } = await pool.query<TaskRow>(
          `UPDATE tasks SET title = $1, goal = $2, status = $3, branch = $4, updated_at = now()
           WHERE id = $5 RETURNING id, local_id, title, goal, status, branch, created_at, updated_at`,
          [task.title, task.goal ?? null, task.status, task.branch ?? null, task.remoteId]
        );
        if (rows.length === 0) {
          const err = new ApiError(404, 'task_not_found', `No task with remoteId ${task.remoteId}`);
          res.status(err.status).json(errorBody(err));
          return;
        }
        row = rows[0];
      } else {
        const { rows } = await pool.query<TaskRow>(
          `INSERT INTO tasks (local_id, owner_user_id, title, goal, status, branch, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           RETURNING id, local_id, title, goal, status, branch, created_at, updated_at`,
          [task.localId, req.userId, task.title, task.goal ?? null, task.status, task.branch ?? null, task.createdAt]
        );
        row = rows[0];
      }
      results.push({ localId: task.localId, remoteId: row.id, updatedAt: row.updated_at.toISOString() });
    }
    res.status(200).json({ results });
  });

  router.get('/tasks', async (req, res) => {
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<TaskRow>(
          `SELECT id, local_id, title, goal, status, branch, created_at, updated_at FROM tasks
           WHERE updated_at > $1 ORDER BY updated_at ASC`,
          [since]
        )
      : await pool.query<TaskRow>(
          `SELECT id, local_id, title, goal, status, branch, created_at, updated_at FROM tasks ORDER BY updated_at ASC`
        );

    res.status(200).json({
      tasks: rows.map((r) => ({
        remoteId: r.id,
        title: r.title,
        goal: r.goal,
        status: r.status,
        branch: r.branch,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  const pushCheckpointSchema = z.object({
    localId: z.string().min(1),
    remoteTaskId: z.string().uuid(),
    level: z.enum(['micro', 'session', 'milestone']),
    summary: z.string().min(1),
    createdAt: z.string(),
  });
  const pushCheckpointsSchema = z.object({ checkpoints: z.array(pushCheckpointSchema) });

  interface CheckpointRow {
    id: string;
    level: string;
    summary: string;
    created_at: Date;
  }

  router.post('/checkpoints', async (req, res) => {
    const parsed = pushCheckpointsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const results: { localId: string; remoteId: string }[] = [];
    for (const checkpoint of parsed.data.checkpoints) {
      const taskExists = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [checkpoint.remoteTaskId]);
      if (taskExists.rows.length === 0) {
        const err = new ApiError(404, 'task_not_found', `No task with remoteId ${checkpoint.remoteTaskId}`);
        res.status(err.status).json(errorBody(err));
        return;
      }
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO checkpoints (local_id, task_id, level, summary, created_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [checkpoint.localId, checkpoint.remoteTaskId, checkpoint.level, checkpoint.summary, checkpoint.createdAt]
      );
      results.push({ localId: checkpoint.localId, remoteId: rows[0].id });
    }
    res.status(200).json({ results });
  });

  router.get('/checkpoints', async (req, res) => {
    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<CheckpointRow>(
          `SELECT id, level, summary, created_at FROM checkpoints
           WHERE task_id = $1 AND created_at > $2 ORDER BY created_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<CheckpointRow>(
          `SELECT id, level, summary, created_at FROM checkpoints WHERE task_id = $1 ORDER BY created_at ASC`,
          [taskRemoteId]
        );

    res.status(200).json({
      checkpoints: rows.map((r) => ({
        remoteId: r.id,
        level: r.level,
        summary: r.summary,
        createdAt: r.created_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  return router;
}
