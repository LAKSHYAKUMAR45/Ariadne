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
        // workspace_label is overwritten too, so it always reflects the most
        // recent workspace/machine to push this task (not just its origin).
        const { rows } = await pool.query<TaskRow>(
          `UPDATE tasks SET title = $1, goal = $2, status = $3, branch = $4, workspace_label = $5, updated_at = now()
           WHERE id = $6 RETURNING id, local_id, title, goal, status, branch, workspace_label, created_at, updated_at`,
          [task.title, task.goal ?? null, task.status, task.branch ?? null, task.workspaceLabel ?? null, task.remoteId]
        );
        if (rows.length === 0) {
          const err = new ApiError(404, 'task_not_found', `No task with remoteId ${task.remoteId}`);
          res.status(err.status).json(errorBody(err));
          return;
        }
        row = rows[0];
      } else {
        const { rows } = await pool.query<TaskRow>(
          `INSERT INTO tasks (local_id, owner_user_id, title, goal, status, branch, workspace_label, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
           RETURNING id, local_id, title, goal, status, branch, workspace_label, created_at, updated_at`,
          [task.localId, req.userId, task.title, task.goal ?? null, task.status, task.branch ?? null, task.workspaceLabel ?? null, task.createdAt]
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
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const serverTime = new Date();
    // Fetch one extra row to cheaply detect whether another page follows,
    // without a separate COUNT(*) query.
    const { rows } = since
      ? await pool.query<TaskRow>(
          `SELECT id, local_id, title, goal, status, branch, workspace_label, created_at, updated_at FROM tasks
           WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT $2 OFFSET $3`,
          [since, limit + 1, offset]
        )
      : await pool.query<TaskRow>(
          `SELECT id, local_id, title, goal, status, branch, workspace_label, created_at, updated_at FROM tasks
           ORDER BY updated_at ASC LIMIT $1 OFFSET $2`,
          [limit + 1, offset]
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
    const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const { rows } = await pool.query<TaskWithOwnerRow>(
      `SELECT t.id, t.local_id, t.title, t.goal, t.status, t.branch, t.workspace_label, t.created_at, t.updated_at, u.username
       FROM tasks t JOIN users u ON u.id = t.owner_user_id
       ORDER BY t.updated_at DESC LIMIT $1 OFFSET $2`,
      [limit + 1, offset]
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

    const results: { localId: string; remoteId: string }[] = [];
    for (const checkpoint of parsed.data.checkpoints) {
      const taskExists = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [checkpoint.remoteTaskId]);
      if (taskExists.rows.length === 0) {
        const err = new ApiError(404, 'task_not_found', `No task with remoteId ${checkpoint.remoteTaskId}`);
        res.status(err.status).json(errorBody(err));
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

    const results: { localId: string; remoteId: string; updatedAt: string }[] = [];
    for (const todo of parsed.data.todos) {
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
        const taskExists = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [todo.remoteTaskId]);
        if (taskExists.rows.length === 0) {
          const err = new ApiError(404, 'task_not_found', `No task with remoteId ${todo.remoteTaskId}`);
          res.status(err.status).json(errorBody(err));
          return;
        }
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
    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
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
  // Decisions, errors, open questions, commands — create-once sync,
  // mirroring the checkpoints pattern above: push is insert-only (no
  // remoteId in the push payload), pull is a since-cursor scan by
  // created_at. A local edit/resolve made *after* the first push is not
  // automatically re-detected/re-pushed in this phase (documented
  // limitation — see docs/07-CLOUD-SYNC-API-CONTRACT.md §4.6).
  // -------------------------------------------------------------------

  const pushDecisionSchema = z.object({
    localId: z.string().min(1),
    remoteTaskId: z.string().uuid(),
    text: z.string().min(1),
    rationale: z.string().nullable().optional(),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
  });
  const pushDecisionsSchema = z.object({ decisions: z.array(pushDecisionSchema) });

  interface DecisionRow {
    id: string;
    text: string;
    rationale: string | null;
    workspace_label: string | null;
    created_at: Date;
  }

  router.post('/decisions', async (req: AuthenticatedRequest, res) => {
    const parsed = pushDecisionsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }
    const results: { localId: string; remoteId: string }[] = [];
    for (const decision of parsed.data.decisions) {
      const taskExists = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [decision.remoteTaskId]);
      if (taskExists.rows.length === 0) {
        const err = new ApiError(404, 'task_not_found', `No task with remoteId ${decision.remoteTaskId}`);
        res.status(err.status).json(errorBody(err));
        return;
      }
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO decisions (local_id, task_id, text, rationale, owner_user_id, workspace_label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [decision.localId, decision.remoteTaskId, decision.text, decision.rationale ?? null, req.userId, decision.workspaceLabel ?? null, decision.createdAt]
      );
      results.push({ localId: decision.localId, remoteId: rows[0].id });
    }
    res.status(200).json({ results });
  });

  router.get('/decisions', async (req, res) => {
    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<DecisionRow>(
          `SELECT id, text, rationale, workspace_label, created_at FROM decisions
           WHERE task_id = $1 AND created_at > $2 ORDER BY created_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<DecisionRow>(
          `SELECT id, text, rationale, workspace_label, created_at FROM decisions WHERE task_id = $1 ORDER BY created_at ASC`,
          [taskRemoteId]
        );
    res.status(200).json({
      decisions: rows.map((r) => ({
        remoteId: r.id,
        text: r.text,
        rationale: r.rationale,
        workspaceLabel: r.workspace_label,
        createdAt: r.created_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  const pushErrorSchema = z.object({
    localId: z.string().min(1),
    remoteTaskId: z.string().uuid(),
    message: z.string().min(1),
    resolved: z.boolean(),
    resolution: z.string().nullable().optional(),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
  });
  const pushErrorsSchema = z.object({ errors: z.array(pushErrorSchema) });

  interface ErrorEntityRow {
    id: string;
    message: string;
    resolved: boolean;
    resolution: string | null;
    workspace_label: string | null;
    created_at: Date;
  }

  router.post('/errors', async (req: AuthenticatedRequest, res) => {
    const parsed = pushErrorsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }
    const results: { localId: string; remoteId: string }[] = [];
    for (const taskError of parsed.data.errors) {
      const taskExists = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [taskError.remoteTaskId]);
      if (taskExists.rows.length === 0) {
        const err = new ApiError(404, 'task_not_found', `No task with remoteId ${taskError.remoteTaskId}`);
        res.status(err.status).json(errorBody(err));
        return;
      }
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO errors (local_id, task_id, message, resolved, resolution, owner_user_id, workspace_label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [taskError.localId, taskError.remoteTaskId, taskError.message, taskError.resolved, taskError.resolution ?? null, req.userId, taskError.workspaceLabel ?? null, taskError.createdAt]
      );
      results.push({ localId: taskError.localId, remoteId: rows[0].id });
    }
    res.status(200).json({ results });
  });

  router.get('/errors', async (req, res) => {
    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<ErrorEntityRow>(
          `SELECT id, message, resolved, resolution, workspace_label, created_at FROM errors
           WHERE task_id = $1 AND created_at > $2 ORDER BY created_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<ErrorEntityRow>(
          `SELECT id, message, resolved, resolution, workspace_label, created_at FROM errors WHERE task_id = $1 ORDER BY created_at ASC`,
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
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  const pushOpenQuestionSchema = z.object({
    localId: z.string().min(1),
    remoteTaskId: z.string().uuid(),
    text: z.string().min(1),
    resolved: z.boolean(),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
  });
  const pushOpenQuestionsSchema = z.object({ openQuestions: z.array(pushOpenQuestionSchema) });

  interface OpenQuestionRow {
    id: string;
    text: string;
    resolved: boolean;
    workspace_label: string | null;
    created_at: Date;
  }

  router.post('/open-questions', async (req: AuthenticatedRequest, res) => {
    const parsed = pushOpenQuestionsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }
    const results: { localId: string; remoteId: string }[] = [];
    for (const question of parsed.data.openQuestions) {
      const taskExists = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [question.remoteTaskId]);
      if (taskExists.rows.length === 0) {
        const err = new ApiError(404, 'task_not_found', `No task with remoteId ${question.remoteTaskId}`);
        res.status(err.status).json(errorBody(err));
        return;
      }
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO open_questions (local_id, task_id, text, resolved, owner_user_id, workspace_label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [question.localId, question.remoteTaskId, question.text, question.resolved, req.userId, question.workspaceLabel ?? null, question.createdAt]
      );
      results.push({ localId: question.localId, remoteId: rows[0].id });
    }
    res.status(200).json({ results });
  });

  router.get('/open-questions', async (req, res) => {
    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<OpenQuestionRow>(
          `SELECT id, text, resolved, workspace_label, created_at FROM open_questions
           WHERE task_id = $1 AND created_at > $2 ORDER BY created_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<OpenQuestionRow>(
          `SELECT id, text, resolved, workspace_label, created_at FROM open_questions WHERE task_id = $1 ORDER BY created_at ASC`,
          [taskRemoteId]
        );
    res.status(200).json({
      openQuestions: rows.map((r) => ({
        remoteId: r.id,
        text: r.text,
        resolved: r.resolved,
        workspaceLabel: r.workspace_label,
        createdAt: r.created_at.toISOString(),
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  const pushCommandSchema = z.object({
    localId: z.string().min(1),
    remoteTaskId: z.string().uuid(),
    cmdRedacted: z.string().min(1),
    exitCode: z.number().int().nullable().optional(),
    summary: z.string().nullable().optional(),
    workspaceLabel: z.string().max(256).nullable().optional(),
    createdAt: z.string(),
  });
  const pushCommandsSchema = z.object({ commands: z.array(pushCommandSchema) });

  interface CommandRow {
    id: string;
    cmd_redacted: string;
    exit_code: number | null;
    summary: string | null;
    workspace_label: string | null;
    created_at: Date;
  }

  router.post('/commands', async (req: AuthenticatedRequest, res) => {
    const parsed = pushCommandsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }
    const results: { localId: string; remoteId: string }[] = [];
    for (const command of parsed.data.commands) {
      const taskExists = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [command.remoteTaskId]);
      if (taskExists.rows.length === 0) {
        const err = new ApiError(404, 'task_not_found', `No task with remoteId ${command.remoteTaskId}`);
        res.status(err.status).json(errorBody(err));
        return;
      }
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO commands (local_id, task_id, cmd_redacted, exit_code, summary, owner_user_id, workspace_label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [command.localId, command.remoteTaskId, command.cmdRedacted, command.exitCode ?? null, command.summary ?? null, req.userId, command.workspaceLabel ?? null, command.createdAt]
      );
      results.push({ localId: command.localId, remoteId: rows[0].id });
    }
    res.status(200).json({ results });
  });

  router.get('/commands', async (req, res) => {
    const taskRemoteId = typeof req.query.taskRemoteId === 'string' ? req.query.taskRemoteId : null;
    if (!taskRemoteId) {
      const err = new ApiError(400, 'invalid_request', 'taskRemoteId query parameter is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const serverTime = new Date();
    const { rows } = since
      ? await pool.query<CommandRow>(
          `SELECT id, cmd_redacted, exit_code, summary, workspace_label, created_at FROM commands
           WHERE task_id = $1 AND created_at > $2 ORDER BY created_at ASC`,
          [taskRemoteId, since]
        )
      : await pool.query<CommandRow>(
          `SELECT id, cmd_redacted, exit_code, summary, workspace_label, created_at FROM commands WHERE task_id = $1 ORDER BY created_at ASC`,
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
      })),
      serverTime: serverTime.toISOString(),
    });
  });

  return router;
}
