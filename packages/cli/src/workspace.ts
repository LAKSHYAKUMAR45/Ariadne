import { findWorkspaceRoot as coreFindWorkspaceRoot, stateDbPath as coreStateDbPath, openWorkspaceStore as coreOpenWorkspaceStore } from '@ariadne/core';
import type { TaskStore } from '@ariadne/core';

/** CLI-specific convenience wrappers that default to `process.cwd()`. */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  return coreFindWorkspaceRoot(startDir);
}

export function stateDbPath(workspaceRoot: string = findWorkspaceRoot()): string {
  return coreStateDbPath(workspaceRoot);
}

export function openWorkspaceStore(workspaceRoot: string = findWorkspaceRoot()): TaskStore {
  return coreOpenWorkspaceStore(workspaceRoot);
}
