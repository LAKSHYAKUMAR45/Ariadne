import type { Database as DatabaseType } from 'better-sqlite3';
import { ulid } from 'ulid';
import { openDatabase } from './db.js';
import { openRegistry, upsertTaskIndex } from './Registry.js';
import type {
  Task,
  NewTask,
  TaskStatus,
  Checkpoint,
  NewCheckpoint,
  TaskFile,
  TaskFileCapture,
  TaskFileCaptureEntry,
  TaskFileCaptureWithEntries,
  CreateTaskFileCaptureInput,
  FileRole,
  Commit,
  NewCommit,
  Decision,
  NewDecision,
  Todo,
  NewTodo,
  TodoStatus,
  Command,
  NewCommand,
  TaskError,
  NewTaskError,
  OpenQuestion,
  NewOpenQuestion,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

// Raw row shapes as returned by better-sqlite3 (snake_case, SQLite integer booleans).
interface TaskRow {
  id: string;
  title: string;
  goal: string | null;
  status: TaskStatus;
  parent_task_id: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  remote_id: string | null;
  synced_at: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    parentTaskId: row.parent_task_id,
    branch: row.branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    remoteId: row.remote_id,
    syncedAt: row.synced_at,
  };
}

interface CheckpointRow {
  id: string;
  task_id: string;
  parent_checkpoint_id: string | null;
  level: Checkpoint['level'];
  summary: string;
  created_at: string;
  remote_id: string | null;
  synced_at: string | null;
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    parentCheckpointId: row.parent_checkpoint_id,
    level: row.level,
    summary: row.summary,
    createdAt: row.created_at,
    remoteId: row.remote_id,
    syncedAt: row.synced_at,
  };
}

interface FileRow {
  task_id: string;
  path: string;
  role: FileRole;
  last_touched: string;
}

function rowToFile(row: FileRow): TaskFile {
  return {
    taskId: row.task_id,
    path: row.path,
    role: row.role,
    lastTouched: row.last_touched,
  };
}

interface TaskFileCaptureRow {
  id: string;
  task_id: string;
  trigger: TaskFileCapture['trigger'];
  git_commit_sha: string | null;
  checkpoint_id: string | null;
  created_at: string;
  synced_at: string | null;
}

function rowToTaskFileCapture(row: TaskFileCaptureRow): TaskFileCapture {
  return {
    id: row.id,
    taskId: row.task_id,
    trigger: row.trigger,
    gitCommitSha: row.git_commit_sha,
    checkpointId: row.checkpoint_id,
    createdAt: row.created_at,
    syncedAt: row.synced_at,
  };
}

interface TaskFileCaptureEntryRow {
  capture_id: string;
  path: string;
  content: string;
  unified_diff: string;
  byte_length: number;
  content_sha256: string;
}

function rowToTaskFileCaptureEntry(row: TaskFileCaptureEntryRow): TaskFileCaptureEntry {
  return {
    captureId: row.capture_id,
    path: row.path,
    content: row.content,
    unifiedDiff: row.unified_diff,
    byteLength: row.byte_length,
    contentSha256: row.content_sha256,
  };
}

interface CommitRow {
  sha: string;
  task_id: string;
  checkpoint_id: string | null;
  message: string | null;
  created_at: string;
}

function rowToCommit(row: CommitRow): Commit {
  return {
    sha: row.sha,
    taskId: row.task_id,
    checkpointId: row.checkpoint_id,
    message: row.message,
    createdAt: row.created_at,
  };
}

interface DecisionRow {
  id: string;
  task_id: string;
  checkpoint_id: string | null;
  text: string;
  rationale: string | null;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
  remote_id: string | null;
  synced_at: string | null;
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    taskId: row.task_id,
    checkpointId: row.checkpoint_id,
    text: row.text,
    rationale: row.rationale,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    remoteId: row.remote_id,
    syncedAt: row.synced_at,
  };
}

interface TodoRow {
  id: string;
  task_id: string;
  text: string;
  status: TodoStatus;
  source_checkpoint_id: string | null;
  created_at: string;
  updated_at: string;
  remote_id: string | null;
  synced_at: string | null;
}

function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    taskId: row.task_id,
    text: row.text,
    status: row.status,
    sourceCheckpointId: row.source_checkpoint_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    remoteId: row.remote_id,
    syncedAt: row.synced_at,
  };
}

interface CommandRow {
  id: string;
  task_id: string;
  cmd_redacted: string;
  exit_code: number | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  remote_id: string | null;
  synced_at: string | null;
}

function rowToCommand(row: CommandRow): Command {
  return {
    id: row.id,
    taskId: row.task_id,
    cmdRedacted: row.cmd_redacted,
    exitCode: row.exit_code,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    remoteId: row.remote_id,
    syncedAt: row.synced_at,
  };
}

interface ErrorRow {
  id: string;
  task_id: string;
  message: string;
  resolved: number;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  remote_id: string | null;
  synced_at: string | null;
}

function rowToError(row: ErrorRow): TaskError {
  return {
    id: row.id,
    taskId: row.task_id,
    message: row.message,
    resolved: Boolean(row.resolved),
    resolution: row.resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    remoteId: row.remote_id,
    syncedAt: row.synced_at,
  };
}

interface OpenQuestionRow {
  id: string;
  task_id: string;
  text: string;
  resolved: number;
  created_at: string;
  updated_at: string;
  remote_id: string | null;
  synced_at: string | null;
}

function rowToOpenQuestion(row: OpenQuestionRow): OpenQuestion {
  return {
    id: row.id,
    taskId: row.task_id,
    text: row.text,
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    remoteId: row.remote_id,
    syncedAt: row.synced_at,
  };
}

/**
 * TaskStore is the single entry point for reading/writing Ariadne task state.
 * It wraps a SQLite connection (better-sqlite3, synchronous) and exposes a
 * typed, camelCase API. All three surfaces (CLI, MCP server, VS Code
 * extension) depend on this class exclusively — no surface talks to SQLite
 * directly.
 */
export class TaskStore {
  private readonly db: DatabaseType;
  private readonly workspaceRoot?: string;

  /**
   * `workspaceRoot`, when given, links this store to the global
   * cross-workspace registry (`Registry.ts` / `~/.ariadne/registry.db`):
   * every mutation that changes a task's title/goal/status/updatedAt keeps
   * that task's registry entry in sync automatically, so `task list
   * --all-workspaces` / `search --all-workspaces` and friends see live data
   * from any surface (CLI, MCP server, VS Code extension) without each of
   * them having to remember to call into the registry themselves. Omit it
   * (e.g. in tests using `:memory:`) to opt out of registry syncing entirely.
   */
  constructor(dbPath: string, workspaceRoot?: string) {
    this.db = openDatabase(dbPath);
    this.workspaceRoot = workspaceRoot;
  }

  /** Closes the underlying database connection. */
  close(): void {
    this.db.close();
  }

  /** Upserts `taskId`'s current row into the global registry, if this store is linked to one (see constructor). No-op otherwise. */
  private syncToRegistry(taskId: string): void {
    if (!this.workspaceRoot) return;
    const task = this.getTask(taskId);
    if (!task) return;
    try {
      upsertTaskIndex(openRegistry(), this.workspaceRoot, task);
    } catch {
      // Best-effort only — a registry write failure (e.g. unwritable home
      // dir) must never break the actual mutation this store just made.
    }
  }

  // ---------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------

  createTask(input: NewTask): Task {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, goal, status, parent_task_id, branch, created_at, updated_at)
         VALUES (@id, @title, @goal, @status, @parentTaskId, @branch, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        title: input.title,
        goal: input.goal ?? null,
        status: input.status ?? 'active',
        parentTaskId: input.parentTaskId ?? null,
        branch: input.branch ?? null,
        createdAt: ts,
        updatedAt: ts,
      });
    const task = this.getTask(id)!;
    this.syncToRegistry(id);
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
      | TaskRow
      | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listTasks(filter?: { status?: TaskStatus }): Task[] {
    const rows = filter?.status
      ? (this.db
          .prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC`)
          .all(filter.status) as TaskRow[])
      : (this.db.prepare(`SELECT * FROM tasks ORDER BY updated_at DESC`).all() as TaskRow[]);
    return rows.map(rowToTask);
  }

  updateTaskStatus(id: string, status: TaskStatus): void {
    this.db
      .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowIso(), id);
    this.syncToRegistry(id);
  }

  /** Renames a task's title (curation — fixing a bad/stale title without needing to recreate the task). */
  updateTaskTitle(id: string, title: string): void {
    this.db.prepare(`UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?`).run(title, nowIso(), id);
    this.syncToRegistry(id);
  }

  /** Updates a task's goal (pass `null` to clear it). Curation counterpart to setting the goal at creation time. */
  updateTaskGoal(id: string, goal: string | null): void {
    this.db.prepare(`UPDATE tasks SET goal = ?, updated_at = ? WHERE id = ?`).run(goal, nowIso(), id);
    this.syncToRegistry(id);
  }

  /** Updates a task's tracked git branch (used by GitWatcher when it detects a branch switch). */
  updateTaskBranch(id: string, branch: string | null): void {
    this.db
      .prepare(`UPDATE tasks SET branch = ?, updated_at = ? WHERE id = ?`)
      .run(branch, nowIso(), id);
    this.syncToRegistry(id);
  }

  touchTask(id: string): void {
    this.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(nowIso(), id);
    this.syncToRegistry(id);
  }

  addTaskDependency(taskId: string, dependsOn: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)`)
      .run(taskId, dependsOn);
  }

  // ---------------------------------------------------------------------
  // Cloud sync (see docs/07-CLOUD-SYNC-API-CONTRACT.md)
  // ---------------------------------------------------------------------

  /**
   * Tasks that either have never been pushed (`remoteId` null) or have
   * been modified locally since their last sync (`updatedAt > syncedAt`).
   * Used by `ariadne sync push` to decide what to send.
   */
  listTasksNeedingPush(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE remote_id IS NULL OR synced_at IS NULL OR updated_at > synced_at
         ORDER BY updated_at ASC`,
      )
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Records the result of a successful push/pull for a task: its server-assigned id and the sync timestamp. */
  setTaskRemoteSync(id: string, remoteId: string, syncedAt: string): void {
    this.db
      .prepare(`UPDATE tasks SET remote_id = ?, synced_at = ? WHERE id = ?`)
      .run(remoteId, syncedAt, id);
  }

  /**
   * Clears a task's link to the sync server (`remote_id`/`synced_at` both
   * reset to null) without touching the server or the task's own content.
   * Used by `ariadne sync unlink` when a task was linked in error, or a
   * user wants a clean local copy that no longer participates in sync. A
   * later `sync push` will treat it as brand-new and create a fresh remote
   * row (the old server-side row, if any, is left as-is — this is purely a
   * local un-linking, not a delete).
   */
  unlinkTaskFromRemote(id: string): void {
    this.db.prepare(`UPDATE tasks SET remote_id = NULL, synced_at = NULL WHERE id = ?`).run(id);
  }

  /** Looks up a task by its cloud-sync-server id (used when pulling to find the matching local row, if any). */
  getTaskByRemoteId(remoteId: string): Task | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE remote_id = ?`).get(remoteId) as
      | TaskRow
      | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Applies a task update pulled from the sync server to an existing local
   * row already linked via `remoteId`. Sets `updatedAt`/`syncedAt` to the
   * values the server reported (rather than "now"), so the row doesn't
   * immediately reappear in `listTasksNeedingPush` as if it had been
   * modified locally.
   */
  applyPulledTask(
    localId: string,
    update: { title: string; goal: string | null; status: TaskStatus; branch: string | null; updatedAt: string; syncedAt: string },
  ): void {
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, goal = ?, status = ?, branch = ?, updated_at = ?, synced_at = ? WHERE id = ?`,
      )
      .run(update.title, update.goal, update.status, update.branch, update.updatedAt, update.syncedAt, localId);
    this.syncToRegistry(localId);
  }

  /**
   * Creates a brand-new local task from one pulled from the sync server
   * that this workspace has never linked before — used by `ariadne sync
   * pull --import-new` (see docs/07-CLOUD-SYNC-API-CONTRACT.md §4.2).
   * Unlike `createTask`, this uses the server's own `createdAt`/`updatedAt`
   * (not "now") and sets `remote_id`/`synced_at` immediately, so the new
   * row is already linked and won't be re-pushed as if it were freshly
   * created locally.
   */
  insertPulledTask(input: {
    remoteId: string;
    title: string;
    goal: string | null;
    status: TaskStatus;
    branch: string | null;
    createdAt: string;
    updatedAt: string;
    syncedAt: string;
  }): Task {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, goal, status, branch, remote_id, created_at, updated_at, synced_at)
         VALUES (@id, @title, @goal, @status, @branch, @remoteId, @createdAt, @updatedAt, @syncedAt)`,
      )
      .run({
        id,
        title: input.title,
        goal: input.goal,
        status: input.status,
        branch: input.branch,
        remoteId: input.remoteId,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        syncedAt: input.syncedAt,
      });
    const task = this.getTask(id)!;
    this.syncToRegistry(id);
    return task;
  }

  // ---------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------

  createCheckpoint(input: NewCheckpoint): Checkpoint {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, task_id, parent_checkpoint_id, level, summary, created_at)
         VALUES (@id, @taskId, @parentCheckpointId, @level, @summary, @createdAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        parentCheckpointId: input.parentCheckpointId ?? null,
        level: input.level,
        summary: input.summary,
        createdAt: ts,
      });
    this.touchTask(input.taskId);
    return this.getCheckpoint(id)!;
  }

  getCheckpoint(id: string): Checkpoint | undefined {
    const row = this.db.prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(id) as
      | CheckpointRow
      | undefined;
    return row ? rowToCheckpoint(row) : undefined;
  }

  listCheckpoints(taskId: string, limit?: number): Checkpoint[] {
    const sql = `SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC${
      limit ? ' LIMIT ?' : ''
    }`;
    const rows = (
      limit
        ? this.db.prepare(sql).all(taskId, limit)
        : this.db.prepare(sql).all(taskId)
    ) as CheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  latestCheckpoint(taskId: string): Checkpoint | undefined {
    return this.listCheckpoints(taskId, 1)[0];
  }

  /** Re-parents a checkpoint under a rolled-up ancestor (used by CheckpointEngine's rollup). */
  setCheckpointParent(id: string, parentCheckpointId: string): void {
    this.db.prepare(`UPDATE checkpoints SET parent_checkpoint_id = ? WHERE id = ?`).run(parentCheckpointId, id);
  }

  /**
   * Checkpoints never pushed yet (`remoteId` null). Checkpoints are
   * append-only/immutable locally (see schema.ts), so unlike tasks there's
   * no "modified since last sync" case to detect — once pushed, a
   * checkpoint never needs re-pushing.
   */
  listCheckpointsNeedingPush(taskId?: string): Checkpoint[] {
    const rows = taskId
      ? (this.db
          .prepare(`SELECT * FROM checkpoints WHERE remote_id IS NULL AND task_id = ? ORDER BY created_at ASC`)
          .all(taskId) as CheckpointRow[])
      : (this.db
          .prepare(`SELECT * FROM checkpoints WHERE remote_id IS NULL ORDER BY created_at ASC`)
          .all() as CheckpointRow[]);
    return rows.map(rowToCheckpoint);
  }

  /** Records the result of a successful push for a checkpoint: its server-assigned id and the sync timestamp. */
  setCheckpointRemoteSync(id: string, remoteId: string, syncedAt: string): void {
    this.db
      .prepare(`UPDATE checkpoints SET remote_id = ?, synced_at = ? WHERE id = ?`)
      .run(remoteId, syncedAt, id);
  }

  /** Looks up a checkpoint by its cloud-sync-server id (used when pulling to avoid inserting a duplicate for one already synced). */
  getCheckpointByRemoteId(remoteId: string): Checkpoint | undefined {
    const row = this.db.prepare(`SELECT * FROM checkpoints WHERE remote_id = ?`).get(remoteId) as
      | CheckpointRow
      | undefined;
    return row ? rowToCheckpoint(row) : undefined;
  }

  /**
   * Inserts a checkpoint pulled from the sync server that doesn't exist
   * locally yet, preserving the server's `createdAt` and marking it synced
   * immediately. Does not touch the parent task's `updatedAt` — this is
   * inbound data arriving via pull, not a local mutation.
   */
  insertPulledCheckpoint(input: {
    taskId: string;
    remoteId: string;
    level: Checkpoint['level'];
    summary: string;
    createdAt: string;
    syncedAt: string;
  }): Checkpoint {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, task_id, level, summary, created_at, remote_id, synced_at)
         VALUES (@id, @taskId, @level, @summary, @createdAt, @remoteId, @syncedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        level: input.level,
        summary: input.summary,
        createdAt: input.createdAt,
        remoteId: input.remoteId,
        syncedAt: input.syncedAt,
      });
    return this.getCheckpoint(id)!;
  }

  // ---------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------

  touchFile(input: { taskId: string; path: string; role: FileRole }): TaskFile {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO files (task_id, path, role, last_touched)
         VALUES (@taskId, @path, @role, @lastTouched)
         ON CONFLICT(task_id, path) DO UPDATE SET role = excluded.role, last_touched = excluded.last_touched`,
      )
      .run({ taskId: input.taskId, path: input.path, role: input.role, lastTouched: ts });
    this.touchTask(input.taskId);
    const row = this.db
      .prepare(`SELECT * FROM files WHERE task_id = ? AND path = ?`)
      .get(input.taskId, input.path) as FileRow;
    return rowToFile(row);
  }

  listFiles(taskId: string, limit?: number): TaskFile[] {
    const sql = `SELECT * FROM files WHERE task_id = ? ORDER BY last_touched DESC${
      limit ? ' LIMIT ?' : ''
    }`;
    const rows = (
      limit ? this.db.prepare(sql).all(taskId, limit) : this.db.prepare(sql).all(taskId)
    ) as FileRow[];
    return rows.map(rowToFile);
  }

  // ---------------------------------------------------------------------
  // Immutable task file captures
  // ---------------------------------------------------------------------

  private getTaskFileCapture(id: string): TaskFileCaptureWithEntries | undefined {
    return this.listTaskFileCaptures(`id = ?`, [id], 'created_at DESC')[0];
  }

  private listTaskFileCaptures(
    whereClause: string,
    params: readonly (string | null)[],
    orderBy: 'created_at ASC' | 'created_at DESC',
  ): TaskFileCaptureWithEntries[] {
    const captures = this.db
      .prepare(`SELECT * FROM task_file_captures WHERE ${whereClause} ORDER BY ${orderBy}, id ${orderBy.endsWith('ASC') ? 'ASC' : 'DESC'}`)
      .all(...params) as TaskFileCaptureRow[];
    if (captures.length === 0) {
      return [];
    }

    const entries = this.db
      .prepare(
        `SELECT * FROM task_file_capture_entries
         WHERE capture_id IN (${captures.map(() => '?').join(', ')})
         ORDER BY capture_id ASC, path ASC`,
      )
      .all(...captures.map((capture) => capture.id)) as TaskFileCaptureEntryRow[];

    const entriesByCaptureId = new Map<string, TaskFileCaptureEntry[]>();
    for (const entry of entries) {
      const existing = entriesByCaptureId.get(entry.capture_id) ?? [];
      existing.push(rowToTaskFileCaptureEntry(entry));
      entriesByCaptureId.set(entry.capture_id, existing);
    }

    return captures.map((capture) => ({
      ...rowToTaskFileCapture(capture),
      entries: [...(entriesByCaptureId.get(capture.id) ?? [])],
    }));
  }

  private getIdempotentTaskFileCapture(input: CreateTaskFileCaptureInput): TaskFileCaptureWithEntries | undefined {
    if (input.trigger === 'git_commit' && input.gitCommitSha) {
      return this.listTaskFileCaptures(
        `task_id = ? AND trigger = 'git_commit' AND git_commit_sha = ?`,
        [input.taskId, input.gitCommitSha],
        'created_at DESC',
      )[0];
    }

    if (input.trigger === 'checkpoint' && input.checkpointId) {
      return this.listTaskFileCaptures(
        `task_id = ? AND trigger = 'checkpoint' AND checkpoint_id = ?`,
        [input.taskId, input.checkpointId],
        'created_at DESC',
      )[0];
    }

    return undefined;
  }

  private validateTaskFileCaptureInput(input: CreateTaskFileCaptureInput): void {
    if (input.trigger === 'git_commit' && !input.gitCommitSha) {
      throw new Error('git_commit task file captures require gitCommitSha');
    }

    if (input.trigger === 'checkpoint' && !input.checkpointId) {
      throw new Error('checkpoint task file captures require checkpointId');
    }
  }

  createTaskFileCapture(input: CreateTaskFileCaptureInput): TaskFileCaptureWithEntries {
    this.validateTaskFileCaptureInput(input);

    const capture = this.db.transaction(() => {
      const existing = this.getIdempotentTaskFileCapture(input);
      if (existing) {
        return existing;
      }

      const id = ulid();
      const createdAt = nowIso();
      const entries = input.entries.map((entry) => ({ ...entry }));

      this.db
        .prepare(
          `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
           VALUES (@id, @taskId, @trigger, @gitCommitSha, @checkpointId, @createdAt, NULL)`,
        )
        .run({
          id,
          taskId: input.taskId,
          trigger: input.trigger,
          gitCommitSha: input.gitCommitSha ?? null,
          checkpointId: input.checkpointId ?? null,
          createdAt,
        });

      const insertEntry = this.db.prepare(
        `INSERT INTO task_file_capture_entries (capture_id, path, content, unified_diff, byte_length, content_sha256)
         VALUES (@captureId, @path, @content, @unifiedDiff, @byteLength, @contentSha256)`,
      );
      for (const entry of entries) {
        insertEntry.run({
          captureId: id,
          path: entry.path,
          content: entry.content,
          unifiedDiff: entry.unifiedDiff,
          byteLength: entry.byteLength,
          contentSha256: entry.contentSha256,
        });
      }

      this.touchTask(input.taskId);
      return this.getTaskFileCapture(id)!;
    })();

    return {
      ...capture,
      entries: capture.entries.map((entry) => ({ ...entry })),
    };
  }

  getTaskFileCaptures(taskId: string): TaskFileCaptureWithEntries[] {
    return this.listTaskFileCaptures(`task_id = ?`, [taskId], 'created_at DESC').map((capture) => ({
      ...capture,
      entries: capture.entries.map((entry) => ({ ...entry })),
    }));
  }

  getPendingTaskFileCaptures(taskId: string): TaskFileCaptureWithEntries[] {
    return this.listTaskFileCaptures(`task_id = ? AND synced_at IS NULL`, [taskId], 'created_at ASC').map((capture) => ({
      ...capture,
      entries: capture.entries.map((entry) => ({ ...entry })),
    }));
  }

  markTaskFileCaptureSynced(captureId: string, syncedAt: string = nowIso()): void {
    this.db.prepare(`UPDATE task_file_captures SET synced_at = ? WHERE id = ?`).run(syncedAt, captureId);
  }

  // ---------------------------------------------------------------------
  // Commits
  // ---------------------------------------------------------------------

  /**
   * Records a commit against a task. `sha` is globally unique (a commit
   * belongs to exactly one task), so if it's already recorded — against
   * this task or (via a shared git history) a different one — this is a
   * no-op that returns the existing row rather than throwing. This keeps
   * `syncTaskGit`'s "safe to call repeatedly" contract true even when the
   * same commit is reachable from more than one task's workspace/branch.
   */
  recordCommit(input: NewCommit): Commit {
    const ts = nowIso();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO commits (sha, task_id, checkpoint_id, message, created_at)
         VALUES (@sha, @taskId, @checkpointId, @message, @createdAt)`,
      )
      .run({
        sha: input.sha,
        taskId: input.taskId,
        checkpointId: input.checkpointId ?? null,
        message: input.message ?? null,
        createdAt: ts,
      });
    if (result.changes > 0) {
      this.touchTask(input.taskId);
    }
    const row = this.db.prepare(`SELECT * FROM commits WHERE sha = ?`).get(input.sha) as CommitRow;
    return rowToCommit(row);
  }

  /** Whether a commit sha is already recorded, against any task. */
  commitExists(sha: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM commits WHERE sha = ?`).get(sha);
    return Boolean(row);
  }

  listCommits(taskId: string, limit?: number): Commit[] {
    const sql = `SELECT * FROM commits WHERE task_id = ? ORDER BY created_at DESC${
      limit ? ' LIMIT ?' : ''
    }`;
    const rows = (
      limit ? this.db.prepare(sql).all(taskId, limit) : this.db.prepare(sql).all(taskId)
    ) as CommitRow[];
    return rows.map(rowToCommit);
  }

  // ---------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------

  recordDecision(input: NewDecision): Decision {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO decisions (id, task_id, checkpoint_id, text, rationale, supersedes_id, created_at, updated_at)
         VALUES (@id, @taskId, @checkpointId, @text, @rationale, @supersedesId, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        checkpointId: input.checkpointId ?? null,
        text: input.text,
        rationale: input.rationale ?? null,
        supersedesId: input.supersedesId ?? null,
        createdAt: ts,
        updatedAt: ts,
      });
    this.touchTask(input.taskId);
    const row = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as DecisionRow;
    return rowToDecision(row);
  }

  listDecisions(taskId: string, limit?: number): Decision[] {
    const sql = `SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at DESC${
      limit ? ' LIMIT ?' : ''
    }`;
    const rows = (
      limit ? this.db.prepare(sql).all(taskId, limit) : this.db.prepare(sql).all(taskId)
    ) as DecisionRow[];
    return rows.map(rowToDecision);
  }

  getDecision(id: string): Decision | undefined {
    const row = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as DecisionRow | undefined;
    return row ? rowToDecision(row) : undefined;
  }

  /** Curation: edit a decision's text, rationale, and/or `supersedesId` (e.g. to fix a typo, add missing context, or mark it as replacing/no-longer-replacing another decision) without losing its id/history. */
  updateDecision(id: string, updates: { text?: string; rationale?: string | null; supersedesId?: string | null }): void {
    const existing = this.getDecision(id);
    if (!existing) return;
    this.db
      .prepare(`UPDATE decisions SET text = ?, rationale = ?, supersedes_id = ?, updated_at = ? WHERE id = ?`)
      .run(
        updates.text ?? existing.text,
        updates.rationale !== undefined ? updates.rationale : existing.rationale,
        updates.supersedesId !== undefined ? updates.supersedesId : existing.supersedesId,
        nowIso(),
        id,
      );
    this.touchTask(existing.taskId);
  }

  /** Curation: permanently remove a wrongly-recorded decision. */
  deleteDecision(id: string): void {
    const existing = this.getDecision(id);
    if (!existing) return;
    this.db.prepare(`DELETE FROM decisions WHERE id = ?`).run(id);
    this.touchTask(existing.taskId);
  }

  listDecisionsNeedingPush(taskId?: string): Decision[] {
    const sql = `SELECT * FROM decisions WHERE (remote_id IS NULL OR synced_at IS NULL OR updated_at > synced_at)${
      taskId ? ' AND task_id = ?' : ''
    } ORDER BY created_at ASC`;
    const rows = (taskId ? this.db.prepare(sql).all(taskId) : this.db.prepare(sql).all()) as DecisionRow[];
    return rows.map(rowToDecision);
  }

  setDecisionRemoteSync(id: string, remoteId: string, syncedAt: string): void {
    this.db.prepare(`UPDATE decisions SET remote_id = ?, synced_at = ? WHERE id = ?`).run(remoteId, syncedAt, id);
  }

  getDecisionByRemoteId(remoteId: string): Decision | undefined {
    const row = this.db.prepare(`SELECT * FROM decisions WHERE remote_id = ?`).get(remoteId) as DecisionRow | undefined;
    return row ? rowToDecision(row) : undefined;
  }

  /** Applies a remote update to an already-linked local decision. Does not touch the parent task's `updatedAt` — inbound data, not a local mutation. */
  applyPulledDecision(
    id: string,
    updates: { text: string; rationale: string | null; supersedesId: string | null; updatedAt: string; syncedAt: string },
  ): void {
    this.db
      .prepare(`UPDATE decisions SET text = ?, rationale = ?, supersedes_id = ?, updated_at = ?, synced_at = ? WHERE id = ?`)
      .run(updates.text, updates.rationale, updates.supersedesId, updates.updatedAt, updates.syncedAt, id);
  }

  /** Inserts a decision pulled from the sync server that doesn't exist locally yet. Does not touch the parent task's `updatedAt` — inbound data, not a local mutation. */
  insertPulledDecision(input: {
    taskId: string;
    remoteId: string;
    text: string;
    rationale: string | null;
    supersedesId: string | null;
    createdAt: string;
    updatedAt: string;
    syncedAt: string;
  }): Decision {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO decisions (id, task_id, text, rationale, supersedes_id, created_at, updated_at, remote_id, synced_at)
         VALUES (@id, @taskId, @text, @rationale, @supersedesId, @createdAt, @updatedAt, @remoteId, @syncedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        text: input.text,
        rationale: input.rationale,
        supersedesId: input.supersedesId,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        remoteId: input.remoteId,
        syncedAt: input.syncedAt,
      });
    return this.getDecision(id)!;
  }

  // ---------------------------------------------------------------------
  // Todos
  // ---------------------------------------------------------------------

  createTodo(input: NewTodo): Todo {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO todos (id, task_id, text, status, source_checkpoint_id, created_at, updated_at)
         VALUES (@id, @taskId, @text, @status, @sourceCheckpointId, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        text: input.text,
        status: input.status ?? 'pending',
        sourceCheckpointId: input.sourceCheckpointId ?? null,
        createdAt: ts,
        updatedAt: ts,
      });
    this.touchTask(input.taskId);
    return this.getTodo(id)!;
  }

  getTodo(id: string): Todo | undefined {
    const row = this.db.prepare(`SELECT * FROM todos WHERE id = ?`).get(id) as
      | TodoRow
      | undefined;
    return row ? rowToTodo(row) : undefined;
  }

  updateTodoStatus(id: string, status: TodoStatus): void {
    const existing = this.getTodo(id);
    this.db
      .prepare(`UPDATE todos SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowIso(), id);
    if (existing) this.touchTask(existing.taskId);
  }

  /** Curation: edit a todo's text (e.g. to fix a typo or clarify scope) without losing its id/history. */
  updateTodoText(id: string, text: string): void {
    const existing = this.getTodo(id);
    if (!existing) return;
    this.db.prepare(`UPDATE todos SET text = ?, updated_at = ? WHERE id = ?`).run(text, nowIso(), id);
    this.touchTask(existing.taskId);
  }

  /** Curation: permanently remove a wrongly-recorded todo. */
  deleteTodo(id: string): void {
    const existing = this.getTodo(id);
    if (!existing) return;
    this.db.prepare(`DELETE FROM todos WHERE id = ?`).run(id);
    this.touchTask(existing.taskId);
  }

  listTodos(taskId: string, filter?: { status?: TodoStatus }): Todo[] {
    const rows = filter?.status
      ? (this.db
          .prepare(
            `SELECT * FROM todos WHERE task_id = ? AND status = ? ORDER BY created_at DESC`,
          )
          .all(taskId, filter.status) as TodoRow[])
      : (this.db
          .prepare(`SELECT * FROM todos WHERE task_id = ? ORDER BY created_at DESC`)
          .all(taskId) as TodoRow[]);
    return rows.map(rowToTodo);
  }

  /** Todos never pushed, or pushed but changed locally since (`updated_at > synced_at`) — mirrors `listTasksNeedingPush`, since todos (unlike decisions/errors/commands/open_questions) track `updated_at`. */
  listTodosNeedingPush(taskId?: string): Todo[] {
    const sql = `SELECT * FROM todos WHERE (remote_id IS NULL OR synced_at IS NULL OR updated_at > synced_at)${
      taskId ? ' AND task_id = ?' : ''
    } ORDER BY created_at ASC`;
    const rows = (taskId ? this.db.prepare(sql).all(taskId) : this.db.prepare(sql).all()) as TodoRow[];
    return rows.map(rowToTodo);
  }

  setTodoRemoteSync(id: string, remoteId: string, syncedAt: string): void {
    this.db.prepare(`UPDATE todos SET remote_id = ?, synced_at = ? WHERE id = ?`).run(remoteId, syncedAt, id);
  }

  getTodoByRemoteId(remoteId: string): Todo | undefined {
    const row = this.db.prepare(`SELECT * FROM todos WHERE remote_id = ?`).get(remoteId) as TodoRow | undefined;
    return row ? rowToTodo(row) : undefined;
  }

  /** Applies a remote update to an already-linked local todo (e.g. a teammate marked it done). Does not touch the parent task's `updatedAt` — inbound data, not a local mutation. */
  applyPulledTodo(id: string, updates: { text: string; status: TodoStatus; updatedAt: string; syncedAt: string }): void {
    this.db
      .prepare(`UPDATE todos SET text = ?, status = ?, updated_at = ?, synced_at = ? WHERE id = ?`)
      .run(updates.text, updates.status, updates.updatedAt, updates.syncedAt, id);
  }

  /** Inserts a todo pulled from the sync server that doesn't exist locally yet, preserving the server's timestamps and marking it synced immediately. */
  insertPulledTodo(input: { taskId: string; remoteId: string; text: string; status: TodoStatus; createdAt: string; updatedAt: string; syncedAt: string }): Todo {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO todos (id, task_id, text, status, created_at, updated_at, remote_id, synced_at)
         VALUES (@id, @taskId, @text, @status, @createdAt, @updatedAt, @remoteId, @syncedAt)`,
      )
      .run({ id, taskId: input.taskId, text: input.text, status: input.status, createdAt: input.createdAt, updatedAt: input.updatedAt, remoteId: input.remoteId, syncedAt: input.syncedAt });
    return this.getTodo(id)!;
  }

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  recordCommand(input: NewCommand): Command {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO commands (id, task_id, cmd_redacted, exit_code, summary, created_at, updated_at)
         VALUES (@id, @taskId, @cmdRedacted, @exitCode, @summary, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        cmdRedacted: input.cmdRedacted,
        exitCode: input.exitCode ?? null,
        summary: input.summary ?? null,
        createdAt: ts,
        updatedAt: ts,
      });
    this.touchTask(input.taskId);
    const row = this.db.prepare(`SELECT * FROM commands WHERE id = ?`).get(id) as CommandRow;
    return rowToCommand(row);
  }

  /**
   * Auto-resolves any unresolved "Command failed (exit N): <cmd>" errors on
   * `taskId` whose redacted command text exactly matches `cmdRedacted` —
   * called after a command with `exitCode === 0` is recorded, so a classic
   * TDD RED→GREEN rerun (e.g. `pytest some_test.py` failing, then passing
   * once fixed) stops permanently cluttering `status`/`resume` with a
   * "failure" that's actually already fixed. Deliberately exact-match only
   * (no fuzzy matching) to avoid ever resolving an unrelated error by
   * mistake. Returns the ids of errors it resolved, for callers that want
   * to report this back to the user/agent.
   */
  autoResolveMatchingCommandErrors(taskId: string, cmdRedacted: string): string[] {
    const suffix = `): ${cmdRedacted}`;
    const unresolved = this.listErrors(taskId, { resolved: false });
    const matches = unresolved.filter(
      (e) => e.message.startsWith('Command failed (exit ') && e.message.endsWith(suffix),
    );
    for (const m of matches) {
      this.resolveError(m.id, 'auto-resolved: this exact command succeeded on a later run');
    }
    return matches.map((m) => m.id);
  }

  listCommands(taskId: string, limit?: number): Command[] {
    const sql = `SELECT * FROM commands WHERE task_id = ? ORDER BY created_at DESC${
      limit ? ' LIMIT ?' : ''
    }`;
    const rows = (
      limit ? this.db.prepare(sql).all(taskId, limit) : this.db.prepare(sql).all(taskId)
    ) as CommandRow[];
    return rows.map(rowToCommand);
  }

  getCommand(id: string): Command | undefined {
    const row = this.db.prepare(`SELECT * FROM commands WHERE id = ?`).get(id) as CommandRow | undefined;
    return row ? rowToCommand(row) : undefined;
  }

  listCommandsNeedingPush(taskId?: string): Command[] {
    const sql = `SELECT * FROM commands WHERE (remote_id IS NULL OR synced_at IS NULL OR updated_at > synced_at)${
      taskId ? ' AND task_id = ?' : ''
    } ORDER BY created_at ASC`;
    const rows = (taskId ? this.db.prepare(sql).all(taskId) : this.db.prepare(sql).all()) as CommandRow[];
    return rows.map(rowToCommand);
  }

  setCommandRemoteSync(id: string, remoteId: string, syncedAt: string): void {
    this.db.prepare(`UPDATE commands SET remote_id = ?, synced_at = ? WHERE id = ?`).run(remoteId, syncedAt, id);
  }

  getCommandByRemoteId(remoteId: string): Command | undefined {
    const row = this.db.prepare(`SELECT * FROM commands WHERE remote_id = ?`).get(remoteId) as CommandRow | undefined;
    return row ? rowToCommand(row) : undefined;
  }

  /** Applies a remote update to an already-linked local command. Does not touch the parent task's `updatedAt` — inbound data, not a local mutation. */
  applyPulledCommand(
    id: string,
    updates: { cmdRedacted: string; exitCode: number | null; summary: string | null; updatedAt: string; syncedAt: string },
  ): void {
    this.db
      .prepare(`UPDATE commands SET cmd_redacted = ?, exit_code = ?, summary = ?, updated_at = ?, synced_at = ? WHERE id = ?`)
      .run(updates.cmdRedacted, updates.exitCode, updates.summary, updates.updatedAt, updates.syncedAt, id);
  }

  /** Inserts a command pulled from the sync server that doesn't exist locally yet. Does not touch the parent task's `updatedAt` — inbound data, not a local mutation. */
  insertPulledCommand(input: {
    taskId: string;
    remoteId: string;
    cmdRedacted: string;
    exitCode: number | null;
    summary: string | null;
    createdAt: string;
    updatedAt: string;
    syncedAt: string;
  }): Command {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO commands (id, task_id, cmd_redacted, exit_code, summary, created_at, updated_at, remote_id, synced_at)
         VALUES (@id, @taskId, @cmdRedacted, @exitCode, @summary, @createdAt, @updatedAt, @remoteId, @syncedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        cmdRedacted: input.cmdRedacted,
        exitCode: input.exitCode,
        summary: input.summary,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        remoteId: input.remoteId,
        syncedAt: input.syncedAt,
      });
    const row = this.db.prepare(`SELECT * FROM commands WHERE id = ?`).get(id) as CommandRow;
    return rowToCommand(row);
  }

  // ---------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------

  recordError(input: NewTaskError): TaskError {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO errors (id, task_id, message, resolved, resolution, created_at, updated_at)
         VALUES (@id, @taskId, @message, @resolved, @resolution, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        message: input.message,
        resolved: input.resolved ? 1 : 0,
        resolution: input.resolution ?? null,
        createdAt: ts,
        updatedAt: ts,
      });
    this.touchTask(input.taskId);
    const row = this.db.prepare(`SELECT * FROM errors WHERE id = ?`).get(id) as ErrorRow;
    return rowToError(row);
  }

  resolveError(id: string, resolution?: string): void {
    const existing = this.getError(id);
    this.db
      .prepare(`UPDATE errors SET resolved = 1, resolution = ?, updated_at = ? WHERE id = ?`)
      .run(resolution ?? null, nowIso(), id);
    if (existing) this.touchTask(existing.taskId);
  }

  /** Curation: reopen a previously-resolved error (e.g. it recurred, or was resolved by mistake). */
  unresolveError(id: string): void {
    const existing = this.getError(id);
    this.db.prepare(`UPDATE errors SET resolved = 0, resolution = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    if (existing) this.touchTask(existing.taskId);
  }

  getError(id: string): TaskError | undefined {
    const row = this.db.prepare(`SELECT * FROM errors WHERE id = ?`).get(id) as ErrorRow | undefined;
    return row ? rowToError(row) : undefined;
  }

  /** Curation: edit an error's recorded message (e.g. to fix a typo or add detail) without losing its id/history. */
  updateError(id: string, message: string): void {
    const existing = this.getError(id);
    if (!existing) return;
    this.db.prepare(`UPDATE errors SET message = ?, updated_at = ? WHERE id = ?`).run(message, nowIso(), id);
    this.touchTask(existing.taskId);
  }

  /** Curation: permanently remove a wrongly-recorded error. */
  deleteError(id: string): void {
    const existing = this.getError(id);
    if (!existing) return;
    this.db.prepare(`DELETE FROM errors WHERE id = ?`).run(id);
    this.touchTask(existing.taskId);
  }

  listErrors(taskId: string, filter?: { resolved?: boolean }): TaskError[] {
    const rows = filter?.resolved !== undefined
      ? (this.db
          .prepare(
            `SELECT * FROM errors WHERE task_id = ? AND resolved = ? ORDER BY created_at DESC`,
          )
          .all(taskId, filter.resolved ? 1 : 0) as ErrorRow[])
      : (this.db
          .prepare(`SELECT * FROM errors WHERE task_id = ? ORDER BY created_at DESC`)
          .all(taskId) as ErrorRow[]);
    return rows.map(rowToError);
  }

  listErrorsNeedingPush(taskId?: string): TaskError[] {
    const sql = `SELECT * FROM errors WHERE (remote_id IS NULL OR synced_at IS NULL OR updated_at > synced_at)${
      taskId ? ' AND task_id = ?' : ''
    } ORDER BY created_at ASC`;
    const rows = (taskId ? this.db.prepare(sql).all(taskId) : this.db.prepare(sql).all()) as ErrorRow[];
    return rows.map(rowToError);
  }

  setErrorRemoteSync(id: string, remoteId: string, syncedAt: string): void {
    this.db.prepare(`UPDATE errors SET remote_id = ?, synced_at = ? WHERE id = ?`).run(remoteId, syncedAt, id);
  }

  getErrorByRemoteId(remoteId: string): TaskError | undefined {
    const row = this.db.prepare(`SELECT * FROM errors WHERE remote_id = ?`).get(remoteId) as ErrorRow | undefined;
    return row ? rowToError(row) : undefined;
  }

  /** Applies a remote update to an already-linked local error. Does not touch the parent task's `updatedAt` — inbound data, not a local mutation. */
  applyPulledError(
    id: string,
    updates: { message: string; resolved: boolean; resolution: string | null; updatedAt: string; syncedAt: string },
  ): void {
    this.db
      .prepare(`UPDATE errors SET message = ?, resolved = ?, resolution = ?, updated_at = ?, synced_at = ? WHERE id = ?`)
      .run(updates.message, updates.resolved ? 1 : 0, updates.resolution, updates.updatedAt, updates.syncedAt, id);
  }

  /** Inserts an error pulled from the sync server that doesn't exist locally yet. Does not touch the parent task's `updatedAt` — inbound data, not a local mutation. */
  insertPulledError(input: {
    taskId: string;
    remoteId: string;
    message: string;
    resolved: boolean;
    resolution: string | null;
    createdAt: string;
    updatedAt: string;
    syncedAt: string;
  }): TaskError {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO errors (id, task_id, message, resolved, resolution, created_at, updated_at, remote_id, synced_at)
         VALUES (@id, @taskId, @message, @resolved, @resolution, @createdAt, @updatedAt, @remoteId, @syncedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        message: input.message,
        resolved: input.resolved ? 1 : 0,
        resolution: input.resolution,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        remoteId: input.remoteId,
        syncedAt: input.syncedAt,
      });
    return this.getError(id)!;
  }

  // ---------------------------------------------------------------------
  // Open questions
  // ---------------------------------------------------------------------

  recordOpenQuestion(input: NewOpenQuestion): OpenQuestion {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO open_questions (id, task_id, text, resolved, created_at, updated_at)
         VALUES (@id, @taskId, @text, @resolved, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        text: input.text,
        resolved: input.resolved ? 1 : 0,
        createdAt: ts,
        updatedAt: ts,
      });
    this.touchTask(input.taskId);
    const row = this.db
      .prepare(`SELECT * FROM open_questions WHERE id = ?`)
      .get(id) as OpenQuestionRow;
    return rowToOpenQuestion(row);
  }

  resolveOpenQuestion(id: string): void {
    const existing = this.getOpenQuestion(id);
    this.db.prepare(`UPDATE open_questions SET resolved = 1, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    if (existing) this.touchTask(existing.taskId);
  }

  /** Curation: reopen a previously-resolved open question (e.g. the answer turned out to be wrong). */
  unresolveOpenQuestion(id: string): void {
    const existing = this.getOpenQuestion(id);
    this.db.prepare(`UPDATE open_questions SET resolved = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    if (existing) this.touchTask(existing.taskId);
  }

  getOpenQuestion(id: string): OpenQuestion | undefined {
    const row = this.db.prepare(`SELECT * FROM open_questions WHERE id = ?`).get(id) as
      | OpenQuestionRow
      | undefined;
    return row ? rowToOpenQuestion(row) : undefined;
  }

  /** Curation: edit an open question's text (e.g. to clarify wording) without losing its id/history. */
  updateOpenQuestion(id: string, text: string): void {
    const existing = this.getOpenQuestion(id);
    if (!existing) return;
    this.db.prepare(`UPDATE open_questions SET text = ?, updated_at = ? WHERE id = ?`).run(text, nowIso(), id);
    this.touchTask(existing.taskId);
  }

  /** Curation: permanently remove a wrongly-recorded open question. */
  deleteOpenQuestion(id: string): void {
    const existing = this.getOpenQuestion(id);
    if (!existing) return;
    this.db.prepare(`DELETE FROM open_questions WHERE id = ?`).run(id);
    this.touchTask(existing.taskId);
  }

  listOpenQuestions(taskId: string, filter?: { resolved?: boolean }): OpenQuestion[] {
    const rows = filter?.resolved !== undefined
      ? (this.db
          .prepare(
            `SELECT * FROM open_questions WHERE task_id = ? AND resolved = ? ORDER BY created_at DESC`,
          )
          .all(taskId, filter.resolved ? 1 : 0) as OpenQuestionRow[])
      : (this.db
          .prepare(`SELECT * FROM open_questions WHERE task_id = ? ORDER BY created_at DESC`)
          .all(taskId) as OpenQuestionRow[]);
    return rows.map(rowToOpenQuestion);
  }

  listOpenQuestionsNeedingPush(taskId?: string): OpenQuestion[] {
    const sql = `SELECT * FROM open_questions WHERE (remote_id IS NULL OR synced_at IS NULL OR updated_at > synced_at)${
      taskId ? ' AND task_id = ?' : ''
    } ORDER BY created_at ASC`;
    const rows = (taskId ? this.db.prepare(sql).all(taskId) : this.db.prepare(sql).all()) as OpenQuestionRow[];
    return rows.map(rowToOpenQuestion);
  }

  setOpenQuestionRemoteSync(id: string, remoteId: string, syncedAt: string): void {
    this.db.prepare(`UPDATE open_questions SET remote_id = ?, synced_at = ? WHERE id = ?`).run(remoteId, syncedAt, id);
  }

  getOpenQuestionByRemoteId(remoteId: string): OpenQuestion | undefined {
    const row = this.db.prepare(`SELECT * FROM open_questions WHERE remote_id = ?`).get(remoteId) as OpenQuestionRow | undefined;
    return row ? rowToOpenQuestion(row) : undefined;
  }

  /** Applies a remote update to an already-linked local open question. Does not touch the parent task's `updatedAt` — inbound data, not a local mutation. */
  applyPulledOpenQuestion(
    id: string,
    updates: { text: string; resolved: boolean; updatedAt: string; syncedAt: string },
  ): void {
    this.db
      .prepare(`UPDATE open_questions SET text = ?, resolved = ?, updated_at = ?, synced_at = ? WHERE id = ?`)
      .run(updates.text, updates.resolved ? 1 : 0, updates.updatedAt, updates.syncedAt, id);
  }

  /** Inserts an open question pulled from the sync server that doesn't exist locally yet. Does not touch the parent task's `updatedAt` — inbound data, not a local mutation. */
  insertPulledOpenQuestion(input: {
    taskId: string;
    remoteId: string;
    text: string;
    resolved: boolean;
    createdAt: string;
    updatedAt: string;
    syncedAt: string;
  }): OpenQuestion {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO open_questions (id, task_id, text, resolved, created_at, updated_at, remote_id, synced_at)
         VALUES (@id, @taskId, @text, @resolved, @createdAt, @updatedAt, @remoteId, @syncedAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        text: input.text,
        resolved: input.resolved ? 1 : 0,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        remoteId: input.remoteId,
        syncedAt: input.syncedAt,
      });
    return this.getOpenQuestion(id)!;
  }

  // ---------------------------------------------------------------------
  // Workspace-level state (stored in this same DB so it's part of the one
  // source of truth, instead of a separate flat file next to state.db).
  // ---------------------------------------------------------------------

  /** Reads the id of the "current" task for this workspace, if one is set. */
  getCurrentTaskId(): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM schema_meta WHERE key = 'current_task_id'`)
      .get() as { value: string } | undefined;
    return row?.value;
  }

  /** Marks `taskId` as the current task for this workspace (used when no explicit task id is given). */
  setCurrentTaskId(taskId: string): void {
    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES ('current_task_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(taskId);
  }
}
