import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildWebviewState, handleWebviewMessage } from './handleWebviewMessage.js';
import {
  WebviewRequestTypes,
  type GraphifyRequestPayload,
  type GraphifyRunResult,
  type WebviewRequest,
  type WebviewResponse,
  type WebviewState,
} from './messages.js';
import {
  GRAPHIFY_INSTALL_HINT,
  getCurrentBranch,
  isGraphifyInstalled,
  runGraphifySync,
  summarizeGraphifyRun,
  type TaskStore,
} from '@ariadne-dev/core';
import { syncProfileList, syncPush, syncPull, syncListRemote } from '../syncCommands.js';
import { getOrOpenStore } from '../storeCache.js';

export interface AriadnePanelDeps {
  openStoreForCurrentWorkspace: () => TaskStore | undefined;
  getCurrentTaskId: () => string | undefined;
  setCurrentTask: (id: string) => void;
  setCurrentTaskInWorkspace: (id: string, workspaceRoot: string) => void;
  resolveWorkspaceRoot: () => string | undefined;
  output: vscode.OutputChannel;
  logError: (context: string, err: unknown) => string;
  refreshHost: () => void;
  openExportedMarkdown: (filePath: string) => Promise<void>;
  copyText?: (text: string) => Promise<void> | void;
  openMarkdown?: (title: string, markdown: string) => Promise<void> | void;
}

let panel: vscode.WebviewPanel | undefined;
let panelDeps: AriadnePanelDeps | undefined;
let selectedWorkspaceRoot: string | undefined;

const GRAPHIFY_PANEL_OUTPUT_LIMIT = 20_000;
const GRAPHIFY_TRUNCATION_SUFFIX = '\n\n[truncated for panel view]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWebviewRequest(value: unknown): value is WebviewRequest {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

function readPassiveCaptureState(workspaceRoot: string | undefined): {
  enabled: boolean;
  shellIntegrationAvailable: boolean;
  gitExtensionAvailable: boolean;
  currentBranch?: string;
} {
  const windowWithShellIntegration = vscode.window as unknown as {
    onDidEndTerminalShellExecution?: unknown;
  };
  const currentBranch = workspaceRoot ? getCurrentBranch(workspaceRoot) ?? undefined : undefined;
  return {
    enabled: vscode.workspace.getConfiguration('ariadne').get<boolean>('passiveCapture.enabled', true),
    shellIntegrationAvailable: Boolean(windowWithShellIntegration.onDidEndTerminalShellExecution),
    gitExtensionAvailable: Boolean(vscode.extensions.getExtension('vscode.git')),
    currentBranch,
  };
}

function nonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function listAssets(extensionUri: vscode.Uri): { scripts: vscode.Uri[]; styles: vscode.Uri[] } {
  const assetsDir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets');
  if (!fs.existsSync(assetsDir.fsPath)) {
    return { scripts: [], styles: [] };
  }

  const scripts: vscode.Uri[] = [];
  const styles: vscode.Uri[] = [];
  for (const fileName of fs.readdirSync(assetsDir.fsPath).sort()) {
    const assetPath = path.join(assetsDir.fsPath, fileName);
    if (fileName.endsWith('.js')) {
      scripts.push(vscode.Uri.file(assetPath));
    } else if (fileName.endsWith('.css')) {
      styles.push(vscode.Uri.file(assetPath));
    }
  }
  return { scripts, styles };
}

function buildPanelHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const { scripts, styles } = listAssets(context.extensionUri);
  const cspNonce = nonce();
  const styleTags = styles
    .map((uri) => `<link rel="stylesheet" href="${webview.asWebviewUri(uri)}">`)
    .join('\n');
  const scriptTags = scripts
    .map((uri) => `<script nonce="${cspNonce}" src="${webview.asWebviewUri(uri)}"></script>`)
    .join('\n');

  if (scripts.length === 0 && styles.length === 0) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${cspNonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ariadne</title>
</head>
<body>
  <div id="root">Ariadne panel assets are not built yet.</div>
</body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${cspNonce}' ${webview.cspSource}; connect-src ${webview.cspSource}; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ariadne</title>
  ${styleTags}
</head>
<body>
  <div id="root"></div>
  ${scriptTags}
</body>
</html>`;
}

function buildExportPath(workspaceRoot: string, taskId: string): string {
  const exportDir = path.join(workspaceRoot, '.ariadne', 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  return path.join(exportDir, `${taskId}.md`);
}

function writeExportMarkdown(taskId: string, markdown: string): string {
  if (!panelDeps) {
    throw new Error('Ariadne panel is not initialized.');
  }
  const workspaceRoot = panelDeps.resolveWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error('Ariadne needs an open folder/workspace to export Markdown.');
  }
  const filePath = buildExportPath(workspaceRoot, taskId);
  fs.writeFileSync(filePath, markdown, 'utf8');
  return filePath;
}

function currentState(): WebviewState | undefined {
  if (!panelDeps) return undefined;
  const workspaceRoot = selectedWorkspaceRoot ?? panelDeps.resolveWorkspaceRoot();
  const store = selectedWorkspaceRoot ? getOrOpenStore(selectedWorkspaceRoot) : panelDeps.openStoreForCurrentWorkspace();
  if (!store) return undefined;
  return buildWebviewState({
    store,
    currentTaskId: selectedWorkspaceRoot ? store.getCurrentTaskId() : panelDeps.getCurrentTaskId(),
    workspaceRoot,
  });
}

function resolveSelectedWorkspaceRoot(): string | undefined {
  return selectedWorkspaceRoot ?? panelDeps?.resolveWorkspaceRoot();
}

async function copyText(text: string): Promise<void> {
  if (panelDeps?.copyText) {
    await panelDeps.copyText(text);
    return;
  }
  await vscode.env.clipboard.writeText(text);
}

async function openMarkdown(title: string, markdown: string): Promise<void> {
  if (panelDeps?.openMarkdown) {
    await panelDeps.openMarkdown(title, markdown);
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function openWorkspaceFile(relativePath: string): Promise<void> {
  const root = resolveSelectedWorkspaceRoot();
  if (!root) {
    throw new Error('No workspace root is selected.');
  }

  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('file.open requires a workspace-relative path.');
  }

  const uri = vscode.Uri.file(resolved);
  await vscode.workspace.fs.stat(uri);
  await vscode.window.showTextDocument(uri, { preview: true });
}

function buildGraphifyArgs(payload: GraphifyRequestPayload): string[] {
  switch (payload.mode) {
    case 'update':
      return ['update', '.'];
    case 'query':
      return ['query', payload.query ?? ''];
    case 'path':
      return ['path', payload.from ?? '', payload.to ?? ''];
    case 'explain':
      return ['explain', payload.target ?? ''];
  }
}

function formatGraphifyOutput(stdout: string, stderr: string): string {
  const sections = [stdout.trim(), stderr.trim()].filter((section) => section.length > 0);
  return sections.length > 0 ? sections.join('\n\n') : '(no output)';
}

function truncateGraphifyOutput(output: string): { output: string; truncated: boolean } {
  if (output.length <= GRAPHIFY_PANEL_OUTPUT_LIMIT) {
    return { output, truncated: false };
  }

  return {
    output: `${output.slice(0, GRAPHIFY_PANEL_OUTPUT_LIMIT - GRAPHIFY_TRUNCATION_SUFFIX.length)}${GRAPHIFY_TRUNCATION_SUFFIX}`,
    truncated: true,
  };
}

function runGraphifyForPanel(payload: GraphifyRequestPayload, workspaceRoot: string | undefined, output: vscode.OutputChannel): GraphifyRunResult {
  if (!workspaceRoot) {
    return {
      available: false,
      args: [],
      output: 'Open a workspace folder to run Graphify.',
      exitCode: 1,
      truncated: false,
    };
  }

  if (!isGraphifyInstalled()) {
    return {
      available: false,
      args: [],
      output: GRAPHIFY_INSTALL_HINT,
      exitCode: 127,
      truncated: false,
    };
  }

  const args = buildGraphifyArgs(payload);
  const result = runGraphifySync(args, { cwd: workspaceRoot });
  const fullOutput = formatGraphifyOutput(result.stdout, result.stderr);
  output.appendLine(`[${new Date().toISOString()}] graphify ${args.join(' ')}\n${fullOutput}`);
  const boundedOutput = truncateGraphifyOutput(fullOutput);

  return {
    available: true,
    args,
    output: boundedOutput.output,
    exitCode: result.exitCode,
    truncated: boundedOutput.truncated,
    ...(result.exitCode === 0 ? { checkpointSummary: summarizeGraphifyRun(args, result) } : {}),
  };
}

function postStateUpdate(state?: WebviewState): void {
  if (!panel || !panelDeps) return;
  if (!state) return;
  void panel.webview.postMessage({ type: 'stateUpdate', state });
}

async function handleWebviewRequest(message: unknown): Promise<void> {
  if (!panel || !panelDeps) return;
  try {
    if (!isWebviewRequest(message)) {
      panelDeps.output.appendLine(`[${new Date().toISOString()}] webview: ignored malformed message`);
      return;
    }

    const workspaceRoot = selectedWorkspaceRoot ?? panelDeps.resolveWorkspaceRoot();
    const store = selectedWorkspaceRoot ? getOrOpenStore(selectedWorkspaceRoot) : panelDeps.openStoreForCurrentWorkspace();
    if (!store) {
      const response: WebviewResponse = { id: message.id, ok: false, error: 'Ariadne needs an open folder/workspace.' };
      void panel.webview.postMessage(response);
      return;
    }

    const response = await handleWebviewMessage(
      {
        store,
        currentTaskId: selectedWorkspaceRoot ? store.getCurrentTaskId() : panelDeps.getCurrentTaskId(),
        workspaceRoot,
        passiveCapture: readPassiveCaptureState(workspaceRoot),
        setCurrentTaskId: panelDeps.setCurrentTask,
        setCurrentTaskIdForWorkspace: panelDeps.setCurrentTaskInWorkspace,
        sync: {
          profileList: () => {
            if (!workspaceRoot) throw new Error('Ariadne needs an open folder/workspace for sync profile list.');
            return syncProfileList({ cwd: workspaceRoot });
          },
          push: () => {
            if (!workspaceRoot) throw new Error('Ariadne needs an open folder/workspace for sync push.');
            return syncPush({ cwd: workspaceRoot });
          },
          pull: (options) => {
            if (!workspaceRoot) throw new Error('Ariadne needs an open folder/workspace for sync pull.');
            return syncPull({
              cwd: workspaceRoot,
              ...(options?.importNew !== undefined ? { importNew: options.importNew } : {}),
              ...(options?.onConflict ? { onConflict: options.onConflict } : {}),
            });
          },
          listRemote: () => {
            if (!workspaceRoot) throw new Error('Ariadne needs an open folder/workspace for sync list-remote.');
            return syncListRemote({ cwd: workspaceRoot });
          },
        },
        writeExport: writeExportMarkdown,
        copyText,
        openMarkdown,
        openWorkspaceFile,
        graphify: {
          run: (payload, root) => runGraphifyForPanel(payload, root, panelDeps!.output),
        },
      },
      message,
    );

    void panel.webview.postMessage(response);
    if (response.state) {
      selectedWorkspaceRoot = response.state.workspaceRoot;
      postStateUpdate(response.state);
      panelDeps.refreshHost();
    }
    if (response.ok && message.type === WebviewRequestTypes.ExportMarkdown) {
      const data = isRecord(response.data) ? response.data : undefined;
      const filePath = typeof data?.path === 'string' ? data.path : undefined;
      if (filePath) {
        await panelDeps.openExportedMarkdown(filePath);
      }
    }
  } catch (err) {
    if (isWebviewRequest(message)) {
      const error = panelDeps.logError('webview panel request', err);
      void panel.webview.postMessage({ id: message.id, ok: false, error });
    } else {
      panelDeps.logError('webview panel request', err);
    }
  }
}

export function openAriadnePanel(context: vscode.ExtensionContext, deps: AriadnePanelDeps): void {
  panelDeps = deps;

  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    postStateUpdate(currentState());
    return;
  }

  panel = vscode.window.createWebviewPanel('ariadnePanel', 'Ariadne', vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
  });

  panel.webview.html = buildPanelHtml(panel.webview, context);
  panel.webview.onDidReceiveMessage((message) => void handleWebviewRequest(message));
  panel.onDidDispose(() => {
    panel = undefined;
    panelDeps = undefined;
    selectedWorkspaceRoot = undefined;
  });

  postStateUpdate(currentState());
}

export function refreshAriadnePanel(): void {
  if (!panel || !panelDeps) return;
  postStateUpdate(currentState());
}
