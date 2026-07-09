import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskStore, openWorkspaceStore, setCurrentTaskId } from '@ariadne/core';

// Fake `vscode` surface covering exactly what passiveCapture.ts touches:
// onDidSaveTextDocument, onDidEndTerminalShellExecution (cast onto
// `window`), getWorkspaceFolder, and extensions.getExtension (returns
// undefined here — git-commit capture is exercised in isolation is out of
// scope for a unit test since it needs the real vscode.git extension).
let savedDocHandler: ((doc: { uri: { scheme: string; fsPath: string } }) => void) | undefined;
let terminalHandler: ((e: unknown) => void) | undefined;
let diagnosticsChangeHandler: ((e: { uris: { scheme: string; fsPath: string; toString(): string }[] }) => void) | undefined;
let folders: { uri: { fsPath: string } }[] = [];
let diagnosticsByUri = new Map<string, { severity: number; message: string; range: { start: { line: number; character: number } } }[]>();
let infoMessages: string[] = [];
let warningMessages: string[] = [];

// Fake `vscode.git` API surface, only populated by the tests in the "git
// commit capture" describe block below; left undefined everywhere else so
// registerGitCommitCapture's `getExtension('vscode.git')` no-ops as before.
let gitApi:
  | {
      repositories: {
        rootUri: { fsPath: string };
        state: { HEAD?: { commit?: string; name?: string }; onDidChange: (fn: () => void) => { dispose(): void } };
        log: (opts: { maxEntries: number }) => Promise<{ message?: string }[]>;
      }[];
      onDidOpenRepository: (fn: (repo: unknown) => void) => { dispose(): void };
    }
  | undefined;

vi.mock('vscode', () => {
  return {
    workspace: {
      onDidSaveTextDocument: (fn: typeof savedDocHandler) => {
        savedDocHandler = fn;
        return { dispose: () => {} };
      },
      getWorkspaceFolder: (uri: { fsPath: string }) =>
        folders.find((f) => uri.fsPath.startsWith(f.uri.fsPath)),
      get workspaceFolders() {
        return folders;
      },
    },
    window: {
      onDidEndTerminalShellExecution: (fn: typeof terminalHandler) => {
        terminalHandler = fn;
        return { dispose: () => {} };
      },
      showInformationMessage: (...args: unknown[]) => {
        infoMessages.push(String(args[0]));
        return Promise.resolve(undefined);
      },
      showWarningMessage: (...args: unknown[]) => {
        warningMessages.push(String(args[0]));
        return Promise.resolve(undefined);
      },
    },
    languages: {
      onDidChangeDiagnostics: (fn: typeof diagnosticsChangeHandler) => {
        diagnosticsChangeHandler = fn;
        return { dispose: () => {} };
      },
      getDiagnostics: (uri: { toString(): string }) => diagnosticsByUri.get(uri.toString()) ?? [],
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    extensions: {
      getExtension: (id: string) => {
        if (id !== 'vscode.git' || !gitApi) return undefined;
        return { isActive: true, exports: { getAPI: () => gitApi } };
      },
    },
  };
});

describe('passive capture', () => {
  let root: string;
  let store: TaskStore;
  let taskId: string;
  let context: { subscriptions: { dispose(): void }[] };
  let output: { appendLine: (s: string) => void };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    savedDocHandler = undefined;
    terminalHandler = undefined;
    diagnosticsChangeHandler = undefined;
    diagnosticsByUri = new Map();
    infoMessages = [];
    warningMessages = [];
    gitApi = undefined;

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-passive-'));
    fs.mkdirSync(path.join(root, '.git'));
    folders = [{ uri: { fsPath: root } }];

    store = openWorkspaceStore(root);
    const task = store.createTask({ title: 'Passive capture task' });
    taskId = task.id;
    setCurrentTaskId(task.id, root);

    context = { subscriptions: [] };
    output = { appendLine: () => {} };

    // Fake timers are enabled up-front (rather than only in the
    // timer-dependent describe blocks below) so the idle-checkpoint
    // setInterval registered by registerPassiveCapture is itself a fake
    // timer that vi.advanceTimersByTime can drive.
    const { registerPassiveCapture } = await import('../src/passiveCapture.js');
    registerPassiveCapture(context as never, output as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records a saved file against the current task', () => {
    const filePath = path.join(root, 'src', 'index.ts');
    savedDocHandler!({ uri: { scheme: 'file', fsPath: filePath } });

    const files = store.listFiles(taskId);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(path.join('src', 'index.ts'));
    expect(files[0].role).toBe('edited');
  });

  it('ignores saves inside noise directories like node_modules', () => {
    const filePath = path.join(root, 'node_modules', 'foo', 'index.js');
    savedDocHandler!({ uri: { scheme: 'file', fsPath: filePath } });
    expect(store.listFiles(taskId)).toHaveLength(0);
  });

  it('ignores non-file-scheme documents (e.g. untitled/output panels)', () => {
    savedDocHandler!({ uri: { scheme: 'untitled', fsPath: path.join(root, 'x.ts') } });
    expect(store.listFiles(taskId)).toHaveLength(0);
  });

  it('records a terminal command against the current task', () => {
    terminalHandler!({
      terminal: { shellIntegration: { cwd: { fsPath: root } } },
      execution: { commandLine: { value: 'pnpm test' } },
      exitCode: 0,
    });

    const commands = store.listCommands(taskId);
    expect(commands).toHaveLength(1);
    expect(commands[0].cmdRedacted).toBe('pnpm test');
    expect(commands[0].exitCode).toBe(0);
  });

  it('redacts obviously secret-bearing flags from captured commands', () => {
    terminalHandler!({
      terminal: { shellIntegration: { cwd: { fsPath: root } } },
      execution: { commandLine: { value: 'curl --token abc123 https://example.com' } },
      exitCode: 0,
    });

    const commands = store.listCommands(taskId);
    expect(commands[0].cmdRedacted).toContain('***');
    expect(commands[0].cmdRedacted).not.toContain('abc123');
  });

  it('does not capture when no current task is set for the workspace', () => {
    // Start a fresh root with no current task.
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-passive-none-'));
    fs.mkdirSync(path.join(root2, '.git'));
    folders = [{ uri: { fsPath: root2 } }];
    const store2 = openWorkspaceStore(root2);

    try {
      savedDocHandler!({ uri: { scheme: 'file', fsPath: path.join(root2, 'a.ts') } });
      expect(store2.listFiles(store2.listTasks()[0]?.id ?? 'none')).toHaveLength(0);
    } finally {
      store2.close();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it('shows a one-time info notice when a workspace has no current task', () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-passive-notice-'));
    fs.mkdirSync(path.join(root2, '.git'));
    folders = [{ uri: { fsPath: root2 } }];
    const store2 = openWorkspaceStore(root2);

    try {
      savedDocHandler!({ uri: { scheme: 'file', fsPath: path.join(root2, 'a.ts') } });
      savedDocHandler!({ uri: { scheme: 'file', fsPath: path.join(root2, 'b.ts') } });

      // Only one notice per workspace root, even across repeated events.
      expect(infoMessages).toHaveLength(1);
      expect(infoMessages[0]).toContain('no active task');
    } finally {
      store2.close();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it('creates a micro checkpoint automatically once enough files have been touched', () => {
    for (let i = 0; i < 5; i++) {
      savedDocHandler!({ uri: { scheme: 'file', fsPath: path.join(root, `src/file${i}.ts`) } });
    }
    const checkpoints = store.listCheckpoints(taskId);
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(checkpoints[0].summary).toMatch(/Edited \d+ files?/);
  });

  describe('diagnostics capture', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('records a new error diagnostic against the current task, debounced', () => {
      const filePath = path.join(root, 'src', 'broken.ts');
      const uriStr = `file://${filePath}`;
      diagnosticsByUri.set(uriStr, [
        { severity: 0, message: "Cannot find name 'foo'", range: { start: { line: 4, character: 2 } } },
      ]);

      diagnosticsChangeHandler!({ uris: [{ scheme: 'file', fsPath: filePath, toString: () => uriStr }] });
      expect(store.listErrors(taskId)).toHaveLength(0); // debounced, not yet fired

      vi.advanceTimersByTime(2000);

      const errors = store.listErrors(taskId);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Cannot find name 'foo'");
      expect(errors[0].message).toContain('broken.ts:5');
    });

    it('auto-resolves an error once its diagnostic disappears', () => {
      const filePath = path.join(root, 'src', 'broken.ts');
      const uriStr = `file://${filePath}`;
      const uri = { scheme: 'file', fsPath: filePath, toString: () => uriStr };

      diagnosticsByUri.set(uriStr, [{ severity: 0, message: 'boom', range: { start: { line: 0, character: 0 } } }]);
      diagnosticsChangeHandler!({ uris: [uri] });
      vi.advanceTimersByTime(2000);
      expect(store.listErrors(taskId, { resolved: false })).toHaveLength(1);

      diagnosticsByUri.set(uriStr, []);
      diagnosticsChangeHandler!({ uris: [uri] });
      vi.advanceTimersByTime(2000);

      expect(store.listErrors(taskId, { resolved: false })).toHaveLength(0);
      expect(store.listErrors(taskId, { resolved: true })).toHaveLength(1);
    });

    it('ignores non-error severities (warnings, hints)', () => {
      const filePath = path.join(root, 'src', 'warn.ts');
      const uriStr = `file://${filePath}`;
      diagnosticsByUri.set(uriStr, [{ severity: 1, message: 'unused var', range: { start: { line: 0, character: 0 } } }]);

      diagnosticsChangeHandler!({ uris: [{ scheme: 'file', fsPath: filePath, toString: () => uriStr }] });
      vi.advanceTimersByTime(2000);

      expect(store.listErrors(taskId)).toHaveLength(0);
    });

    it('creates a micro checkpoint when a new error diagnostic is recorded', () => {
      const filePath = path.join(root, 'src', 'broken.ts');
      const uriStr = `file://${filePath}`;
      diagnosticsByUri.set(uriStr, [
        { severity: 0, message: "Cannot find name 'bar'", range: { start: { line: 1, character: 0 } } },
      ]);

      diagnosticsChangeHandler!({ uris: [{ scheme: 'file', fsPath: filePath, toString: () => uriStr }] });
      vi.advanceTimersByTime(2000);

      const checkpoints = store.listCheckpoints(taskId);
      expect(checkpoints.length).toBeGreaterThanOrEqual(1);
      expect(checkpoints[0].summary).toContain('New error');
    });
  });

  describe('idle checkpoint polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('creates a micro checkpoint once a workspace has gone idle with untouched-since file activity', () => {
      savedDocHandler!({ uri: { scheme: 'file', fsPath: path.join(root, 'src', 'idle.ts') } });
      // The file-save handler itself may create a checkpoint if the
      // file-activity threshold happens to be hit; clear the slate so this
      // test only asserts on the idle-specific checkpoint.
      const before = store.listCheckpoints(taskId).length;

      // Idle poll runs every IDLE_CHECK_INTERVAL_MS (2 minutes); advance past
      // the default 10-minute idle threshold across several poll ticks.
      vi.advanceTimersByTime(11 * 60_000);

      const after = store.listCheckpoints(taskId);
      expect(after.length).toBeGreaterThan(before);
      expect(after[0].summary).toContain('idle');
    });
  });

  describe('git branch-mismatch guardrail', () => {
    let onDidChange: (() => void) | undefined;
    let headState: { commit?: string; name?: string };

    beforeEach(async () => {
      // Track the task's branch as 'main' up front, mirroring what
      // registerGitCommitCapture would have recorded from an earlier
      // checkout, so switching to a different branch below is a genuine
      // mismatch rather than the task's first-ever branch assignment.
      store.updateTaskBranch(taskId, 'main');
      headState = { commit: 'abc123', name: 'main' };
      gitApi = {
        repositories: [
          {
            rootUri: { fsPath: root },
            state: {
              get HEAD() {
                return headState;
              },
              onDidChange: (fn: () => void) => {
                onDidChange = fn;
                return { dispose: () => {} };
              },
            },
            log: async () => [{ message: 'a commit' }],
          },
        ],
        onDidOpenRepository: () => ({ dispose: () => {} }),
      };

      vi.resetModules();
      savedDocHandler = undefined;
      terminalHandler = undefined;
      diagnosticsChangeHandler = undefined;
      const { registerPassiveCapture } = await import('../src/passiveCapture.js');
      registerPassiveCapture(context as never, output as never);
    });

    it('warns when the checked-out branch no longer matches the task\'s tracked branch', async () => {
      headState = { commit: 'def456', name: 'feature/other' };
      onDidChange!();
      // The onDidChange handler is async; flush microtasks.
      await Promise.resolve();
      await Promise.resolve();

      expect(warningMessages).toHaveLength(1);
      expect(warningMessages[0]).toContain('feature/other');
      expect(store.getTask(taskId)?.branch).toBe('feature/other');
    });

    it('does not warn when the branch is unchanged', async () => {
      headState = { commit: 'def456', name: 'main' };
      onDidChange!();
      await Promise.resolve();
      await Promise.resolve();

      expect(warningMessages).toHaveLength(0);
    });
  });
});
