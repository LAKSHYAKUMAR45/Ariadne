import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { requireSingletonAdmin } from '../adminAccess.js';
import { MAX_CAPTURE_ID_LENGTH, requireCapturePath, requireSafeId } from '../captureValidation.js';
import { ApiError } from '../errors.js';
import { asyncHandler, type AuthenticatedRequest } from '../middleware.js';
import { requireTeamTask } from '../taskAccess.js';
import type { FileCaptureTrigger, TaskHistoryStore } from '../taskHistoryTypes.js';
import { requireUuidParam } from './taskHistory.js';

export type AdminTimelineKind =
  | 'task'
  | 'commit'
  | 'checkpoint'
  | 'capture'
  | 'command'
  | 'decision'
  | 'todo'
  | 'error'
  | 'question';

/**
 * Fixed tie-break order for events that share a timestamp. Coarse context
 * first (the task, then the commit and checkpoint that frame a moment), then
 * the captures taken at that moment, then the finer-grained curation entries.
 */
const TIMELINE_KIND_ORDER: readonly AdminTimelineKind[] = [
  'task',
  'commit',
  'checkpoint',
  'capture',
  'command',
  'decision',
  'todo',
  'error',
  'question',
];

const KIND_RANK = new Map<AdminTimelineKind, number>(
  TIMELINE_KIND_ORDER.map((kind, index) => [kind, index]),
);

export interface AdminTimelineEvent {
  kind: AdminTimelineKind;
  id: string;
  occurredAt: string;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface AdminCapturedFile {
  path: string;
  content: string;
  unifiedDiff: string;
  contentSha256: string;
  byteLength: number;
}

interface AdminTaskRow {
  id: string;
  local_id: string;
  title: string;
  goal: string | null;
  status: string;
  branch: string | null;
  workspace_label: string | null;
  username: string;
  created_at: Date;
  updated_at: Date;
  capture_count: string;
}

interface CaptureFileMetadata {
  path: string;
  contentSha256: string;
  byteLength: number;
}

interface CaptureTimelineRow {
  id: string;
  trigger: FileCaptureTrigger;
  git_commit_sha: string | null;
  checkpoint_id: string | null;
  created_at: Date;
  files: CaptureFileMetadata[];
}

/**
 * Sorts by instant, then by the fixed kind order, then by id. Timestamps are
 * all produced by `Date.toISOString()`, so lexicographic comparison is
 * chronological, and every tie is broken by a value stored in Postgres — the
 * same task therefore always renders in exactly the same order.
 */
function compareEvents(left: AdminTimelineEvent, right: AdminTimelineEvent): number {
  if (left.occurredAt !== right.occurredAt) {
    return left.occurredAt < right.occurredAt ? -1 : 1;
  }
  const leftRank = KIND_RANK.get(left.kind)!;
  const rightRank = KIND_RANK.get(right.kind)!;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function parsePagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const rawLimit = typeof query.limit === 'string' ? parseInt(query.limit, 10) : NaN;
  const rawOffset = typeof query.offset === 'string' ? parseInt(query.offset, 10) : NaN;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset };
}

function requireCaptureIdParam(value: unknown): string {
  try {
    return requireSafeId(value, 'captureId', MAX_CAPTURE_ID_LENGTH);
  } catch {
    throw new ApiError(400, 'invalid_request', 'captureId is not a valid capture identifier');
  }
}

/**
 * Validates the URL path segment naming a captured file. Express has already
 * percent-decoded the wildcard parameter exactly once, so this only validates
 * (never decodes again): traversal segments, absolute paths, backslashes, and
 * control characters are all rejected, and the failure detail is not echoed
 * back to the caller.
 */
function requireCapturePathParam(value: unknown): string {
  try {
    return requireCapturePath(value);
  } catch {
    throw new ApiError(
      400,
      'invalid_request',
      'Captured file path must be a normalized workspace-relative path',
    );
  }
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Admin audit reads over task history. Access is temporarily gated on the
 * singleton bearer admin: plan 04 replaces this with real browser sessions,
 * and deliberately no session logic is added here.
 *
 * The timeline is metadata only — captured file *content* is decrypted solely
 * by the dedicated per-file endpoint, which marks every response `no-store` so
 * decrypted text is never written to a shared cache.
 */
export function createAdminTasksRouter(pool: Pool, store: TaskHistoryStore): Router {
  const router = Router();

  async function requireAdminTask(req: AuthenticatedRequest): Promise<{ teamId: string; taskId: string }> {
    const membership = await requireSingletonAdmin(pool, req.userId!);
    const taskId = requireUuidParam(req.params.taskId, 'taskId');
    await requireTeamTask(pool, membership.teamId, taskId);
    return { teamId: membership.teamId, taskId };
  }

  router.get(
    '/tasks',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const membership = await requireSingletonAdmin(pool, req.userId!);
      const { limit, offset } = parsePagination(req.query as Record<string, unknown>);

      const { rows } = await pool.query<AdminTaskRow>(
        `SELECT t.id, t.local_id, t.title, t.goal, t.status, t.branch, t.workspace_label,
                t.created_at, t.updated_at, u.username,
                (SELECT count(*) FROM task_file_captures c
                  WHERE c.team_id = t.team_id AND c.task_id = t.id)::text AS capture_count
         FROM tasks t JOIN users u ON u.id = t.owner_user_id
         WHERE t.team_id = $1
         ORDER BY t.updated_at DESC, t.id ASC
         LIMIT $2 OFFSET $3`,
        [membership.teamId, limit + 1, offset],
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      noStore(res);
      res.status(200).json({
        tasks: page.map((row) => ({
          taskId: row.id,
          localId: row.local_id,
          title: row.title,
          goal: row.goal,
          status: row.status,
          branch: row.branch,
          workspaceLabel: row.workspace_label,
          owner: row.username,
          captureCount: Number(row.capture_count),
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        })),
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      });
    }),
  );

  router.get(
    '/tasks/:taskId/timeline',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { teamId, taskId } = await requireAdminTask(req);
      const events: AdminTimelineEvent[] = [];

      const task = await pool.query<AdminTaskRow>(
        `SELECT t.id, t.local_id, t.title, t.goal, t.status, t.branch, t.workspace_label,
                t.created_at, t.updated_at, u.username, '0' AS capture_count
         FROM tasks t JOIN users u ON u.id = t.owner_user_id
         WHERE t.id = $1 AND t.team_id = $2`,
        [taskId, teamId],
      );
      const taskRow = task.rows[0];
      if (taskRow) {
        events.push({
          kind: 'task',
          id: taskRow.id,
          occurredAt: taskRow.created_at.toISOString(),
          summary: taskRow.title,
          metadata: {
            localId: taskRow.local_id,
            goal: taskRow.goal,
            status: taskRow.status,
            branch: taskRow.branch,
            workspaceLabel: taskRow.workspace_label,
            owner: taskRow.username,
            updatedAt: taskRow.updated_at.toISOString(),
          },
        });
      }

      const checkpoints = await pool.query<{
        id: string;
        level: string;
        summary: string;
        workspace_label: string | null;
        created_at: Date;
      }>(
        `SELECT id, level, summary, workspace_label, created_at FROM checkpoints WHERE task_id = $1`,
        [taskId],
      );
      for (const row of checkpoints.rows) {
        events.push({
          kind: 'checkpoint',
          id: row.id,
          occurredAt: row.created_at.toISOString(),
          summary: row.summary,
          metadata: { level: row.level, workspaceLabel: row.workspace_label },
        });
      }

      const commands = await pool.query<{
        id: string;
        cmd_redacted: string;
        exit_code: number | null;
        summary: string | null;
        workspace_label: string | null;
        created_at: Date;
      }>(
        `SELECT id, cmd_redacted, exit_code, summary, workspace_label, created_at FROM commands WHERE task_id = $1`,
        [taskId],
      );
      for (const row of commands.rows) {
        events.push({
          kind: 'command',
          id: row.id,
          occurredAt: row.created_at.toISOString(),
          summary: row.cmd_redacted,
          metadata: {
            exitCode: row.exit_code,
            result: row.summary,
            workspaceLabel: row.workspace_label,
          },
        });
      }

      const decisions = await pool.query<{
        id: string;
        text: string;
        rationale: string | null;
        supersedes_id: string | null;
        workspace_label: string | null;
        created_at: Date;
      }>(
        `SELECT id, text, rationale, supersedes_id, workspace_label, created_at FROM decisions WHERE task_id = $1`,
        [taskId],
      );
      for (const row of decisions.rows) {
        events.push({
          kind: 'decision',
          id: row.id,
          occurredAt: row.created_at.toISOString(),
          summary: row.text,
          metadata: {
            rationale: row.rationale,
            supersedesId: row.supersedes_id,
            workspaceLabel: row.workspace_label,
          },
        });
      }

      const todos = await pool.query<{
        id: string;
        text: string;
        status: string;
        workspace_label: string | null;
        created_at: Date;
      }>(`SELECT id, text, status, workspace_label, created_at FROM todos WHERE task_id = $1`, [taskId]);
      for (const row of todos.rows) {
        events.push({
          kind: 'todo',
          id: row.id,
          occurredAt: row.created_at.toISOString(),
          summary: row.text,
          metadata: { status: row.status, workspaceLabel: row.workspace_label },
        });
      }

      const taskErrors = await pool.query<{
        id: string;
        message: string;
        resolved: boolean;
        resolution: string | null;
        workspace_label: string | null;
        created_at: Date;
      }>(
        `SELECT id, message, resolved, resolution, workspace_label, created_at FROM errors WHERE task_id = $1`,
        [taskId],
      );
      for (const row of taskErrors.rows) {
        events.push({
          kind: 'error',
          id: row.id,
          occurredAt: row.created_at.toISOString(),
          summary: row.message,
          metadata: {
            resolved: row.resolved,
            resolution: row.resolution,
            workspaceLabel: row.workspace_label,
          },
        });
      }

      const questions = await pool.query<{
        id: string;
        text: string;
        resolved: boolean;
        workspace_label: string | null;
        created_at: Date;
      }>(
        `SELECT id, text, resolved, workspace_label, created_at FROM open_questions WHERE task_id = $1`,
        [taskId],
      );
      for (const row of questions.rows) {
        events.push({
          kind: 'question',
          id: row.id,
          occurredAt: row.created_at.toISOString(),
          summary: row.text,
          metadata: { resolved: row.resolved, workspaceLabel: row.workspace_label },
        });
      }

      // Capture rows carry only path/hash/size metadata here; `byteLength`
      // comes from the encrypted blob's authenticated plaintext length, so no
      // decryption is needed to render a file list.
      const captures = await pool.query<CaptureTimelineRow>(
        `SELECT c.id, c."trigger", c.git_commit_sha, c.checkpoint_id, c.created_at,
                coalesce(
                  json_agg(
                    json_build_object(
                      'path', e.path,
                      'contentSha256', e.snapshot_sha256,
                      'byteLength', b.plaintext_bytes
                    ) ORDER BY e.path ASC
                  ) FILTER (WHERE e.path IS NOT NULL),
                  '[]'::json
                ) AS files
         FROM task_file_captures c
         LEFT JOIN task_file_capture_entries e
           ON e.team_id = c.team_id AND e.capture_id = c.id
         LEFT JOIN encrypted_blobs b ON b.id = e.snapshot_blob_id
         WHERE c.team_id = $1 AND c.task_id = $2
         GROUP BY c.id, c."trigger", c.git_commit_sha, c.checkpoint_id, c.created_at`,
        [teamId, taskId],
      );

      // Commit events are derived from commit-triggered captures (the server
      // stores no separate commits table), deduplicated by SHA and dated at the
      // earliest capture that recorded them.
      const commits = new Map<string, { occurredAt: string; captureIds: string[] }>();
      for (const row of captures.rows) {
        const occurredAt = row.created_at.toISOString();
        const files = row.files ?? [];
        events.push({
          kind: 'capture',
          id: row.id,
          occurredAt,
          summary: `${row.trigger} capture of ${files.length} file(s)`,
          metadata: {
            trigger: row.trigger,
            gitCommitSha: row.git_commit_sha,
            checkpointId: row.checkpoint_id,
            entryCount: files.length,
            files,
          },
        });

        if (row.trigger === 'git_commit' && row.git_commit_sha) {
          const existing = commits.get(row.git_commit_sha);
          if (existing) {
            existing.captureIds.push(row.id);
            existing.occurredAt = existing.occurredAt < occurredAt ? existing.occurredAt : occurredAt;
          } else {
            commits.set(row.git_commit_sha, { occurredAt, captureIds: [row.id] });
          }
        }
      }
      for (const [sha, commit] of commits) {
        events.push({
          kind: 'commit',
          id: sha,
          occurredAt: commit.occurredAt,
          summary: `Commit ${sha.slice(0, 12)}`,
          metadata: { gitCommitSha: sha, captureIds: [...commit.captureIds].sort() },
        });
      }

      events.sort(compareEvents);
      noStore(res);
      res.status(200).json({ taskId, events });
    }),
  );

  router.get(
    '/tasks/:taskId/file-captures/:captureId/files/:path(*)',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { teamId, taskId } = await requireAdminTask(req);
      const captureId = requireCaptureIdParam(req.params.captureId);
      const filePath = requireCapturePathParam(req.params.path);

      const record = await store.readCapture(teamId, taskId, captureId);
      const entry = record.entries.find((candidate) => candidate.path === filePath);
      if (!entry) {
        throw new ApiError(404, 'capture_file_not_found', 'The capture does not contain that path');
      }

      const file: AdminCapturedFile = {
        path: entry.path,
        content: entry.content.toString('utf8'),
        unifiedDiff: entry.unifiedDiff.toString('utf8'),
        contentSha256: entry.contentSha256,
        byteLength: entry.content.length,
      };

      noStore(res);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).json(file);
    }),
  );

  return router;
}
