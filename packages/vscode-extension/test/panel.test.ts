import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const buildWebviewState = vi.fn();
  const handleWebviewMessage = vi.fn();
  const createWebviewPanel = vi.fn();
  const openExportedMarkdown = vi.fn();
  const clipboardWriteText = vi.fn();
  const openTextDocument = vi.fn();
  const showTextDocument = vi.fn();
  const stat = vi.fn();
  const isGraphifyInstalled = vi.fn();
  const runGraphifySync = vi.fn();
  const summarizeGraphifyRun = vi.fn();
  return {
    buildWebviewState,
    handleWebviewMessage,
    createWebviewPanel,
    openExportedMarkdown,
    clipboardWriteText,
    openTextDocument,
    showTextDocument,
    stat,
    isGraphifyInstalled,
    runGraphifySync,
    summarizeGraphifyRun,
  };
});

let receiveMessage: ((message: unknown) => void) | undefined;
let postedMessages: unknown[];
let revealMock: ReturnType<typeof vi.fn>;
let outputLines: string[];

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

vi.mock('vscode', () => {
  const Uri = {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (...parts: Array<{ fsPath: string } | string>) => ({
      fsPath: parts
        .map((part) => (typeof part === 'string' ? part : part.fsPath))
        .join('/'),
    }),
  };

  return {
    Uri,
    ViewColumn: { One: 1 },
    extensions: {
      getExtension: () => undefined,
    },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, defaultValue: boolean) => defaultValue,
      }),
      openTextDocument: (...args: unknown[]) => mocks.openTextDocument(...args),
      fs: {
        stat: (...args: unknown[]) => mocks.stat(...args),
      },
    },
    env: {
      clipboard: {
        writeText: (...args: unknown[]) => mocks.clipboardWriteText(...args),
      },
    },
    window: {
      createWebviewPanel: (...args: unknown[]) => mocks.createWebviewPanel(...args),
      showTextDocument: (...args: unknown[]) => mocks.showTextDocument(...args),
    },
  };
});

vi.mock('../src/webview/handleWebviewMessage.js', () => ({
  buildWebviewState: mocks.buildWebviewState,
  handleWebviewMessage: mocks.handleWebviewMessage,
  WebviewRequestTypes: { ExportMarkdown: 'export.markdown' },
}));

vi.mock('@ariadne-dev/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ariadne-dev/core')>();
  return {
    ...actual,
    isGraphifyInstalled: mocks.isGraphifyInstalled,
    runGraphifySync: mocks.runGraphifySync,
    summarizeGraphifyRun: mocks.summarizeGraphifyRun,
  };
});

function makePanel() {
  const webview = {
    cspSource: 'vscode-webview://test',
    html: '',
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `vscode-resource:${uri.fsPath}` }),
    postMessage: vi.fn((message: unknown) => {
      postedMessages.push(message);
      return Promise.resolve(true);
    }),
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      receiveMessage = listener;
      return { dispose: () => {} };
    },
    receiveMessage: async (message: unknown) => {
      receiveMessage?.(message);
      await flush();
    },
  };

  revealMock = vi.fn();
  return {
    webview,
    reveal: revealMock,
    onDidDispose: () => ({ dispose: () => {} }),
    dispose: () => {},
  };
}

async function loadPanelModule() {
  return import('../src/webview/panel.js');
}

async function openPanelForTest(options?: { workspaceRoot?: string }) {
  const { openAriadnePanel } = await loadPanelModule();
  const vscode = await import('vscode');

  const deps = {
    openStoreForCurrentWorkspace: () => ({}) as never,
    getCurrentTaskId: () => 'task-1',
    setCurrentTask: () => {},
    setCurrentTaskInWorkspace: () => {},
    resolveWorkspaceRoot: () => options?.workspaceRoot,
    output: { appendLine: (line: string) => outputLines.push(line) } as never,
    logError: (_context: string, err: unknown) => (err instanceof Error ? err.message : String(err)),
    refreshHost: () => {},
    openExportedMarkdown: mocks.openExportedMarkdown,
  } as never;

  openAriadnePanel({ extensionUri: { fsPath: '/extension' } } as never, deps);

  return {
    panel: mocks.createWebviewPanel.mock.results[0]?.value,
    postedMessages,
    vscode,
  };
}

describe('Ariadne webview panel', () => {
  beforeEach(() => {
    postedMessages = [];
    outputLines = [];
    receiveMessage = undefined;
    revealMock = vi.fn();
    mocks.buildWebviewState.mockReset();
    mocks.handleWebviewMessage.mockReset();
    mocks.createWebviewPanel.mockReset();
    mocks.openExportedMarkdown.mockReset();
    mocks.clipboardWriteText.mockReset();
    mocks.openTextDocument.mockReset();
    mocks.showTextDocument.mockReset();
    mocks.stat.mockReset();
    mocks.isGraphifyInstalled.mockReset();
    mocks.runGraphifySync.mockReset();
    mocks.summarizeGraphifyRun.mockReset();
    mocks.buildWebviewState.mockReturnValue({
      workspaceRoot: '/workspace',
      currentTaskId: 'task-1',
      currentTask: undefined,
      tasks: [],
      checkpoints: [],
      todos: [],
      decisions: [],
      errors: [],
      questions: [],
      fileCaptures: [],
      searchResults: [],
      counts: { pendingTodos: 0, unresolvedErrors: 0, openQuestions: 0 },
    });
    mocks.createWebviewPanel.mockImplementation(() => makePanel());
    mocks.openTextDocument.mockResolvedValue({ uri: { fsPath: '/preview.md' } });
    mocks.showTextDocument.mockResolvedValue(undefined);
    mocks.stat.mockResolvedValue({ type: 1 });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('reuses the singleton panel and reveals it on subsequent opens', async () => {
    const { openAriadnePanel } = await loadPanelModule();

    const deps = {
      openStoreForCurrentWorkspace: () => undefined,
      getCurrentTaskId: () => undefined,
      setCurrentTask: () => {},
      setCurrentTaskInWorkspace: () => {},
      resolveWorkspaceRoot: () => '/workspace',
      output: { appendLine: (line: string) => outputLines.push(line) } as never,
      logError: (_context: string, err: unknown) => String(err),
      refreshHost: () => {},
      openExportedMarkdown: mocks.openExportedMarkdown,
      copyText: vi.fn(),
      openMarkdown: vi.fn(),
    };

    openAriadnePanel({ extensionUri: { fsPath: '/extension' } } as never, deps);
    openAriadnePanel({ extensionUri: { fsPath: '/extension' } } as never, deps);

    expect(mocks.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(revealMock).toHaveBeenCalledTimes(1);
  });

  it('posts an error response when request handling throws', async () => {
    const { openAriadnePanel } = await loadPanelModule();

    const deps = {
      openStoreForCurrentWorkspace: () => ({}) as never,
      getCurrentTaskId: () => 'task-1',
      setCurrentTask: () => {},
      setCurrentTaskInWorkspace: () => {},
      resolveWorkspaceRoot: () => '/workspace',
      output: { appendLine: (line: string) => outputLines.push(line) } as never,
      logError: (_context: string, err: unknown) => (err instanceof Error ? err.message : String(err)),
      refreshHost: () => {},
      openExportedMarkdown: mocks.openExportedMarkdown,
      copyText: vi.fn(),
      openMarkdown: vi.fn(),
    };

    mocks.handleWebviewMessage.mockImplementation(() => {
      throw new Error('boom');
    });

    openAriadnePanel({ extensionUri: { fsPath: '/extension' } } as never, deps);
    receiveMessage?.({ id: 'req-1', type: 'todo.create', payload: { text: 'Add bridge' } });
    await flush();

    expect(postedMessages).toContainEqual({ id: 'req-1', ok: false, error: 'boom' });
  });

  it('opens exported markdown for successful export responses even without state', async () => {
    const { openAriadnePanel } = await loadPanelModule();

    const deps = {
      openStoreForCurrentWorkspace: () => ({}) as never,
      getCurrentTaskId: () => 'task-1',
      setCurrentTask: () => {},
      setCurrentTaskInWorkspace: () => {},
      resolveWorkspaceRoot: () => '/workspace',
      output: { appendLine: (line: string) => outputLines.push(line) } as never,
      logError: (_context: string, err: unknown) => (err instanceof Error ? err.message : String(err)),
      refreshHost: () => {},
      openExportedMarkdown: mocks.openExportedMarkdown,
      copyText: vi.fn(),
      openMarkdown: vi.fn(),
    };

    mocks.handleWebviewMessage.mockReturnValue({
      id: 'export-1',
      ok: true,
      data: { path: '/workspace/.ariadne/export/task-1.md' },
    });

    openAriadnePanel({ extensionUri: { fsPath: '/extension' } } as never, deps);
    receiveMessage?.({ id: 'export-1', type: 'export.markdown' });
    await flush();

    expect(mocks.openExportedMarkdown).toHaveBeenCalledWith('/workspace/.ariadne/export/task-1.md');
    expect(postedMessages).toContainEqual({ id: 'export-1', ok: true, data: { path: '/workspace/.ariadne/export/task-1.md' } });
  });

  it('posts the dispatcher response state instead of recomputing current workspace state', async () => {
    const { openAriadnePanel } = await loadPanelModule();

    const responseState = {
      workspaceRoot: '/other-workspace',
      currentTaskId: 'task-2',
      currentTask: undefined,
      tasks: [],
      checkpoints: [],
      todos: [],
      decisions: [],
      errors: [],
      questions: [],
      fileCaptures: [],
      searchResults: [],
      counts: { pendingTodos: 0, unresolvedErrors: 0, openQuestions: 0 },
    };

    const deps = {
      openStoreForCurrentWorkspace: () => ({}) as never,
      getCurrentTaskId: () => 'task-1',
      setCurrentTask: () => {},
      setCurrentTaskInWorkspace: () => {},
      resolveWorkspaceRoot: () => '/workspace',
      output: { appendLine: (line: string) => outputLines.push(line) } as never,
      logError: (_context: string, err: unknown) => (err instanceof Error ? err.message : String(err)),
      refreshHost: () => {},
      openExportedMarkdown: mocks.openExportedMarkdown,
      copyText: vi.fn(),
      openMarkdown: vi.fn(),
    };

    mocks.handleWebviewMessage.mockReturnValue({
      id: 'switch-1',
      ok: true,
      data: { currentTaskId: 'task-2' },
      state: responseState,
    });

    openAriadnePanel({ extensionUri: { fsPath: '/extension' } } as never, deps);
    receiveMessage?.({ id: 'switch-1', type: 'task.switch', payload: { id: 'task-2' } });
    await flush();

    expect(postedMessages).toContainEqual({ type: 'stateUpdate', state: responseState });
  });

  it('posts state updates for error responses that still include refreshed state', async () => {
    const refreshHost = vi.fn();
    const responseState = {
      workspaceRoot: '/workspace',
      currentTaskId: 'task-partial',
      currentTask: { id: 'task-partial', title: 'Broken seed' },
      tasks: [],
      checkpoints: [],
      todos: [],
      decisions: [],
      errors: [],
      questions: [],
      fileCaptures: [],
      searchResults: [],
      counts: { pendingTodos: 0, unresolvedErrors: 0, openQuestions: 0 },
    };

    const { openAriadnePanel } = await loadPanelModule();
    const deps = {
      openStoreForCurrentWorkspace: () => ({}) as never,
      getCurrentTaskId: () => 'task-1',
      setCurrentTask: () => {},
      setCurrentTaskInWorkspace: () => {},
      resolveWorkspaceRoot: () => '/workspace',
      output: { appendLine: (line: string) => outputLines.push(line) } as never,
      logError: (_context: string, err: unknown) => (err instanceof Error ? err.message : String(err)),
      refreshHost,
      openExportedMarkdown: mocks.openExportedMarkdown,
      copyText: vi.fn(),
      openMarkdown: vi.fn(),
    };

    mocks.handleWebviewMessage.mockReturnValue({
      id: 'template-fail',
      ok: false,
      error: 'Task was created but template seeding failed: seed write failed',
      state: responseState,
    });

    openAriadnePanel({ extensionUri: { fsPath: '/extension' } } as never, deps);
    receiveMessage?.({ id: 'template-fail', type: 'task.createFromTemplate', payload: { title: 'Broken seed', templateId: 'feature' } });
    await flush();

    expect(postedMessages).toContainEqual({
      id: 'template-fail',
      ok: false,
      error: 'Task was created but template seeding failed: seed write failed',
      state: responseState,
    });
    expect(postedMessages).toContainEqual({ type: 'stateUpdate', state: responseState });
    expect(refreshHost).toHaveBeenCalledTimes(1);
  });

  it('refreshAriadnePanel posts the current workspace state', async () => {
    const { openAriadnePanel, refreshAriadnePanel } = await loadPanelModule();

    const refreshedState = {
      workspaceRoot: '/workspace',
      currentTaskId: 'task-refreshed',
      currentTask: undefined,
      tasks: [],
      checkpoints: [],
      todos: [],
      decisions: [],
      errors: [],
      questions: [],
      fileCaptures: [],
      searchResults: [],
      counts: { pendingTodos: 0, unresolvedErrors: 0, openQuestions: 0 },
    };

    const deps = {
      openStoreForCurrentWorkspace: () => ({}) as never,
      getCurrentTaskId: () => 'task-refreshed',
      setCurrentTask: () => {},
      setCurrentTaskInWorkspace: () => {},
      resolveWorkspaceRoot: () => '/workspace',
      output: { appendLine: (line: string) => outputLines.push(line) } as never,
      logError: (_context: string, err: unknown) => (err instanceof Error ? err.message : String(err)),
      refreshHost: () => {},
      openExportedMarkdown: mocks.openExportedMarkdown,
      copyText: vi.fn(),
      openMarkdown: vi.fn(),
    };

    openAriadnePanel({ extensionUri: { fsPath: '/extension' } } as never, deps);
    postedMessages = [];
    mocks.buildWebviewState.mockReturnValue(refreshedState);

    refreshAriadnePanel();

    expect(postedMessages).toContainEqual({ type: 'stateUpdate', state: refreshedState });
  });

  it('copies context markdown through the VS Code clipboard adapter', async () => {
    mocks.handleWebviewMessage.mockImplementation(async (deps: { copyText?: (text: string) => Promise<void> }, message: { id: string; type: string; payload?: { markdown?: string } }) => {
      if (message.type === 'context.copy') {
        await deps.copyText?.(message.payload?.markdown ?? '');
        return { id: message.id, ok: true, data: { copied: true } };
      }
      return { id: message.id, ok: true, data: {} };
    });

    const { panel, postedMessages: messages } = await openPanelForTest();

    await panel.webview.receiveMessage({
      id: 'copy-1',
      type: 'context.copy',
      payload: { markdown: '# Handoff' },
    });

    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('# Handoff');
    expect(messages).toContainEqual(expect.objectContaining({ id: 'copy-1', ok: true }));
  });

  it('opens context markdown through the VS Code markdown preview adapter', async () => {
    mocks.handleWebviewMessage.mockImplementation(
      async (
        deps: { openMarkdown?: (title: string, markdown: string) => Promise<void> },
        message: { id: string; type: string; payload?: { markdown?: string } },
      ) => {
        if (message.type === 'context.open') {
          await deps.openMarkdown?.('Ariadne Context Preview', message.payload?.markdown ?? '');
          return { id: message.id, ok: true, data: { opened: true } };
        }
        return { id: message.id, ok: true, data: {} };
      },
    );

    const { panel, postedMessages: messages } = await openPanelForTest();

    await panel.webview.receiveMessage({
      id: 'open-context-1',
      type: 'context.open',
      payload: { markdown: '# Preview' },
    });

    expect(mocks.openTextDocument).toHaveBeenCalledWith({ language: 'markdown', content: '# Preview' });
    expect(mocks.showTextDocument).toHaveBeenCalledWith(expect.objectContaining({ uri: { fsPath: '/preview.md' } }), { preview: true });
    expect(messages).toContainEqual(expect.objectContaining({ id: 'open-context-1', ok: true }));
  });

  it('opens a captured workspace file by relative path', async () => {
    mocks.handleWebviewMessage.mockImplementation(
      async (
        deps: { openWorkspaceFile?: (relativePath: string) => Promise<void> },
        message: { id: string; type: string; payload?: { path?: string } },
      ) => {
        if (message.type === 'file.open') {
          await deps.openWorkspaceFile?.(message.payload?.path ?? '');
          return { id: message.id, ok: true, data: { opened: true } };
        }
        return { id: message.id, ok: true, data: {} };
      },
    );

    const { panel } = await openPanelForTest({ workspaceRoot: '/repo' });

    await panel.webview.receiveMessage({
      id: 'open-file-1',
      type: 'file.open',
      payload: { path: 'src/App.tsx' },
    });

    expect(mocks.showTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: '/repo/src/App.tsx' }), { preview: true });
  });

  it('returns the standard bridge error response when opening a missing workspace file fails', async () => {
    mocks.handleWebviewMessage.mockImplementation(
      async (
        deps: { openWorkspaceFile?: (relativePath: string) => Promise<void> },
        message: { id: string; type: string; payload?: { path?: string } },
      ) => {
        if (message.type === 'file.open') {
          await deps.openWorkspaceFile?.(message.payload?.path ?? '');
          return { id: message.id, ok: true, data: { opened: true } };
        }
        return { id: message.id, ok: true, data: {} };
      },
    );
    mocks.stat.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, stat '/repo/src/Missing.tsx'"));

    const { panel, postedMessages: messages } = await openPanelForTest({ workspaceRoot: '/repo' });

    await panel.webview.receiveMessage({
      id: 'open-file-missing-disk',
      type: 'file.open',
      payload: { path: 'src/Missing.tsx' },
    });

    expect(mocks.showTextDocument).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      id: 'open-file-missing-disk',
      ok: false,
      error: "ENOENT: no such file or directory, stat '/repo/src/Missing.tsx'",
    });
  });

  it('returns the graphify install hint when the CLI is unavailable', async () => {
    mocks.isGraphifyInstalled.mockReturnValue(false);
    mocks.handleWebviewMessage.mockImplementation(
      (deps: { graphify?: { run: (payload: unknown, workspaceRoot?: string) => unknown } }, message: { id: string; type: string; payload?: unknown }) => {
        if (message.type === 'graphify.run') {
          return { id: message.id, ok: true, data: { result: deps.graphify?.run(message.payload, '/repo') } };
        }
        return { id: message.id, ok: true, data: {} };
      },
    );

    const { panel, postedMessages: messages } = await openPanelForTest({ workspaceRoot: '/repo' });

    await panel.webview.receiveMessage({
      id: 'graphify-missing',
      type: 'graphify.run',
      payload: { mode: 'query', query: 'how does auth work' },
    });

    expect(mocks.runGraphifySync).not.toHaveBeenCalled();
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: 'graphify-missing',
        ok: true,
        data: {
          result: expect.objectContaining({
            available: false,
            args: [],
            exitCode: 127,
            truncated: false,
          }),
        },
      }),
    );
  });

  it('runs graphify through the host adapter and truncates panel output', async () => {
    const longOutput = `${'A'.repeat(20_050)}\nsecond line`;
    mocks.isGraphifyInstalled.mockReturnValue(true);
    mocks.runGraphifySync.mockReturnValue({ exitCode: 0, stdout: longOutput, stderr: '' });
    mocks.summarizeGraphifyRun.mockReturnValue('Graphify query completed');
    mocks.handleWebviewMessage.mockImplementation(
      (deps: { graphify?: { run: (payload: unknown, workspaceRoot?: string) => unknown } }, message: { id: string; type: string; payload?: unknown }) => {
        if (message.type === 'graphify.run') {
          return { id: message.id, ok: true, data: { result: deps.graphify?.run(message.payload, '/repo') } };
        }
        return { id: message.id, ok: true, data: {} };
      },
    );

    const { panel, postedMessages: messages } = await openPanelForTest({ workspaceRoot: '/repo' });

    await panel.webview.receiveMessage({
      id: 'graphify-run',
      type: 'graphify.run',
      payload: { mode: 'query', query: 'how does auth work' },
    });

    expect(mocks.runGraphifySync).toHaveBeenCalledWith(['query', 'how does auth work'], { cwd: '/repo' });
    expect(outputLines.some((line) => line.includes(longOutput))).toBe(true);
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: 'graphify-run',
        ok: true,
        data: {
          result: expect.objectContaining({
            available: true,
            args: ['query', 'how does auth work'],
            exitCode: 0,
            truncated: true,
            checkpointSummary: 'Graphify query completed',
            output: expect.stringContaining('[truncated for panel view]'),
          }),
        },
      }),
    );
  });

  it('rejects invalid or missing captured file paths before opening', async () => {
    mocks.handleWebviewMessage.mockImplementation(
      async (
        deps: { openWorkspaceFile?: (relativePath: string) => Promise<void> },
        message: { id: string; type: string; payload?: { path?: string } },
      ) => {
        if (message.type === 'file.open') {
          const filePath = message.payload?.path;
          if (!filePath || filePath.startsWith('../')) {
            return {
              id: message.id,
              ok: false,
              error: 'file.open requires a workspace-relative path.',
            };
          }
          await deps.openWorkspaceFile?.(filePath);
          return { id: message.id, ok: true, data: { opened: true } };
        }
        return { id: message.id, ok: true, data: {} };
      },
    );

    const { panel, postedMessages: messages } = await openPanelForTest({ workspaceRoot: '/repo' });

    await panel.webview.receiveMessage({
      id: 'open-file-invalid',
      type: 'file.open',
      payload: { path: '../secret.txt' },
    });
    await panel.webview.receiveMessage({
      id: 'open-file-missing',
      type: 'file.open',
      payload: {},
    });

    expect(mocks.showTextDocument).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      id: 'open-file-invalid',
      ok: false,
      error: 'file.open requires a workspace-relative path.',
    });
    expect(messages).toContainEqual({
      id: 'open-file-missing',
      ok: false,
      error: 'file.open requires a workspace-relative path.',
    });
  });
});
