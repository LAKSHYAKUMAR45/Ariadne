import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Task, TaskStatus } from './types.js';

/**
 * A lightweight cross-workspace index: "which task ids live in which
 * workspace, with enough metadata to list/search without opening every
 * workspace's real `state.db`." This is deliberately NOT the source of
 * truth — each workspace's own `.ariadne/state.db` still owns its tasks'
 * full history (checkpoints, todos, decisions, etc). The registry only
 * exists so `ariadne task list --all-workspaces` / `search --all-workspaces`
 * and friends can discover tasks across workspaces without a filesystem
 * scan, and so an explicit task id can be resolved to its owning workspace
 * from anywhere (see `CrossWorkspace.ts`).
 */

const REGISTRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  root TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks_index (
  task_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_index_workspace ON tasks_index(workspace_root);
CREATE INDEX IF NOT EXISTS idx_tasks_index_updated_at ON tasks_index(updated_at);

-- Cross-repo task linking (docs/04-ROADMAP.md §3): a "link group" is a
-- logical task that spans multiple repos/workspaces, expressed as a set of
-- member (task_id, workspace_root) pairs. See CrossRepoLinks.ts. Lives in
-- the same registry db as tasks_index since that's the only db visible
-- across workspaces; per-workspace state.db files are unaffected and
-- unaware of link groups.
CREATE TABLE IF NOT EXISTS task_link_groups (
  id TEXT PRIMARY KEY,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_links (
  group_id TEXT NOT NULL REFERENCES task_link_groups(id),
  task_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (group_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_links_task_id ON task_links(task_id);
`;

export interface TaskIndexEntry {
  taskId: string;
  workspaceRoot: string;
  title: string;
  goal: string | null;
  status: TaskStatus;
  updatedAt: string;
}

interface TaskIndexRow {
  task_id: string;
  workspace_root: string;
  title: string;
  goal: string | null;
  status: TaskStatus;
  updated_at: string;
}

function rowToEntry(row: TaskIndexRow): TaskIndexEntry {
  return {
    taskId: row.task_id,
    workspaceRoot: row.workspace_root,
    title: row.title,
    goal: row.goal,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

/**
 * Resolves the registry db's location: `$ARIADNE_REGISTRY_PATH` if set
 * (mainly for tests), otherwise `~/.ariadne/registry.db`. Deliberately a
 * single per-machine file (not per-workspace), since its entire purpose is
 * cross-workspace discovery.
 */
export function getRegistryPath(): string {
  return process.env.ARIADNE_REGISTRY_PATH ?? path.join(os.homedir(), '.ariadne', 'registry.db');
}

let cachedRegistryDb: DatabaseType | undefined;
let cachedRegistryPath: string | undefined;

/**
 * Opens (creating on first use) the global registry database. Cached as a
 * module-level singleton per resolved path so frequent callers (every
 * `TaskStore` mutation — see `TaskStore.ts`) don't reopen a file handle
 * each time. Tests that need isolation should set `ARIADNE_REGISTRY_PATH`
 * to a fresh temp path and call `closeRegistry()` in `afterEach`.
 */
export function openRegistry(registryPath: string = getRegistryPath()): DatabaseType {
  if (cachedRegistryDb && cachedRegistryPath === registryPath) {
    return cachedRegistryDb;
  }
  if (cachedRegistryDb && cachedRegistryPath !== registryPath) {
    cachedRegistryDb.close();
  }
  if (registryPath !== ':memory:') {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  }
  const db = new Database(registryPath);
  if (registryPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.exec(REGISTRY_SCHEMA_SQL);
  cachedRegistryDb = db;
  cachedRegistryPath = registryPath;
  return db;
}

/** Closes and uncaches the current registry connection, if any (mainly for tests). */
export function closeRegistry(): void {
  cachedRegistryDb?.close();
  cachedRegistryDb = undefined;
  cachedRegistryPath = undefined;
}

/** Records/refreshes a workspace's "last seen" timestamp. */
export function touchWorkspace(registryDb: DatabaseType, workspaceRoot: string): void {
  registryDb
    .prepare(
      `INSERT INTO workspaces (root, last_seen_at) VALUES (@root, @now)
       ON CONFLICT(root) DO UPDATE SET last_seen_at = @now`,
    )
    .run({ root: workspaceRoot, now: new Date().toISOString() });
}

/** Upserts a single task's index entry — called by `TaskStore` after any mutation that changes a task's title/goal/status/updatedAt. */
export function upsertTaskIndex(registryDb: DatabaseType, workspaceRoot: string, task: Task): void {
  touchWorkspace(registryDb, workspaceRoot);
  registryDb
    .prepare(
      `INSERT INTO tasks_index (task_id, workspace_root, title, goal, status, updated_at)
       VALUES (@taskId, @workspaceRoot, @title, @goal, @status, @updatedAt)
       ON CONFLICT(task_id) DO UPDATE SET
         workspace_root = @workspaceRoot, title = @title, goal = @goal,
         status = @status, updated_at = @updatedAt`,
    )
    .run({
      taskId: task.id,
      workspaceRoot,
      title: task.title,
      goal: task.goal,
      status: task.status,
      updatedAt: task.updatedAt,
    });
}

/**
 * Bulk-upserts every given task at once (one transaction). Used to backfill
 * a workspace's full task list into the registry whenever its store is
 * opened (see `openWorkspaceStore` in `workspace.ts`), so tasks created
 * before the registry existed — or by an older Ariadne version — show up
 * without needing to be individually touched first.
 */
export function syncWorkspaceTasks(registryDb: DatabaseType, workspaceRoot: string, tasks: Task[]): void {
  touchWorkspace(registryDb, workspaceRoot);
  const upsert = registryDb.prepare(
    `INSERT INTO tasks_index (task_id, workspace_root, title, goal, status, updated_at)
     VALUES (@taskId, @workspaceRoot, @title, @goal, @status, @updatedAt)
     ON CONFLICT(task_id) DO UPDATE SET
       workspace_root = @workspaceRoot, title = @title, goal = @goal,
       status = @status, updated_at = @updatedAt`,
  );
  const runAll = registryDb.transaction((items: Task[]) => {
    for (const task of items) {
      upsert.run({
        taskId: task.id,
        workspaceRoot,
        title: task.title,
        goal: task.goal,
        status: task.status,
        updatedAt: task.updatedAt,
      });
    }
  });
  runAll(tasks);
}

/** Lists every known workspace root, most recently seen first. */
export function listWorkspaces(registryDb: DatabaseType): Array<{ root: string; lastSeenAt: string }> {
  const rows = registryDb
    .prepare(`SELECT root, last_seen_at FROM workspaces ORDER BY last_seen_at DESC`)
    .all() as Array<{ root: string; last_seen_at: string }>;
  return rows.map((r) => ({ root: r.root, lastSeenAt: r.last_seen_at }));
}

/** Lists every known task across all workspaces (registry-only, no per-workspace db opens), most recently updated first. */
export function listAllTasks(
  registryDb: DatabaseType,
  filter?: { status?: TaskStatus },
): TaskIndexEntry[] {
  const rows = filter?.status
    ? (registryDb
        .prepare(`SELECT * FROM tasks_index WHERE status = ? ORDER BY updated_at DESC`)
        .all(filter.status) as TaskIndexRow[])
    : (registryDb.prepare(`SELECT * FROM tasks_index ORDER BY updated_at DESC`).all() as TaskIndexRow[]);
  return rows.map(rowToEntry);
}

/** Looks up which workspace root owns a given task id, if the registry knows about it. */
export function findTaskWorkspace(registryDb: DatabaseType, taskId: string): string | undefined {
  const row = registryDb.prepare(`SELECT workspace_root FROM tasks_index WHERE task_id = ?`).get(taskId) as
    | { workspace_root: string }
    | undefined;
  return row?.workspace_root;
}

/**
 * Removes a workspace root (and every task indexed under it) from the
 * registry outright — an explicit "forget this workspace" operation, e.g.
 * after intentionally deleting or relocating a workspace's directory. This
 * only touches the registry index; it never touches the workspace's own
 * `.ariadne/state.db` (which may not even exist any more).
 */
export function forgetWorkspace(registryDb: DatabaseType, workspaceRoot: string): void {
  const forget = registryDb.transaction((root: string) => {
    registryDb.prepare(`DELETE FROM tasks_index WHERE workspace_root = ?`).run(root);
    registryDb.prepare(`DELETE FROM workspaces WHERE root = ?`).run(root);
  });
  forget(workspaceRoot);
}

/**
 * Removes every registry entry (workspace + its indexed tasks) whose root
 * no longer exists on disk — the registry's prune/gc story for workspaces
 * that were deleted or moved without ever calling `forgetWorkspace`
 * explicitly. Safe to call opportunistically (e.g. before `task list
 * --all-workspaces` / `search --all-workspaces`), since a missing directory
 * can only mean the workspace is genuinely gone (or on unmounted storage —
 * in which case this errs on the side of pruning it; it'll simply get
 * re-added the next time that workspace's store is opened again). Returns
 * the list of roots that were pruned, for reporting to the user.
 */
export function pruneMissingWorkspaces(registryDb: DatabaseType): string[] {
  const roots = listWorkspaces(registryDb).map((w) => w.root);
  const missing = roots.filter((root) => !fs.existsSync(root));
  for (const root of missing) forgetWorkspace(registryDb, root);
  return missing;
}
