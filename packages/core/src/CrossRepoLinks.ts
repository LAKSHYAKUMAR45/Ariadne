import type { Database as DatabaseType } from 'better-sqlite3';
import { ulid } from 'ulid';
import type { TaskIndexEntry } from './Registry.js';

/**
 * Cross-repo task linking (docs/04-ROADMAP.md §3): lets one logical unit of
 * work that spans multiple repos — e.g. a backend change in repo A plus a
 * corresponding frontend change in repo B — be modeled as a "link group" of
 * member tasks, each of which is a perfectly normal, independent task in its
 * own workspace's `.ariadne/state.db` (unaware of the group). The group
 * itself, and its membership, lives only in the shared
 * `~/.ariadne/registry.db` (the same db `Registry.ts` uses for
 * cross-workspace discovery) — group membership is metadata *about* tasks,
 * not a change to how any individual task is stored.
 *
 * This module only establishes the data model and CRUD; no CLI/MCP
 * server/VS Code extension surface calls into it yet (see
 * docs/04-ROADMAP.md §8's next steps) — that's a deliberate follow-up, not
 * an oversight, so the shape can be validated against `Registry.ts`'s
 * existing `tasks_index` before more UI is built on top of it.
 */

export interface TaskLinkGroup {
  id: string;
  label: string | null;
  createdAt: string;
}

export interface TaskLinkMember extends TaskIndexEntry {
  linkedAt: string;
}

interface TaskLinkGroupRow {
  id: string;
  label: string | null;
  created_at: string;
}

interface TaskLinkMemberRow {
  task_id: string;
  workspace_root: string;
  title: string;
  goal: string | null;
  status: TaskIndexEntry['status'];
  updated_at: string;
  linked_at: string;
}

function rowToGroup(row: TaskLinkGroupRow): TaskLinkGroup {
  return { id: row.id, label: row.label, createdAt: row.created_at };
}

function rowToMember(row: TaskLinkMemberRow): TaskLinkMember {
  return {
    taskId: row.task_id,
    workspaceRoot: row.workspace_root,
    title: row.title,
    goal: row.goal,
    status: row.status,
    updatedAt: row.updated_at,
    linkedAt: row.linked_at,
  };
}

/** Creates a new (initially empty) link group — the "logical task" that member tasks from different repos will be added to. */
export function createTaskLinkGroup(registryDb: DatabaseType, label?: string | null): TaskLinkGroup {
  const group: TaskLinkGroup = { id: ulid(), label: label ?? null, createdAt: new Date().toISOString() };
  registryDb
    .prepare(`INSERT INTO task_link_groups (id, label, created_at) VALUES (@id, @label, @createdAt)`)
    .run(group);
  return group;
}

export function getTaskLinkGroup(registryDb: DatabaseType, groupId: string): TaskLinkGroup | undefined {
  const row = registryDb.prepare(`SELECT * FROM task_link_groups WHERE id = ?`).get(groupId) as
    | TaskLinkGroupRow
    | undefined;
  return row ? rowToGroup(row) : undefined;
}

/** Lists every known link group, most recently created first. */
export function listTaskLinkGroups(registryDb: DatabaseType): TaskLinkGroup[] {
  const rows = registryDb
    .prepare(`SELECT * FROM task_link_groups ORDER BY created_at DESC`)
    .all() as TaskLinkGroupRow[];
  return rows.map(rowToGroup);
}

/**
 * Adds a task (identified by id) to a link group. The task must already be
 * known to the registry's `tasks_index` (i.e. its workspace has been opened
 * at least once — see `Registry.ts`'s `upsertTaskIndex`/`syncWorkspaceTasks`)
 * so its workspace root can be recorded without the caller having to supply
 * it separately. Idempotent: linking an already-linked task to the same
 * group is a no-op rather than an error.
 */
export function linkTaskToGroup(registryDb: DatabaseType, groupId: string, taskId: string): void {
  if (!getTaskLinkGroup(registryDb, groupId)) {
    throw new Error(`No task link group found with id "${groupId}".`);
  }
  const indexed = registryDb.prepare(`SELECT workspace_root FROM tasks_index WHERE task_id = ?`).get(taskId) as
    | { workspace_root: string }
    | undefined;
  if (!indexed) {
    throw new Error(
      `Task "${taskId}" isn't known to the registry yet — open its workspace at least once before linking it.`,
    );
  }
  registryDb
    .prepare(
      `INSERT INTO task_links (group_id, task_id, workspace_root, linked_at)
       VALUES (@groupId, @taskId, @workspaceRoot, @linkedAt)
       ON CONFLICT(group_id, task_id) DO NOTHING`,
    )
    .run({ groupId, taskId, workspaceRoot: indexed.workspace_root, linkedAt: new Date().toISOString() });
}

/** Removes a single task from a link group (the group itself, and its other members, are left intact). */
export function unlinkTaskFromGroup(registryDb: DatabaseType, groupId: string, taskId: string): void {
  registryDb.prepare(`DELETE FROM task_links WHERE group_id = ? AND task_id = ?`).run(groupId, taskId);
}

/** Lists every member task of a link group — each with its full indexed task info (title/goal/status/workspace) plus when it was linked. */
export function listGroupMembers(registryDb: DatabaseType, groupId: string): TaskLinkMember[] {
  const rows = registryDb
    .prepare(
      `SELECT ti.task_id, ti.workspace_root, ti.title, ti.goal, ti.status, ti.updated_at, tl.linked_at
       FROM task_links tl
       JOIN tasks_index ti ON ti.task_id = tl.task_id
       WHERE tl.group_id = ?
       ORDER BY tl.linked_at ASC`,
    )
    .all(groupId) as TaskLinkMemberRow[];
  return rows.map(rowToMember);
}

/** Reverse lookup: every link group a given task belongs to (a task may belong to more than one group). */
export function findGroupsForTask(registryDb: DatabaseType, taskId: string): TaskLinkGroup[] {
  const rows = registryDb
    .prepare(
      `SELECT g.* FROM task_link_groups g
       JOIN task_links tl ON tl.group_id = g.id
       WHERE tl.task_id = ?
       ORDER BY g.created_at DESC`,
    )
    .all(taskId) as TaskLinkGroupRow[];
  return rows.map(rowToGroup);
}

/** Deletes a link group and all of its membership rows (member tasks themselves are untouched). */
export function deleteTaskLinkGroup(registryDb: DatabaseType, groupId: string): void {
  const run = registryDb.transaction((id: string) => {
    registryDb.prepare(`DELETE FROM task_links WHERE group_id = ?`).run(id);
    registryDb.prepare(`DELETE FROM task_link_groups WHERE id = ?`).run(id);
  });
  run(groupId);
}
