import * as vscode from 'vscode';
import type { Task } from '@ariadne-dev/core';

export const ARIADNE_LAUNCHER_VIEW_ID = 'ariadne.launcherView';

export interface AriadneLauncherViewDeps {
  getCurrentTask: () => Task | undefined;
  getWorkspaceRoot: () => string | undefined;
  logError: (context: string, err: unknown) => string;
  openContextInChat: () => Promise<void>;
  openContextInCli: () => Promise<void>;
}

let currentProvider: AriadneLauncherViewProvider | undefined;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export class AriadneLauncherViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly deps: AriadneLauncherViewDeps) {
    currentProvider = this;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.render(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  refresh(): void {
    if (!this.view) return;
    this.view.webview.html = this.render(this.view.webview);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null || !('command' in message)) return;
    const command = (message as { command?: unknown }).command;
    try {
      if (command === 'openPanel') {
        await vscode.commands.executeCommand('ariadne.openPanel');
      } else if (command === 'newTask') {
        await vscode.commands.executeCommand('ariadne.newTask');
      } else if (command === 'syncPush') {
        await vscode.commands.executeCommand('ariadne.syncPush');
      } else if (command === 'openInChat') {
        await this.deps.openContextInChat();
      } else if (command === 'openInCli') {
        await this.deps.openContextInCli();
      }
    } catch (err) {
      const detail = this.deps.logError('ariadne launcher view', err);
      void vscode.window.showErrorMessage(`Ariadne: launcher action failed — ${detail}`);
    }
  }

  private render(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    const task = this.deps.getCurrentTask();
    const workspaceRoot = this.deps.getWorkspaceRoot();
    const taskTitle = task ? escapeHtml(task.title) : 'No current task';
    const taskMeta = task
      ? escapeHtml([task.status, task.branch, task.goal].filter(Boolean).join(' · '))
      : workspaceRoot
        ? 'Create or select a task to start capturing work.'
        : 'Open a workspace folder to start using Ariadne.';
    const contextActionsDisabled = task ? '' : 'disabled';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ariadne</title>
  <style>
    body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 12px; }
    h2 { font-size: 14px; margin: 0 0 8px; }
    p { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
    button { width: 100%; margin: 0 0 8px; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; margin-bottom: 12px; }
    .divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 4px 0 12px; }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  </style>
</head>
<body>
  <div class="card">
    <h2>${taskTitle}</h2>
    <p>${taskMeta}</p>
  </div>
  <button type="button" data-command="openPanel">Open Ariadne Panel</button>
  <button type="button" data-command="newTask">New Task</button>
  <button type="button" data-command="syncPush">Sync to Cloud</button>
  <hr class="divider">
  <button type="button" class="secondary" data-command="openInChat" ${contextActionsDisabled}>Open in Copilot Chat</button>
  <button type="button" class="secondary" data-command="openInCli" ${contextActionsDisabled}>Open in Copilot CLI</button>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
  </script>
</body>
</html>`;
  }
}

export function registerAriadneLauncherView(context: vscode.ExtensionContext, deps: AriadneLauncherViewDeps): void {
  const provider = new AriadneLauncherViewProvider(deps);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ARIADNE_LAUNCHER_VIEW_ID, provider));
}

export function refreshAriadneLauncherView(): void {
  currentProvider?.refresh();
}
