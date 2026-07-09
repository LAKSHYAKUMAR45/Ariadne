import type { Database as DatabaseType } from 'better-sqlite3';
import { ulid } from 'ulid';
import { openDatabase } from './db.js';
import type {
  Task,
  NewTask,
  TaskStatus,
  Checkpoint,
  NewCheckpoint,
  TaskFile,
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
  };
}

interface CheckpointRow {
  id: string;
  task_id: string;
  parent_checkpoint_id: string | null;
  level: Checkpoint['level'];
  summary: string;
  created_at: string;
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    parentCheckpointId: row.parent_checkpoint_id,
    level: row.level,
    summary: row.summary,
    createdAt: row.created_at,
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
  };
}

interface CommandRow {
  id: string;
  task_id: string;
  cmd_redacted: string;
  exit_code: number | null;
  summary: string | null;
  created_at: string;
}

function rowToCommand(row: CommandRow): Command {
  return {
    id: row.id,
    taskId: row.task_id,
    cmdRedacted: row.cmd_redacted,
    exitCode: row.exit_code,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

interface ErrorRow {
  id: string;
  task_id: string;
  message: string;
  resolved: number;
  resolution: string | null;
  created_at: string;
}

function rowToError(row: ErrorRow): TaskError {
  return {
    id: row.id,
    taskId: row.task_id,
    message: row.message,
    resolved: Boolean(row.resolved),
    resolution: row.resolution,
    createdAt: row.created_at,
  };
}

interface OpenQuestionRow {
  id: string;
  task_id: string;
  text: string;
  resolved: number;
  created_at: string;
}

function rowToOpenQuestion(row: OpenQuestionRow): OpenQuestion {
  return {
    id: row.id,
    taskId: row.task_id,
    text: row.text,
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
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

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** Closes the underlying database connection. */
  close(): void {
    this.db.close();
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
    return this.getTask(id)!;
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
  }

  touchTask(id: string): void {
    this.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(nowIso(), id);
  }

  addTaskDependency(taskId: string, dependsOn: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)`)
      .run(taskId, dependsOn);
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
  // Commits
  // ---------------------------------------------------------------------

  recordCommit(input: NewCommit): Commit {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO commits (sha, task_id, checkpoint_id, message, created_at)
         VALUES (@sha, @taskId, @checkpointId, @message, @createdAt)`,
      )
      .run({
        sha: input.sha,
        taskId: input.taskId,
        checkpointId: input.checkpointId ?? null,
        message: input.message ?? null,
        createdAt: ts,
      });
    this.touchTask(input.taskId);
    const row = this.db.prepare(`SELECT * FROM commits WHERE sha = ?`).get(input.sha) as CommitRow;
    return rowToCommit(row);
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
        `INSERT INTO decisions (id, task_id, checkpoint_id, text, rationale, supersedes_id, created_at)
         VALUES (@id, @taskId, @checkpointId, @text, @rationale, @supersedesId, @createdAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        checkpointId: input.checkpointId ?? null,
        text: input.text,
        rationale: input.rationale ?? null,
        supersedesId: input.supersedesId ?? null,
        createdAt: ts,
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
    this.db
      .prepare(`UPDATE todos SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowIso(), id);
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

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  recordCommand(input: NewCommand): Command {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO commands (id, task_id, cmd_redacted, exit_code, summary, created_at)
         VALUES (@id, @taskId, @cmdRedacted, @exitCode, @summary, @createdAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        cmdRedacted: input.cmdRedacted,
        exitCode: input.exitCode ?? null,
        summary: input.summary ?? null,
        createdAt: ts,
      });
    this.touchTask(input.taskId);
    const row = this.db.prepare(`SELECT * FROM commands WHERE id = ?`).get(id) as CommandRow;
    return rowToCommand(row);
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

  // ---------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------

  recordError(input: NewTaskError): TaskError {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO errors (id, task_id, message, resolved, resolution, created_at)
         VALUES (@id, @taskId, @message, @resolved, @resolution, @createdAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        message: input.message,
        resolved: input.resolved ? 1 : 0,
        resolution: input.resolution ?? null,
        createdAt: ts,
      });
    this.touchTask(input.taskId);
    const row = this.db.prepare(`SELECT * FROM errors WHERE id = ?`).get(id) as ErrorRow;
    return rowToError(row);
  }

  resolveError(id: string, resolution?: string): void {
    this.db
      .prepare(`UPDATE errors SET resolved = 1, resolution = ? WHERE id = ?`)
      .run(resolution ?? null, id);
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

  // ---------------------------------------------------------------------
  // Open questions
  // ---------------------------------------------------------------------

  recordOpenQuestion(input: NewOpenQuestion): OpenQuestion {
    const id = ulid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO open_questions (id, task_id, text, resolved, created_at)
         VALUES (@id, @taskId, @text, @resolved, @createdAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        text: input.text,
        resolved: input.resolved ? 1 : 0,
        createdAt: ts,
      });
    this.touchTask(input.taskId);
    const row = this.db
      .prepare(`SELECT * FROM open_questions WHERE id = ?`)
      .get(id) as OpenQuestionRow;
    return rowToOpenQuestion(row);
  }

  resolveOpenQuestion(id: string): void {
    this.db.prepare(`UPDATE open_questions SET resolved = 1 WHERE id = ?`).run(id);
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
}
