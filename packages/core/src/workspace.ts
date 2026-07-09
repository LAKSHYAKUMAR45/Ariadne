import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskStore } from './TaskStore.js';

const STATE_DIR = '.ariadne';
const STATE_FILE = 'state.db';
// Legacy location from before "current task" moved into SQLite (schema_meta
// table) — kept only so any pre-existing workspaces get migrated in place.
const LEGACY_CURRENT_TASK_FILE = 'current-task';

/**
 * Finds the workspace root: the nearest ancestor directory (starting at
 * `startDir`) containing a `.git` folder, or an existing `.ariadne` folder.
 * Falls back to `startDir` itself. Shared by every surface (CLI, VS Code
 * extension, MCP server) so they all resolve the same workspace the same way.
 */
export function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, STATE_DIR))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return startDir; // reached filesystem root, give up and use start dir
    }
    dir = parent;
  }
}

export function stateDbPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, STATE_DIR, STATE_FILE);
}

/** Opens (creating on first use) the TaskStore for the given workspace root. */
export function openWorkspaceStore(workspaceRoot: string): TaskStore {
  return new TaskStore(stateDbPath(workspaceRoot));
}

/**
 * One-time migration: if an older Ariadne version left a `.ariadne/current-task`
 * flat file behind and the DB doesn't have a current task recorded yet, adopt
 * its value into the DB and delete the file so state.db becomes the single
 * source of truth going forward.
 */
function migrateLegacyCurrentTaskFile(store: TaskStore, workspaceRoot: string): void {
  const legacyFile = path.join(workspaceRoot, STATE_DIR, LEGACY_CURRENT_TASK_FILE);
  if (!fs.existsSync(legacyFile)) return;
  try {
    if (store.getCurrentTaskId() === undefined) {
      const id = fs.readFileSync(legacyFile, 'utf8').trim();
      if (id.length > 0) store.setCurrentTaskId(id);
    }
    fs.unlinkSync(legacyFile);
  } catch {
    // Best-effort migration only; never block on it.
  }
}

/**
 * Reads the id of the "current" task for this workspace, if one is set.
 * Stored in `state.db` (schema_meta table) so it's part of the same
 * source-of-truth database every surface reads/writes, rather than a
 * separate file that could drift or race independently of it.
 */
export function readCurrentTaskId(workspaceRoot: string): string | undefined {
  const store = openWorkspaceStore(workspaceRoot);
  try {
    migrateLegacyCurrentTaskFile(store, workspaceRoot);
    return store.getCurrentTaskId();
  } finally {
    store.close();
  }
}

/** Marks `taskId` as the current task for this workspace (used when no explicit task id is given). */
export function setCurrentTaskId(taskId: string, workspaceRoot: string): void {
  const store = openWorkspaceStore(workspaceRoot);
  try {
    store.setCurrentTaskId(taskId);
  } finally {
    store.close();
  }
}

