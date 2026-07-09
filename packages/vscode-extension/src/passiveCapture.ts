import * as vscode from 'vscode';
import * as path from 'node:path';
import { findWorkspaceRoot, redactCommand } from '@ariadne-dev/core';
import {
  maybeCheckpointOnFileActivity,
  checkpointOnCommit,
  checkpointOnError,
  maybeCheckpointOnIdle,
} from '@ariadne-dev/core';
import { getOrOpenStore, listOpenStores } from './storeCache.js';
import { branchMismatchWarning } from './commands.js';

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
  HEAD?: { commit?: string; name?: string };
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

// Workspace roots we've already nudged about having no current task, so the
// "no active task" notice fires once per workspace per session instead of
// spamming on every file save/terminal command/diagnostic while it's true.
const warnedNoTaskRoots = new Set<string>();

/** Resets the one-time "no active task" notice tracking — exported for tests only. */
export function resetPassiveCaptureGuardrailState(): void {
  warnedNoTaskRoots.clear();
}

function resolveTaskContext(uri: vscode.Uri): { root: string; taskId: string } | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const root = findWorkspaceRoot(folder.uri.fsPath);
  // Use the cached store (same connection recordCommand/touchFile etc. below
  // will use) instead of readCurrentTaskId(root), which would open its own
  // short-lived connection — this runs on a hot path (every file save).
  const taskId = getOrOpenStore(root).getCurrentTaskId();
  if (!taskId) {
    // Lightweight, non-blocking guardrail: nudge the user once per
    // workspace per session that passive capture isn't recording anything
    // because no task has been started yet, rather than silently dropping
    // every save/terminal/diagnostic event forever.
    if (!warnedNoTaskRoots.has(root)) {
      warnedNoTaskRoots.add(root);
      void vscode.window.showInformationMessage(
        'Ariadne: no active task for this workspace, so nothing is being captured. Run "Ariadne: New Task" (or `/task new <title>`) to start one.',
      );
    }
    return undefined;
  }
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
        const store = getOrOpenStore(ctx.root);
        store.touchFile({ taskId: ctx.taskId, path: relPath, role: 'edited' });
        // Rule-based checkpoint trigger: once enough files have been touched
        // since the last checkpoint, roll them into a micro checkpoint
        // summary automatically (docs/03-DATA-MODEL.md section 6).
        maybeCheckpointOnFileActivity(store, ctx.taskId);
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

    // Tracks the last HEAD sha/branch we've seen per repo root, seeded from
    // the repo's current state so we only capture *new* commits/branch
    // switches made during this session, not the whole prior history.
    const lastKnownHead = new Map<string, string>();
    const lastKnownBranch = new Map<string, string | undefined>();

    const watchRepo = (repo: GitRepository) => {
      lastKnownHead.set(repo.rootUri.fsPath, repo.state.HEAD?.commit ?? '');
      lastKnownBranch.set(repo.rootUri.fsPath, repo.state.HEAD?.name);
      context.subscriptions.push(
        repo.state.onDidChange(async () => {
          try {
            const repoRoot = repo.rootUri.fsPath;
            const ctx = resolveTaskContext(repo.rootUri);

            // Branch switch detection (independent of whether HEAD's commit
            // also changed) — updates task.branch via GitWatcher's TaskStore
            // method, per docs/02-ARCHITECTURE.md's GitWatcher responsibility.
            const branch = repo.state.HEAD?.name;
            if (ctx && lastKnownBranch.get(repoRoot) !== branch) {
              lastKnownBranch.set(repoRoot, branch);
              const store = getOrOpenStore(ctx.root);
              // Guardrail: if the task was previously tracked on a
              // *different* branch than the one just checked out, that's a
              // plausible sign the user meant to switch Ariadne tasks too
              // (not just git branches) — warn instead of silently
              // re-tagging the task to the new branch.
              const task = store.getTask(ctx.taskId);
              if (task) {
                const warning = branchMismatchWarning(task, branch);
                if (warning) void vscode.window.showWarningMessage(warning);
              }
              store.updateTaskBranch(ctx.taskId, branch ?? null);
            }

            const head = repo.state.HEAD?.commit;
            if (!head) return;
            if (lastKnownHead.get(repoRoot) === head) return;
            lastKnownHead.set(repoRoot, head);

            if (!ctx) return;

            const [commit] = await repo.log({ maxEntries: 1 });
            const message = commit?.message?.split('\n')[0] ?? null;
            const store = getOrOpenStore(ctx.root);
            store.recordCommit({ sha: head, taskId: ctx.taskId, message });
            // A commit always triggers a micro checkpoint (docs/03-DATA-MODEL.md section 6).
            checkpointOnCommit(store, ctx.taskId, head, message);
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
        // A newly recorded unresolved error always triggers a micro
        // checkpoint (docs/03-DATA-MODEL.md section 6).
        checkpointOnError(store, ctx.taskId, message);
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

/** How often to poll open tasks for idle-checkpoint eligibility. Kept well below
 * the default 10-minute idle threshold so idle sessions get captured promptly
 * after crossing it, without polling so often it's wasteful. */
const IDLE_CHECK_INTERVAL_MS = 2 * 60_000;

/**
 * Periodically checks every currently-open workspace's current task for the
 * idle-checkpoint trigger (docs/03-DATA-MODEL.md section 6: no checkpoint
 * activity for >10 minutes despite file touches since the last one). There's
 * no natural VS Code "editor went idle" event to hook, so this runs on a
 * plain interval instead — cheap (a couple of indexed SQLite reads per open
 * workspace) and self-limiting (maybeCheckpointOnIdle is a no-op unless the
 * threshold is actually crossed).
 */
function registerIdleCheckpointPolling(context: vscode.ExtensionContext): void {
  const timer = setInterval(() => {
    for (const [, store] of listOpenStores()) {
      try {
        const taskId = store.getCurrentTaskId();
        if (!taskId) continue;
        maybeCheckpointOnIdle(store, taskId);
      } catch (err) {
        log('idle checkpoint', err);
      }
    }
  }, IDLE_CHECK_INTERVAL_MS);
  // Let Node exit even if this timer is still pending (e.g. during tests).
  timer.unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

/** Registers all passive-capture listeners. Called once from activate(). */
export function registerPassiveCapture(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): void {
  output = outputChannel;
  registerFileSaveCapture(context);
  registerTerminalCommandCapture(context);
  void registerGitCommitCapture(context);
  registerDiagnosticsCapture(context);
  registerIdleCheckpointPolling(context);
}

