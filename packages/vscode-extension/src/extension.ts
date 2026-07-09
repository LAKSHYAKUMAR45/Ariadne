import * as vscode from 'vscode';
import { openStoreForCurrentWorkspace, getCurrentTaskId, setCurrentTask, initWorkspaceResolution, promptSelectWorkspaceFolder } from './workspace.js';
import { handleChatCommand, progressMessageFor } from './commands.js';
import { closeAllStores, closeStore } from './storeCache.js';
import { registerPassiveCapture } from './passiveCapture.js';
import { findWorkspaceRoot } from '@ariadne/core';

let output: vscode.OutputChannel;

function logError(context: string, err: unknown): string {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  output.appendLine(`[${new Date().toISOString()}] ${context}: ${message}`);
  return err instanceof Error ? err.message : String(err);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Ariadne');
  context.subscriptions.push(output);
  initWorkspaceResolution(context);

  const participant = vscode.chat.createChatParticipant('ariadne.chat', handleRequest);
  participant.iconPath = new vscode.ThemeIcon('compass');
  context.subscriptions.push(participant);

  context.subscriptions.push(
    vscode.commands.registerCommand('ariadne.selectWorkspaceFolder', () => promptSelectWorkspaceFolder()),
  );

  if (vscode.workspace.getConfiguration('ariadne').get<boolean>('passiveCapture.enabled', true)) {
    registerPassiveCapture(context, output);
  }

  // Close (and evict) the cached store for any folder removed from the workspace.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const removed of e.removed) {
        closeStore(findWorkspaceRoot(removed.uri.fsPath));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ariadne.newTask', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'New Ariadne task title' });
      if (!title) return;

      let store;
      try {
        store = openStoreForCurrentWorkspace();
      } catch (err) {
        const message = logError('ariadne.newTask (open store)', err);
        void vscode.window.showErrorMessage(`Ariadne: failed to open task database — ${message}`);
        return;
      }
      if (!store) {
        void vscode.window.showWarningMessage('Ariadne: open a folder/workspace first.');
        return;
      }
      try {
        const task = store.createTask({ title });
        setCurrentTask(task.id);
        void vscode.window.showInformationMessage(`Ariadne: created task "${task.title}".`);
      } catch (err) {
        const message = logError('ariadne.newTask', err);
        void vscode.window.showErrorMessage(`Ariadne: failed to create task — ${message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ariadne.status', async () => {
      let store;
      try {
        store = openStoreForCurrentWorkspace();
      } catch (err) {
        const message = logError('ariadne.status (open store)', err);
        void vscode.window.showErrorMessage(`Ariadne: failed to open task database — ${message}`);
        return;
      }
      if (!store) {
        void vscode.window.showWarningMessage('Ariadne: open a folder/workspace first.');
        return;
      }
      try {
        const taskId = getCurrentTaskId();
        if (!taskId) {
          void vscode.window.showInformationMessage('Ariadne: no current task. Run "Ariadne: New Task" first.');
          return;
        }
        const result = handleChatCommand(store, { command: 'status', prompt: '', currentTaskId: taskId });
        const doc = await vscode.workspace.openTextDocument({ content: result.markdown, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        const message = logError('ariadne.status', err);
        void vscode.window.showErrorMessage(`Ariadne: failed to show status — ${message}`);
      }
    }),
  );
}

async function handleRequest(
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
): Promise<vscode.ChatResult | void> {
  let store;
  try {
    stream.progress('Opening Ariadne task database…');
    store = openStoreForCurrentWorkspace();
  } catch (err) {
    const message = logError('chat handler (open store)', err);
    stream.markdown(
      `⚠️ Ariadne couldn't open its task database: ${message}\n\nSee the "Ariadne" output channel for details.`,
    );
    return { errorDetails: { message } };
  }

  if (!store) {
    stream.markdown('Ariadne needs an open folder/workspace to find or create `.ariadne/state.db`.');
    return;
  }

  try {
    const currentTaskId = getCurrentTaskId();
    stream.progress(progressMessageFor(request.command));
    const result = handleChatCommand(store, {
      command: request.command,
      prompt: request.prompt,
      currentTaskId,
    });

    if (result.newCurrentTaskId) {
      setCurrentTask(result.newCurrentTaskId);
    }

    if (result.sections && result.sections.length > 1) {
      // Stream section-by-section (with a microtask yield between each) so
      // long /status or /resume output renders progressively instead of
      // appearing as one large block once everything is ready.
      for (const section of result.sections) {
        stream.markdown(section + '\n\n');
        await Promise.resolve();
      }
    } else {
      stream.markdown(result.markdown);
    }

    if (!currentTaskId && !result.newCurrentTaskId) {
      stream.button({
        command: 'ariadne.newTask',
        title: 'Start a new Ariadne task',
      });
    }
  } catch (err) {
    const message = logError('chat handler', err);
    stream.markdown(
      `⚠️ Something went wrong handling that request: ${message}\n\nSee the "Ariadne" output channel for details.`,
    );
    return { errorDetails: { message } };
  }
}

export function deactivate(): void {
  closeAllStores();
}
