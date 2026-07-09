import { readCurrentTaskId as coreRead, setCurrentTaskId as coreSet } from '@ariadne/core';
import { findWorkspaceRoot } from './workspace.js';

/** CLI-specific convenience wrappers that default to the resolved workspace root. */
export function readCurrentTaskId(workspaceRoot: string = findWorkspaceRoot()): string | undefined {
  return coreRead(workspaceRoot);
}

export function setCurrentTaskId(taskId: string, workspaceRoot: string = findWorkspaceRoot()): void {
  coreSet(taskId, workspaceRoot);
}
