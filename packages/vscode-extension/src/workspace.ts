import * as vscode from 'vscode';
import { findWorkspaceRoot, readCurrentTaskId, setCurrentTaskId } from '@ariadne/core';
import type { TaskStore } from '@ariadne/core';
import { getOrOpenStore } from './storeCache.js';

/**
 * Resolves the workspace root Ariadne should use: the first VS Code
 * workspace folder, walked up to the nearest `.git`/`.ariadne` ancestor
 * (same resolution rule the CLI uses, so both surfaces agree).
 */
export function resolveWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return findWorkspaceRoot(folder.uri.fsPath);
}

/**
 * Returns the cached TaskStore for the current workspace (opening it on
 * first use). Callers should NOT close the returned store — its lifetime is
 * managed by storeCache.ts and torn down in deactivate().
 */
export function openStoreForCurrentWorkspace(): TaskStore | undefined {
  const root = resolveWorkspaceRoot();
  if (!root) return undefined;
  return getOrOpenStore(root);
}

export function getCurrentTaskId(): string | undefined {
  const root = resolveWorkspaceRoot();
  if (!root) return undefined;
  return readCurrentTaskId(root);
}

export function setCurrentTask(taskId: string): void {
  const root = resolveWorkspaceRoot();
  if (!root) return;
  setCurrentTaskId(taskId, root);
}
