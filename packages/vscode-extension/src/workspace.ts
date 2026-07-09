import * as vscode from 'vscode';
import { findWorkspaceRoot } from '@ariadne/core';
import type { TaskStore } from '@ariadne/core';
import { getOrOpenStore } from './storeCache.js';

const SELECTED_FOLDER_KEY = 'ariadne.selectedFolderPath';

let extensionContext: vscode.ExtensionContext | undefined;
let warnedAboutAmbiguity = false;

/** Called once from activate() so this module can persist the user's chosen folder across reloads. */
export function initWorkspaceResolution(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

/**
 * Resolves the VS Code workspace folder Ariadne should use when more than
 * one is open, without prompting (resolveWorkspaceRoot must stay
 * synchronous — most call sites aren't async-friendly):
 *   1. A folder the user explicitly picked via "Ariadne: Select Workspace
 *      Folder" (persisted in workspaceState), if it's still open.
 *   2. The folder containing the active editor's document, if any.
 *   3. The first folder, with a one-time warning nudging the user to pick
 *      explicitly if this stays ambiguous.
 */
function pickFolderForMultiRoot(
  folders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder {
  const selectedPath = extensionContext?.workspaceState.get<string>(SELECTED_FOLDER_KEY);
  if (selectedPath) {
    const match = folders.find((f) => f.uri.fsPath === selectedPath);
    if (match) return match;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const match = vscode.workspace.getWorkspaceFolder(activeUri);
    if (match) return match;
  }

  if (!warnedAboutAmbiguity) {
    warnedAboutAmbiguity = true;
    void vscode.window.showWarningMessage(
      `Ariadne: multiple workspace folders are open; defaulting to "${folders[0].name}". Run "Ariadne: Select Workspace Folder" to choose a different one.`,
    );
  }
  return folders[0];
}

/**
 * Resolves the workspace root Ariadne should use, walked up to the nearest
 * `.git`/`.ariadne` ancestor (same resolution rule the CLI uses, so both
 * surfaces agree). Handles multi-root workspaces via pickFolderForMultiRoot.
 */
export function resolveWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  const folder = folders.length === 1 ? folders[0] : pickFolderForMultiRoot(folders);
  return findWorkspaceRoot(folder.uri.fsPath);
}

/** Lets the user explicitly choose which open folder Ariadne should use, persisted across reloads. */
export async function promptSelectWorkspaceFolder(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showWarningMessage('Ariadne: no folders are open in this workspace.');
    return;
  }
  if (folders.length === 1) {
    void vscode.window.showInformationMessage(`Ariadne: only one folder is open ("${folders[0].name}"); nothing to choose.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: 'Select the workspace folder Ariadne should track' },
  );
  if (!picked) return;

  await extensionContext?.workspaceState.update(SELECTED_FOLDER_KEY, picked.folder.uri.fsPath);
  warnedAboutAmbiguity = false;
  void vscode.window.showInformationMessage(`Ariadne: now tracking "${picked.label}".`);
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
  return getOrOpenStore(root).getCurrentTaskId();
}

export function setCurrentTask(taskId: string): void {
  const root = resolveWorkspaceRoot();
  if (!root) return;
  getOrOpenStore(root).setCurrentTaskId(taskId);
}
