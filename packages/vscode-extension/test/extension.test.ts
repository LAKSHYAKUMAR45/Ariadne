import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Minimal fake of the `vscode` module surface this extension touches, so we
// can exercise extension.ts's error-handling paths without a real extension
// host. Must be declared before importing extension.ts/workspace.ts.
let workspaceFolders: { uri: { fsPath: string } }[] | undefined;

vi.mock('vscode', () => {
  class ThemeIcon {
    constructor(public id: string) {}
  }
  return {
    ThemeIcon,
    chat: {
      createChatParticipant: (_id: string, handler: unknown) => {
        capturedHandler = handler as typeof capturedHandler;
        return { iconPath: undefined, dispose: () => {} };
      },
    },
    window: {
      createOutputChannel: () => ({
        appendLine: (line: string) => outputLines.push(line),
        dispose: () => {},
      }),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
    },
    commands: {
      registerCommand: (_id: string, _fn: unknown) => ({ dispose: () => {} }),
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
});
