import {
  findWorkspaceRoot as coreFindWorkspaceRoot,
  openWorkspaceStore as coreOpenWorkspaceStore,
  readCurrentTaskId as coreReadCurrentTaskId,
  setCurrentTaskId as coreSetCurrentTaskId,
} from '@ariadne/core';
import type { TaskStore } from '@ariadne/core';

/**
 * MCP-server-specific convenience wrappers that default to `process.cwd()`,
 * mirroring the equivalents in `packages/cli/src/workspace.ts` and
 * `packages/cli/src/currentTask.ts` — every surface resolves the workspace
 * root and "current task" file the same way via `@ariadne/core`.
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  return coreFindWorkspaceRoot(startDir);
}

export function openWorkspaceStore(workspaceRoot: string = findWorkspaceRoot()): TaskStore {
  return coreOpenWorkspaceStore(workspaceRoot);
}

export function readCurrentTaskId(workspaceRoot: string = findWorkspaceRoot()): string | undefined {
  return coreReadCurrentTaskId(workspaceRoot);
}

export function setCurrentTaskId(taskId: string, workspaceRoot: string = findWorkspaceRoot()): void {
  coreSetCurrentTaskId(taskId, workspaceRoot);
}
