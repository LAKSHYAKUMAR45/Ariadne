import * as vscode from 'vscode';
import * as path from 'node:path';
import { findWorkspaceRoot, redactCommand } from '@ariadne/core';
import { getOrOpenStore } from './storeCache.js';

/**
 * Passive background capture: watches file saves, terminal command
 * executions, and git commits, and auto-populates the `files`/`commands`/
 * `commits` tables for the workspace's *current* task.
 *
 * Deliberately conservative:
 *  - Never creates or switches tasks on its own — if a workspace root has
 *    no current task set (via `/task new` or "Ariadne: New Task"), events
 *    for that root are silently ignored. Automatic task detection is an
 *    open design question (see docs/04-ROADMAP.md); passive capture only
 *    ever *appends to* an explicitly-started task.
 *  - Ignores common noise directories (.git, node_modules, build output).
 *  - Any failure is caught and logged to the "Ariadne" output channel
 *    rather than surfaced to the user — passive capture must never
 *    interrupt normal editing/terminal/git workflows.
 */

// Minimal slice of the built-in `vscode.git` extension's API that we use.
// (There's no @types package for it; this mirrors the relevant bits of
// https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts)
interface GitCommit {
  message: string;
}
interface GitRepositoryState {
  HEAD?: { commit?: string };
  onDidChange: vscode.Event<void>;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
  log(options: { maxEntries: number }): Promise<GitCommit[]>;
}
interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}
interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

// Terminal shell integration API (stable since VS Code 1.93 — matches this
// extension's engines.vscode floor) isn't in all @types/vscode versions yet,
// so it's typed narrowly here rather than widening the whole vscode import.
interface TerminalShellExecutionEndEvent {
  terminal: vscode.Terminal;
  execution: { commandLine: { value: string } };
  exitCode?: number;
}
interface WindowWithShellIntegration {
  onDidEndTerminalShellExecution?: (
    listener: (e: TerminalShellExecutionEndEvent) => void,
  ) => vscode.Disposable;
}

const IGNORED_PATH_SEGMENTS = new Set([
  '.git',
  '.ariadne',
  'node_modules',
  'dist',
  'out',
  'build',
  '.vscode-test',
]);

let output: vscode.OutputChannel | undefined;

function log(context: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  output?.appendLine(`[${new Date().toISOString()}] passive-capture ${context}: ${message}`);
}

function resolveTaskContext(uri: vscode.Uri): { root: string; taskId: string } | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const root = findWorkspaceRoot(folder.uri.fsPath);
  // Use the cached store (same connection recordCommand/touchFile etc. below
  // will use) instead of readCurrentTaskId(root), which would open its own
  // short-lived connection — this runs on a hot path (every file save).
  const taskId = getOrOpenStore(root).getCurrentTaskId();
  if (!taskId) return undefined;
  return { root, taskId };
}

function shouldIgnorePath(relPath: string): boolean {
  return relPath.split(path.sep).some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

function registerFileSaveCapture(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      try {
        if (doc.uri.scheme !== 'file') return;
        const ctx = resolveTaskContext(doc.uri);
        if (!ctx) return;
        const relPath = path.relative(ctx.root, doc.uri.fsPath);
        if (shouldIgnorePath(relPath)) return;
        getOrOpenStore(ctx.root).touchFile({ taskId: ctx.taskId, path: relPath, role: 'edited' });
      } catch (err) {
        log('file save', err);
      }
    }),
  );
}

function registerTerminalCommandCapture(context: vscode.ExtensionContext): void {
  const w = vscode.window as unknown as WindowWithShellIntegration;
  if (!w.onDidEndTerminalShellExecution) {
    log('terminal', 'shell integration API unavailable on this VS Code version; skipping command capture');
    return;
  }
  context.subscriptions.push(
    w.onDidEndTerminalShellExecution((e) => {
      try {
        const anchorUri =
          (e.terminal.shellIntegration as { cwd?: vscode.Uri } | undefined)?.cwd ??
          vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!anchorUri) return;
        const ctx = resolveTaskContext(anchorUri);
        if (!ctx) return;
        const commandLine = e.execution.commandLine.value.trim();
        if (!commandLine) return;
        getOrOpenStore(ctx.root).recordCommand({
          taskId: ctx.taskId,
          cmdRedacted: redactCommand(commandLine),
          exitCode: e.exitCode ?? null,
        });
      } catch (err) {
        log('terminal command', err);
      }
    }),
  );
}

async function registerGitCommitCapture(context: vscode.ExtensionContext): Promise<void> {
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!gitExtension) return;
    const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = exports.getAPI(1);

    // Tracks the last HEAD sha we've seen per repo root, seeded from the
    // repo's current HEAD so we only capture *new* commits made during this
    // session, not the whole prior history.
    const lastKnownHead = new Map<string, string>();

    const watchRepo = (repo: GitRepository) => {
      lastKnownHead.set(repo.rootUri.fsPath, repo.state.HEAD?.commit ?? '');
      context.subscriptions.push(
        repo.state.onDidChange(async () => {
          try {
            const head = repo.state.HEAD?.commit;
            if (!head) return;
            const repoRoot = repo.rootUri.fsPath;
            if (lastKnownHead.get(repoRoot) === head) return;
            lastKnownHead.set(repoRoot, head);

            const ctx = resolveTaskContext(repo.rootUri);
            if (!ctx) return;

            const [commit] = await repo.log({ maxEntries: 1 });
            const message = commit?.message?.split('\n')[0];
            getOrOpenStore(ctx.root).recordCommit({ sha: head, taskId: ctx.taskId, message });
          } catch (err) {
            log('git commit', err);
          }
        }),
      );
    };

    for (const repo of api.repositories) watchRepo(repo);
    context.subscriptions.push(api.onDidOpenRepository(watchRepo));
  } catch (err) {
    log('git extension', err);
  }
}

const DIAGNOSTICS_DEBOUNCE_MS = 1500;

/** Builds a stable key for a diagnostic so we can tell "new" from "already recorded". */
function diagnosticKey(d: vscode.Diagnostic): string {
  return `${d.range.start.line}:${d.range.start.character}:${d.message}`;
}

/**
 * Passively captures compiler/linter errors surfaced via VS Code's built-in
 * Problems panel (any language server, linter, or build task that reports
 * through `vscode.languages.onDidChangeDiagnostics`), auto-populating the
 * `errors` table for the workspace's current task — no need to manually run
 * `/error add`. Debounced per-file to avoid recording noise while typing,
 * and auto-resolves entries once the underlying diagnostic disappears
 * (fixed, or the file/problem no longer applies).
 */
function registerDiagnosticsCapture(context: vscode.ExtensionContext): void {
  // Per-file map of diagnostic key -> recorded error id, so we can detect
  // both newly-appeared diagnostics (record) and newly-cleared ones (resolve).
  const trackedByFile = new Map<string, Map<string, string>>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const processUri = (uri: vscode.Uri) => {
    try {
      const ctx = resolveTaskContext(uri);
      const fileKey = uri.toString();
      const previous = trackedByFile.get(fileKey);
      if (!ctx) {
        // No current task for this root — nothing to record, but still
        // forget prior tracking so we don't try to resolve stale ids later.
        trackedByFile.delete(fileKey);
        return;
      }

      const relPath = path.relative(ctx.root, uri.fsPath);
      if (shouldIgnorePath(relPath)) return;

      const diagnostics = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);

      const store = getOrOpenStore(ctx.root);
      const current = new Map<string, string>();

      for (const d of diagnostics) {
        const key = diagnosticKey(d);
        const existingId = previous?.get(key);
        if (existingId) {
          current.set(key, existingId);
          continue;
        }
        const line = d.range.start.line + 1;
        const message = `${relPath}:${line} — ${d.message}`.slice(0, 500);
        const recorded = store.recordError({ taskId: ctx.taskId, message });
        current.set(key, recorded.id);
      }

      if (previous) {
        for (const [key, id] of previous) {
          if (!current.has(key)) store.resolveError(id, 'diagnostic cleared');
        }
      }

      if (current.size > 0) {
        trackedByFile.set(fileKey, current);
      } else {
        trackedByFile.delete(fileKey);
      }
    } catch (err) {
      log('diagnostics', err);
    }
  };

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        if (uri.scheme !== 'file') continue;
        const key = uri.toString();
        const existingTimer = debounceTimers.get(key);
        if (existingTimer) clearTimeout(existingTimer);
        debounceTimers.set(
          key,
          setTimeout(() => {
            debounceTimers.delete(key);
            processUri(uri);
          }, DIAGNOSTICS_DEBOUNCE_MS),
        );
      }
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
    },
  });
}

/** Registers all passive-capture listeners. Called once from activate(). */
export function registerPassiveCapture(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): void {
  output = outputChannel;
  registerFileSaveCapture(context);
  registerTerminalCommandCapture(context);
  void registerGitCommitCapture(context);
  registerDiagnosticsCapture(context);
}

