import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskStore } from './TaskStore.js';

const STATE_DIR = '.ariadne';
const STATE_FILE = 'state.db';
const CURRENT_TASK_FILE = 'current-task';

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

/** Reads the id of the "current" task for this workspace, if one is set. */
export function readCurrentTaskId(workspaceRoot: string): string | undefined {
  const file = path.join(workspaceRoot, STATE_DIR, CURRENT_TASK_FILE);
  if (!fs.existsSync(file)) return undefined;
  const id = fs.readFileSync(file, 'utf8').trim();
  return id.length > 0 ? id : undefined;
}

/** Marks `taskId` as the current task for this workspace (used when no explicit task id is given). */
export function setCurrentTaskId(taskId: string, workspaceRoot: string): void {
  const file = path.join(workspaceRoot, STATE_DIR, CURRENT_TASK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, taskId, 'utf8');
}
