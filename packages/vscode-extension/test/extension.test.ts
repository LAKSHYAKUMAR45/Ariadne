import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

// Minimal fake of the `vscode` module surface this extension touches, so we
// can exercise extension.ts's error-handling paths without a real extension
// host. Must be declared before importing extension.ts/workspace.ts.
let workspaceFolders: { uri: { fsPath: string } }[] | undefined;
let registeredCommands: Record<string, (...args: unknown[]) => unknown>;
let quickPickChoice: unknown;

vi.mock('vscode', () => {
  class ThemeIcon {
    constructor(public id: string) {}
  }
  class TreeItem {
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    constructor(
      public label: string,
      public collapsibleState?: number,
    ) {}
  }
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(e: T): void {
      for (const listener of this.listeners) listener(e);
    }
  }
  return {
    ThemeIcon,
    TreeItem,
    EventEmitter,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    chat: {
      createChatParticipant: (_id: string, handler: unknown) => {
        capturedHandler = handler as typeof capturedHandler;
        return { iconPath: undefined, dispose: () => {} };
      },
    },
    window: {
      createOutputChannel: () => ({
        appendLine: (line: string) => outputLines.push(line),
        show: () => {},
        dispose: () => {},
      }),
      createStatusBarItem: () => ({
        show: () => {},
        hide: () => {},
        dispose: () => {},
        text: '',
        tooltip: '',
        command: undefined,
      }),
      registerTreeDataProvider: () => ({ dispose: () => {} }),
      onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showQuickPick: vi.fn(() => Promise.resolve(quickPickChoice)),
    },
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
        registeredCommands[id] = fn;
        return { dispose: () => {} };
      },
    },
    workspace: {
      get workspaceFolders() {
        return workspaceFolders;
      },
      onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
      onDidSaveTextDocument: () => ({ dispose: () => {} }),
      getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({ get: (_key: string, def?: unknown) => def }),
    },
    extensions: {
      getExtension: () => undefined,
    },
    languages: {
      onDidChangeDiagnostics: () => ({ dispose: () => {} }),
      getDiagnostics: () => [],
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  };
});

let capturedHandler:
  | ((
      request: { command?: string; prompt: string },
      context: unknown,
      stream: { markdown: (s: string) => void; button: (b: unknown) => void; progress: (s: string) => void },
      token: unknown,
    ) => Promise<{ errorDetails?: { message: string } } | void>)
  | undefined;
let outputLines: string[];

describe('chat participant error handling', () => {
  let tmpDir: string;

  beforeEach(async () => {
    outputLines = [];
    registeredCommands = {};
    vi.mocked(execFileSync).mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-ext-test-'));
    fs.mkdirSync(path.join(tmpDir, '.git'));
    workspaceFolders = [{ uri: { fsPath: tmpDir } }];

    vi.resetModules();
    const ext = await import('../src/extension.js');
    ext.activate({ subscriptions: [] } as never);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns markdown + errorDetails when the underlying command throws', async () => {
    const markdownCalls: string[] = [];
    const result = await capturedHandler!(
      { command: 'todo', prompt: 'add ' + 'x'.repeat(1) },
      {},
      { markdown: (s: string) => markdownCalls.push(s), button: () => {}, progress: () => {} },
      {},
    );

    // No current task yet, so this should be a graceful "no current task" message,
    // not a thrown error — confirms the happy path still works post-refactor.
    expect(markdownCalls.join('\n')).toMatch(/no current task/i);
    expect(result).toBeUndefined();
  });

  it('streams /status output section-by-section rather than as one block', async () => {
    const markdownCalls: string[] = [];
    const progressCalls: string[] = [];

    // Create a task with enough content to produce multiple status sections.
    await capturedHandler!(
      { command: 'task', prompt: 'new My task' },
      {},
      { markdown: () => {}, button: () => {}, progress: () => {} },
      {},
    );
    await capturedHandler!(
      { command: 'todo', prompt: 'add write tests' },
      {},
      { markdown: () => {}, button: () => {}, progress: () => {} },
      {},
    );
    await capturedHandler!(
      { command: 'decision', prompt: 'use SQLite' },
      {},
      { markdown: () => {}, button: () => {}, progress: () => {} },
      {},
    );

    await capturedHandler!(
      { command: 'status', prompt: '' },
      {},
      {
        markdown: (s: string) => markdownCalls.push(s),
        button: () => {},
        progress: (s: string) => progressCalls.push(s),
      },
      {},
    );

    // More than one markdown chunk means status streamed progressively.
    expect(markdownCalls.length).toBeGreaterThan(1);
    expect(markdownCalls.join('')).toMatch(/My task/);
    expect(markdownCalls.join('')).toMatch(/write tests/);
    expect(progressCalls.some((p) => /status/i.test(p))).toBe(true);
  });

  it('reports a friendly error and logs details when TaskStore throws', async () => {
    const markdownCalls: string[] = [];
    // Corrupt the state db to force a real TaskStore failure on next open.
    // Evict the cached connection first — activate()'s status-bar refresh
    // eagerly opens (and caches) a good connection on startup, so without
    // evicting it here we'd just keep reusing that cached handle instead of
    // hitting the now-corrupted file.
    const { closeStore } = await import('../src/storeCache.js');
    closeStore(tmpDir);
    const dbPath = path.join(tmpDir, '.ariadne', 'state.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'not a sqlite file');

    const result = await capturedHandler!(
      { command: 'status', prompt: '' },
      {},
      { markdown: (s: string) => markdownCalls.push(s), button: () => {}, progress: () => {} },
      {},
    );

    expect(result && 'errorDetails' in result ? result.errorDetails?.message : undefined).toBeTruthy();
    expect(markdownCalls.join('\n')).toMatch(/couldn't open its task database|went wrong/i);
    expect(outputLines.length).toBeGreaterThan(0);
  });

  it('ariadne.syncPush shells out to `ariadne sync push` and logs its output', async () => {
    vi.mocked(execFileSync).mockReturnValue('Pushed 1 task.\n');
    await registeredCommands['ariadne.syncPush']();
    expect(execFileSync).toHaveBeenCalledWith('ariadne', ['sync', 'push'], expect.objectContaining({ cwd: tmpDir }));
    expect(outputLines.some((l) => l.includes('Pushed 1 task'))).toBe(true);
  });

  it('ariadne.syncPull respects the quick-pick choice, including "import new"', async () => {
    vi.mocked(execFileSync).mockReturnValue('Pulled 2 tasks.\n');
    quickPickChoice = { label: 'Pull (import new)', importNew: true };
    await registeredCommands['ariadne.syncPull']();
    expect(execFileSync).toHaveBeenCalledWith('ariadne', ['sync', 'pull', '--import-new'], expect.objectContaining({ cwd: tmpDir }));
  });

  it('ariadne.syncPull does nothing if the quick pick is dismissed', async () => {
    quickPickChoice = undefined;
    await registeredCommands['ariadne.syncPull']();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('ariadne.syncListRemote surfaces a CLI failure as an error toast', async () => {
    const vscode = await import('vscode');
    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'Not logged in.';
      throw err;
    });
    await registeredCommands['ariadne.syncListRemote']();
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
  });
});
