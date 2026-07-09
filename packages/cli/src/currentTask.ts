import * as fs from 'node:fs';
import * as path from 'node:path';
import { findWorkspaceRoot } from './workspace.js';

const CURRENT_TASK_FILE = path.join('.ariadne', 'current-task');

/** Reads the id of the "current" task for this workspace, if one is set. */
export function readCurrentTaskId(workspaceRoot: string = findWorkspaceRoot()): string | undefined {
  const file = path.join(workspaceRoot, CURRENT_TASK_FILE);
  if (!fs.existsSync(file)) return undefined;
  const id = fs.readFileSync(file, 'utf8').trim();
  return id.length > 0 ? id : undefined;
}

/** Marks `taskId` as the current task for this workspace (used when no --task flag is passed). */
export function setCurrentTaskId(taskId: string, workspaceRoot: string = findWorkspaceRoot()): void {
  const file = path.join(workspaceRoot, CURRENT_TASK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, taskId, 'utf8');
}
