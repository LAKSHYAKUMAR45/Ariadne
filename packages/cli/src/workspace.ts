import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskStore } from '@ariadne/core';

const STATE_DIR = '.ariadne';
const STATE_FILE = 'state.db';

/**
 * Finds the workspace root: the nearest ancestor directory (starting at
 * `startDir`) containing a `.git` folder, or `.ariadne` folder if one
 * already exists higher up. Falls back to `startDir` itself.
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
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

export function stateDbPath(workspaceRoot: string = findWorkspaceRoot()): string {
  return path.join(workspaceRoot, STATE_DIR, STATE_FILE);
}

/** Opens (creating on first use) the TaskStore for the current workspace. */
export function openWorkspaceStore(workspaceRoot?: string): TaskStore {
  return new TaskStore(stateDbPath(workspaceRoot));
}
