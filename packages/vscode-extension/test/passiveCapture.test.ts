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
let folders: { uri: { fsPath: string } }[] = [];

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
    },
    extensions: {
      getExtension: () => undefined,
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
    savedDocHandler = undefined;
    terminalHandler = undefined;

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-passive-'));
    fs.mkdirSync(path.join(root, '.git'));
    folders = [{ uri: { fsPath: root } }];

    store = openWorkspaceStore(root);
    const task = store.createTask({ title: 'Passive capture task' });
    taskId = task.id;
    setCurrentTaskId(task.id, root);

    context = { subscriptions: [] };
    output = { appendLine: () => {} };

    const { registerPassiveCapture } = await import('../src/passiveCapture.js');
    registerPassiveCapture(context as never, output as never);
  });

  afterEach(() => {
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
});
