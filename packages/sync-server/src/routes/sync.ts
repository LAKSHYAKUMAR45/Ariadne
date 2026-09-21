import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ApiError, errorBody } from '../errors.js';
import type { AuthenticatedRequest } from '../middleware.js';
import { inaccessibleTaskError, requireTeamTask } from '../taskAccess.js';
import { requireActiveMembership, type ActiveMembership } from '../teamAccess.js';

const pushTaskSchema = z.object({
  localId: z.string().min(1),
  remoteId: z.string().uuid().nullable(),
  title: z.string().min(1),
  goal: z.string().nullable().optional(),
  status: z.enum(['active', 'paused', 'done', 'archived']),
  branch: z.string().nullable().optional(),
  workspaceLabel: z.string().max(256).nullable().optional(),
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
  workspace_label: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Push + pull endpoints for tasks and checkpoints, per
 * docs/07-CLOUD-SYNC-API-CONTRACT.md §4.2/§4.3. Additive-only (no delete
 * endpoint). Access is scoped by the caller's active team membership:
 * every protected task read/write filters on `tasks.team_id`, while
 * sub-entity routes first verify that the referenced parent task is
 * visible to the caller.
 */
export function createSyncRouter(pool: Pool): Router {
  const router = Router();

  async function requireMembership(
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<ActiveMembership | null> {
    try {
      return await requireActiveMembership(pool, req.userId!);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        res.status(error.status).json(errorBody(error));
        return null;
      }
      throw error;
    }
  }

  async function requireAccessibleTask(
    teamId: string,
    taskId: string,
    res: Response,
  ): Promise<boolean> {
    try {
      await requireTeamTask(pool, teamId, taskId);
      return true;
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        res.status(error.status).json(errorBody(error));
        return false;
      }
      throw error;
    }
  }

  async function ensureDecisionSupersedesSameTask(
    supersedesId: string | null | undefined,
    taskRemoteId: string,
  ): Promise<ApiError | null> {
    if (!supersedesId) {
      return null;
    }

    const { rows } = await pool.query(
      'SELECT 1 FROM decisions WHERE id = $1 AND task_id = $2',
      [supersedesId, taskRemoteId],
    );
    return rows.length > 0
      ? null
      : new ApiError(
          400,
          'invalid_supersedes_id',
          'supersedesId must refer to a decision on the same task',
        );
  }

  router.post('/tasks', async (req: AuthenticatedRequest, res) => {
    const parsed = pushTasksSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const membership = await requireMembership(req, res);
    if (!membership) {
      return;
    }

    const results: { localId: string; remoteId: string; updatedAt: string }[] = [];
    for (const task of parsed.data.tasks) {
      let row: TaskRow;
      if (task.remoteId) {
        // Remote-wins upsert for Phase 1 (see docs/07-CLOUD-SYNC-API-CONTRACT.md §4.2).
        // workspace_label is overwritten too, so it always reflects the most
        // recent workspace/machine to push this task (not just its origin).
        const { rows } = await pool.query<TaskRow>(
          `UPDATE tasks SET title = $1, goal = $2, status = $3, branch = $4, workspace_label = $5, updated_at = now()
           WHERE id = $6 AND team_id = $7
           RETURNING id, local_id, title, goal, status, branch, workspace_label, created_at, updated_at`,
          [
            task.title,
            task.goal ?? null,
            task.status,
            task.branch ?? null,
            task.workspaceLabel ?? null,
            task.remoteId,
            membership.teamId,
          ],
        );
        if (rows.length === 0) {
          const inaccessible = inaccessibleTaskError(task.remoteId);
          res.status(inaccessible.status).json(errorBody(inaccessible));
          return;
        }
        row = rows[0];
      } else {
        const { rows } = await pool.query<TaskRow>(
          `INSERT INTO tasks (local_id, owner_user_id, title, goal, status, branch, workspace_label, created_at, updated_at, team_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
           RETURNING id, local_id, title, goal, status, branch, workspace_label, created_at, updated_at`,
          [
            task.localId,
            req.userId,
            task.title,
            task.goal ?? null,
            task.status,
            task.branch ?? null,
            task.workspaceLabel ?? null,
            task.createdAt,
            membership.teamId,
          ],
        );
        row = rows[0];
      }
      results.push({ localId: task.localId, remoteId: row.id, updatedAt: row.updated_at.toISOString() });
    }
    res.status(200).json({ results });
  });

  /** Parses/clamps `limit`/`offset` query params shared by the paginated list endpoints below (§4.5). */
  function parsePagination(query: Record<string, unknown>): { limit: number; offset: number } {
    const rawLimit = typeof query.limit === 'string' ? parseInt(query.limit, 10) : NaN;
    const rawOffset = typeof query.offset === 'string' ? parseInt(query.offset, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    return { limit, offset };
  }

  router.get('/tasks', async (req, res) => {
    const membership = await requireMembership(req as AuthenticatedRequest, res);
    if (!membership) {
      return;
    }

    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const serverTime = new Date();
    // Fetch one extra row to cheaply detect whether another page follows,
    // without a separate COUNT(*) query.
    const { rows } = since
      ? await pool.query<TaskRow>(
          `SELECT id, local_id, title, goal, status, branch, workspace_label, created_at, updated_at FROM tasks
           WHERE team_id = $1 AND updated_at > $2 ORDER BY updated_at ASC LIMIT $3 OFFSET $4`,
          [membership.teamId, since, limit + 1, offset]
        )
      : await pool.query<TaskRow>(
          `SELECT id, local_id, title, goal, status, branch, workspace_label, created_at, updated_at FROM tasks
           WHERE team_id = $1
           ORDER BY updated_at ASC LIMIT $2 OFFSET $3`,
          [membership.teamId, limit + 1, offset]
        );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.status(200).json({
      tasks: page.map((r) => ({
        remoteId: r.id,
        title: r.title,
        goal: r.goal,
        status: r.status,
        branch: r.branch,
        workspaceLabel: r.workspace_label,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    });
  });

  interface TaskWithOwnerRow extends TaskRow {
    username: string;
  }

  /**
   * Browse-only listing of every task on the server, including ones this
   * workspace has never linked (unlike GET /tasks, which is meant to feed
   * `sync pull`'s "update rows I already know about" flow). Joins in the
   * owning username so `ariadne sync list-remote` can show "who" alongside
   * "which workspace" without a client-side lookup. Paginated via
   * `limit`/`offset` (§4.5) — the CLI transparently pages through all of
   * it, but the server itself never returns an unbounded result set.
   */
  router.get('/tasks/all', async (req, res) => {
    const membership = await requireMembership(req as AuthenticatedRequest, res);
    if (!membership) {
      return;
    }

    const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const { rows } = await pool.query<TaskWithOwnerRow>(
      `SELECT t.id, t.local_id, t.title, t.goal, t.status, t.branch, t.workspace_label, t.created_at, t.updated_at, u.username
       FROM tasks t JOIN users u ON u.id = t.owner_user_id
       WHERE t.team_id = $1
       ORDER BY t.updated_at DESC LIMIT $2 OFFSET $3`,
      [membership.teamId, limit + 1, offset]
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.status(200).json({
      tasks: page.map((r) => ({
        remoteId: r.id,
        title: r.title,
        goal: r.goal,
        status: r.status,
        branch: r.branch,
        workspaceLabel: r.workspace_label,
        owner: r.username,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    });
  });

  const pushCheckpointSchema = z.object({
    localId: z.string().min(1),
    remoteTaskId: z.string().uuid(),
    level: z.enum(['micro', 'session', 'milestone']),
    summary: z.string().min(1),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
  });
  const pushCheckpointsSchema = z.object({ checkpoints: z.array(pushCheckpointSchema) });

  interface CheckpointRow {
    id: string;
    level: string;
    summary: string;
    workspace_label: string | null;
    created_at: Date;
  }

  router.post('/checkpoints', async (req: AuthenticatedRequest, res) => {
    const parsed = pushCheckpointsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const membership = await requireMembership(req, res);
    if (!membership) {
      return;
    }

    const results: { localId: string; remoteId: string }[] = [];
    for (const checkpoint of parsed.data.checkpoints) {
      const accessible = await requireAccessibleTask(membership.teamId, checkpoint.remoteTaskId, res);
      if (!accessible) {
        return;
      }
      // Attribution is who/where actually pushed this checkpoint, which can
      // differ from the parent task's owner/workspace (e.g. a teammate who
      // pulled the task and is now adding their own checkpoints to it).
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO checkpoints (local_id, task_id, level, summary, owner_user_id, workspace_label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [checkpoint.localId, checkpoint.remoteTaskId, checkpoint.level, checkpoint.summary, req.userId, checkpoint.workspaceLabel ?? null, checkpoint.createdAt]
      );
      results.push({ localId: checkpoint.localId, remoteId: rows[0].id });
    }
    res.status(200).json({ results });
  });

  router.get('/checkpoints', async (req, res) => {
    const membership = await requireMembership(req as AuthenticatedRequest, res);
    if (!membership) {
      return;
    }

    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const accessible = await requireAccessibleTask(membership.teamId, taskRemoteId, res);
    if (!accessible) {
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<CheckpointRow>(
          `SELECT id, level, summary, workspace_label, created_at FROM checkpoints
           WHERE task_id = $1 AND created_at > $2 ORDER BY created_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<CheckpointRow>(
          `SELECT id, level, summary, workspace_label, created_at FROM checkpoints WHERE task_id = $1 ORDER BY created_at ASC`,
          [taskRemoteId]
        );

    res.status(200).json({
      checkpoints: rows.map((r) => ({
        remoteId: r.id,
        level: r.level,
        summary: r.summary,
        workspaceLabel: r.workspace_label,
        createdAt: r.created_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  // -------------------------------------------------------------------
  // Todos — the one sub-entity type with full bidirectional sync (an
  // update-by-remote-id path, not just insert), since local todos track
  // `updated_at` and can be legitimately edited/marked done after their
  // first push. Mirrors the tasks push/pull routes above. See
  // docs/07-CLOUD-SYNC-API-CONTRACT.md §4.6.
  // -------------------------------------------------------------------

  const pushTodoSchema = z.object({
    localId: z.string().min(1),
    remoteId: z.string().uuid().nullable(),
    remoteTaskId: z.string().uuid(),
    text: z.string().min(1),
    status: z.enum(['pending', 'done', 'blocked']),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });
  const pushTodosSchema = z.object({ todos: z.array(pushTodoSchema) });

  interface TodoRow {
    id: string;
    text: string;
    status: string;
    workspace_label: string | null;
    created_at: Date;
    updated_at: Date;
  }

  router.post('/todos', async (req: AuthenticatedRequest, res) => {
    const parsed = pushTodosSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const membership = await requireMembership(req, res);
    if (!membership) {
      return;
    }

    const results: { localId: string; remoteId: string; updatedAt: string }[] = [];
    for (const todo of parsed.data.todos) {
      const accessible = await requireAccessibleTask(membership.teamId, todo.remoteTaskId, res);
      if (!accessible) {
        return;
      }

      let row: TodoRow;
      if (todo.remoteId) {
        const { rows } = await pool.query<TodoRow>(
          `UPDATE todos SET text = $1, status = $2, workspace_label = $3, updated_at = $4
           WHERE id = $5 RETURNING id, text, status, workspace_label, created_at, updated_at`,
          [todo.text, todo.status, todo.workspaceLabel ?? null, todo.updatedAt, todo.remoteId]
        );
        if (rows.length === 0) {
          const err = new ApiError(404, 'todo_not_found', `No todo with remoteId ${todo.remoteId}`);
          res.status(err.status).json(errorBody(err));
          return;
        }
        row = rows[0];
      } else {
        const { rows } = await pool.query<TodoRow>(
          `INSERT INTO todos (local_id, task_id, text, status, owner_user_id, workspace_label, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           RETURNING id, text, status, workspace_label, created_at, updated_at`,
          [todo.localId, todo.remoteTaskId, todo.text, todo.status, req.userId, todo.workspaceLabel ?? null, todo.createdAt]
        );
        row = rows[0];
      }
      results.push({ localId: todo.localId, remoteId: row.id, updatedAt: row.updated_at.toISOString() });
    }
    res.status(200).json({ results });
  });

  router.get('/todos', async (req, res) => {
    const membership = await requireMembership(req as AuthenticatedRequest, res);
    if (!membership) {
      return;
    }

    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const accessible = await requireAccessibleTask(membership.teamId, taskRemoteId, res);
    if (!accessible) {
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<TodoRow>(
          `SELECT id, text, status, workspace_label, created_at, updated_at FROM todos
           WHERE task_id = $1 AND updated_at > $2 ORDER BY updated_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<TodoRow>(
          `SELECT id, text, status, workspace_label, created_at, updated_at FROM todos WHERE task_id = $1 ORDER BY updated_at ASC`,
          [taskRemoteId]
        );

    res.status(200).json({
      todos: rows.map((r) => ({
        remoteId: r.id,
        text: r.text,
        status: r.status,
        workspaceLabel: r.workspace_label,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  // -------------------------------------------------------------------
  // Decisions, errors, open questions, commands — full bidirectional sync,
  // mirroring the todos pattern above: push upserts by remoteId and pull
  // uses updated_at cursors. See docs/07-CLOUD-SYNC-API-CONTRACT.md §4.6.
  // -------------------------------------------------------------------

  const pushDecisionSchema = z.object({
    localId: z.string().min(1),
    remoteId: z.string().uuid().nullable(),
    remoteTaskId: z.string().uuid(),
    text: z.string().min(1),
    rationale: z.string().nullable().optional(),
    supersedesId: z.string().uuid().nullable().optional(),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });
  const pushDecisionsSchema = z.object({ decisions: z.array(pushDecisionSchema) });

  interface DecisionRow {
    id: string;
    text: string;
    rationale: string | null;
    supersedes_id: string | null;
    workspace_label: string | null;
    created_at: Date;
    updated_at: Date;
  }

  router.post('/decisions', async (req: AuthenticatedRequest, res) => {
    const parsed = pushDecisionsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const membership = await requireMembership(req, res);
    if (!membership) {
      return;
    }

    const results: { localId: string; remoteId: string; updatedAt: string }[] = [];
    for (const decision of parsed.data.decisions) {
      const accessible = await requireAccessibleTask(membership.teamId, decision.remoteTaskId, res);
      if (!accessible) {
        return;
      }

      const supersedesError = await ensureDecisionSupersedesSameTask(decision.supersedesId, decision.remoteTaskId);
      if (supersedesError) {
        res.status(supersedesError.status).json(errorBody(supersedesError));
        return;
      }
      let row: DecisionRow;
      if (decision.remoteId) {
        const { rows } = await pool.query<DecisionRow>(
          `UPDATE decisions
           SET text = $1, rationale = $2, supersedes_id = $3, workspace_label = $4, updated_at = now()
           WHERE id = $5 AND task_id = $6
           RETURNING id, text, rationale, supersedes_id, workspace_label, created_at, updated_at`,
          [
            decision.text,
            decision.rationale ?? null,
            decision.supersedesId ?? null,
            decision.workspaceLabel ?? null,
            decision.remoteId,
            decision.remoteTaskId,
          ],
        );
        if (rows.length === 0) {
          const err = new ApiError(404, 'decision_not_found', `No decision with remoteId ${decision.remoteId}`);
          res.status(err.status).json(errorBody(err));
          return;
        }
        row = rows[0];
      } else {
        const { rows } = await pool.query<DecisionRow>(
          `INSERT INTO decisions (local_id, task_id, text, rationale, supersedes_id, owner_user_id, workspace_label, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           RETURNING id, text, rationale, supersedes_id, workspace_label, created_at, updated_at`,
          [
            decision.localId,
            decision.remoteTaskId,
            decision.text,
            decision.rationale ?? null,
            decision.supersedesId ?? null,
            req.userId,
            decision.workspaceLabel ?? null,
            decision.createdAt,
          ],
        );
        row = rows[0];
      }
      results.push({ localId: decision.localId, remoteId: row.id, updatedAt: row.updated_at.toISOString() });
    }
    res.status(200).json({ results });
  });

  router.get('/decisions', async (req, res) => {
    const membership = await requireMembership(req as AuthenticatedRequest, res);
    if (!membership) {
      return;
    }

    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const accessible = await requireAccessibleTask(membership.teamId, taskRemoteId, res);
    if (!accessible) {
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<DecisionRow>(
          `SELECT id, text, rationale, supersedes_id, workspace_label, created_at, updated_at FROM decisions
           WHERE task_id = $1 AND updated_at > $2 ORDER BY updated_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<DecisionRow>(
          `SELECT id, text, rationale, supersedes_id, workspace_label, created_at, updated_at FROM decisions
           WHERE task_id = $1 ORDER BY updated_at ASC`,
          [taskRemoteId]
        );
    res.status(200).json({
      decisions: rows.map((r) => ({
        remoteId: r.id,
        text: r.text,
        rationale: r.rationale,
        supersedesId: r.supersedes_id,
        workspaceLabel: r.workspace_label,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  const pushErrorSchema = z.object({
    localId: z.string().min(1),
    remoteId: z.string().uuid().nullable(),
    remoteTaskId: z.string().uuid(),
    message: z.string().min(1),
    resolved: z.boolean(),
    resolution: z.string().nullable().optional(),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });
  const pushErrorsSchema = z.object({ errors: z.array(pushErrorSchema) });

  interface ErrorEntityRow {
    id: string;
    message: string;
    resolved: boolean;
    resolution: string | null;
    workspace_label: string | null;
    created_at: Date;
    updated_at: Date;
  }

  router.post('/errors', async (req: AuthenticatedRequest, res) => {
    const parsed = pushErrorsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const membership = await requireMembership(req, res);
    if (!membership) {
      return;
    }

    const results: { localId: string; remoteId: string; updatedAt: string }[] = [];
    for (const taskError of parsed.data.errors) {
      const accessible = await requireAccessibleTask(membership.teamId, taskError.remoteTaskId, res);
      if (!accessible) {
        return;
      }

      let row: ErrorEntityRow;
      if (taskError.remoteId) {
        const { rows } = await pool.query<ErrorEntityRow>(
          `UPDATE errors
           SET message = $1, resolved = $2, resolution = $3, workspace_label = $4, updated_at = now()
           WHERE id = $5 AND task_id = $6
           RETURNING id, message, resolved, resolution, workspace_label, created_at, updated_at`,
          [
            taskError.message,
            taskError.resolved,
            taskError.resolution ?? null,
            taskError.workspaceLabel ?? null,
            taskError.remoteId,
            taskError.remoteTaskId,
          ],
        );
        if (rows.length === 0) {
          const err = new ApiError(404, 'error_not_found', `No error with remoteId ${taskError.remoteId}`);
          res.status(err.status).json(errorBody(err));
          return;
        }
        row = rows[0];
      } else {
        const { rows } = await pool.query<ErrorEntityRow>(
          `INSERT INTO errors (local_id, task_id, message, resolved, resolution, owner_user_id, workspace_label, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           RETURNING id, message, resolved, resolution, workspace_label, created_at, updated_at`,
          [
            taskError.localId,
            taskError.remoteTaskId,
            taskError.message,
            taskError.resolved,
            taskError.resolution ?? null,
            req.userId,
            taskError.workspaceLabel ?? null,
            taskError.createdAt,
          ],
        );
        row = rows[0];
      }
      results.push({ localId: taskError.localId, remoteId: row.id, updatedAt: row.updated_at.toISOString() });
    }
    res.status(200).json({ results });
  });

  router.get('/errors', async (req, res) => {
    const membership = await requireMembership(req as AuthenticatedRequest, res);
    if (!membership) {
      return;
    }

    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const accessible = await requireAccessibleTask(membership.teamId, taskRemoteId, res);
    if (!accessible) {
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<ErrorEntityRow>(
          `SELECT id, message, resolved, resolution, workspace_label, created_at, updated_at FROM errors
           WHERE task_id = $1 AND updated_at > $2 ORDER BY updated_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<ErrorEntityRow>(
          `SELECT id, message, resolved, resolution, workspace_label, created_at, updated_at FROM errors
           WHERE task_id = $1 ORDER BY updated_at ASC`,
          [taskRemoteId]
        );
    res.status(200).json({
      errors: rows.map((r) => ({
        remoteId: r.id,
        message: r.message,
        resolved: r.resolved,
        resolution: r.resolution,
        workspaceLabel: r.workspace_label,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  const pushOpenQuestionSchema = z.object({
    localId: z.string().min(1),
    remoteId: z.string().uuid().nullable(),
    remoteTaskId: z.string().uuid(),
    text: z.string().min(1),
    resolved: z.boolean(),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });
  const pushOpenQuestionsSchema = z.object({ openQuestions: z.array(pushOpenQuestionSchema) });

  interface OpenQuestionRow {
    id: string;
    text: string;
    resolved: boolean;
    workspace_label: string | null;
    created_at: Date;
    updated_at: Date;
  }

  router.post('/open-questions', async (req: AuthenticatedRequest, res) => {
    const parsed = pushOpenQuestionsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const membership = await requireMembership(req, res);
    if (!membership) {
      return;
    }

    const results: { localId: string; remoteId: string; updatedAt: string }[] = [];
    for (const question of parsed.data.openQuestions) {
      const accessible = await requireAccessibleTask(membership.teamId, question.remoteTaskId, res);
      if (!accessible) {
        return;
      }

      let row: OpenQuestionRow;
      if (question.remoteId) {
        const { rows } = await pool.query<OpenQuestionRow>(
          `UPDATE open_questions
           SET text = $1, resolved = $2, workspace_label = $3, updated_at = now()
           WHERE id = $4 AND task_id = $5
           RETURNING id, text, resolved, workspace_label, created_at, updated_at`,
          [question.text, question.resolved, question.workspaceLabel ?? null, question.remoteId, question.remoteTaskId],
        );
        if (rows.length === 0) {
          const err = new ApiError(404, 'open_question_not_found', `No open question with remoteId ${question.remoteId}`);
          res.status(err.status).json(errorBody(err));
          return;
        }
        row = rows[0];
      } else {
        const { rows } = await pool.query<OpenQuestionRow>(
          `INSERT INTO open_questions (local_id, task_id, text, resolved, owner_user_id, workspace_label, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           RETURNING id, text, resolved, workspace_label, created_at, updated_at`,
          [question.localId, question.remoteTaskId, question.text, question.resolved, req.userId, question.workspaceLabel ?? null, question.createdAt],
        );
        row = rows[0];
      }
      results.push({ localId: question.localId, remoteId: row.id, updatedAt: row.updated_at.toISOString() });
    }
    res.status(200).json({ results });
  });

  router.get('/open-questions', async (req, res) => {
    const membership = await requireMembership(req as AuthenticatedRequest, res);
    if (!membership) {
      return;
    }

    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const accessible = await requireAccessibleTask(membership.teamId, taskRemoteId, res);
    if (!accessible) {
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<OpenQuestionRow>(
          `SELECT id, text, resolved, workspace_label, created_at, updated_at FROM open_questions
           WHERE task_id = $1 AND updated_at > $2 ORDER BY updated_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<OpenQuestionRow>(
          `SELECT id, text, resolved, workspace_label, created_at, updated_at FROM open_questions
           WHERE task_id = $1 ORDER BY updated_at ASC`,
          [taskRemoteId]
        );
    res.status(200).json({
      openQuestions: rows.map((r) => ({
        remoteId: r.id,
        text: r.text,
        resolved: r.resolved,
        workspaceLabel: r.workspace_label,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  const pushCommandSchema = z.object({
    localId: z.string().min(1),
    remoteId: z.string().uuid().nullable(),
    remoteTaskId: z.string().uuid(),
    cmdRedacted: z.string().min(1),
    exitCode: z.number().int().nullable().optional(),
    summary: z.string().nullable().optional(),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });
  const pushCommandsSchema = z.object({ commands: z.array(pushCommandSchema) });

  interface CommandRow {
    id: string;
    cmd_redacted: string;
    exit_code: number | null;
    summary: string | null;
    workspace_label: string | null;
    created_at: Date;
    updated_at: Date;
  }

  router.post('/commands', async (req: AuthenticatedRequest, res) => {
    const parsed = pushCommandsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const membership = await requireMembership(req, res);
    if (!membership) {
      return;
    }

    const results: { localId: string; remoteId: string; updatedAt: string }[] = [];
    for (const command of parsed.data.commands) {
      const accessible = await requireAccessibleTask(membership.teamId, command.remoteTaskId, res);
      if (!accessible) {
        return;
      }

      let row: CommandRow;
      if (command.remoteId) {
        const { rows } = await pool.query<CommandRow>(
          `UPDATE commands
           SET cmd_redacted = $1, exit_code = $2, summary = $3, workspace_label = $4, updated_at = now()
           WHERE id = $5 AND task_id = $6
           RETURNING id, cmd_redacted, exit_code, summary, workspace_label, created_at, updated_at`,
          [
            command.cmdRedacted,
            command.exitCode ?? null,
            command.summary ?? null,
            command.workspaceLabel ?? null,
            command.remoteId,
            command.remoteTaskId,
          ],
        );
        if (rows.length === 0) {
          const err = new ApiError(404, 'command_not_found', `No command with remoteId ${command.remoteId}`);
          res.status(err.status).json(errorBody(err));
          return;
        }
        row = rows[0];
      } else {
        const { rows } = await pool.query<CommandRow>(
          `INSERT INTO commands (local_id, task_id, cmd_redacted, exit_code, summary, owner_user_id, workspace_label, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           RETURNING id, cmd_redacted, exit_code, summary, workspace_label, created_at, updated_at`,
          [command.localId, command.remoteTaskId, command.cmdRedacted, command.exitCode ?? null, command.summary ?? null, req.userId, command.workspaceLabel ?? null, command.createdAt],
        );
        row = rows[0];
      }
      results.push({ localId: command.localId, remoteId: row.id, updatedAt: row.updated_at.toISOString() });
    }
    res.status(200).json({ results });
  });

  router.get('/commands', async (req, res) => {
    const membership = await requireMembership(req as AuthenticatedRequest, res);
    if (!membership) {
      return;
    }

    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const accessible = await requireAccessibleTask(membership.teamId, taskRemoteId, res);
    if (!accessible) {
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<CommandRow>(
          `SELECT id, cmd_redacted, exit_code, summary, workspace_label, created_at, updated_at FROM commands
           WHERE task_id = $1 AND updated_at > $2 ORDER BY updated_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<CommandRow>(
          `SELECT id, cmd_redacted, exit_code, summary, workspace_label, created_at, updated_at FROM commands
           WHERE task_id = $1 ORDER BY updated_at ASC`,
          [taskRemoteId]
        );
    res.status(200).json({
      commands: rows.map((r) => ({
        remoteId: r.id,
        cmdRedacted: r.cmd_redacted,
        exitCode: r.exit_code,
        summary: r.summary,
        workspaceLabel: r.workspace_label,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  return router;
}
