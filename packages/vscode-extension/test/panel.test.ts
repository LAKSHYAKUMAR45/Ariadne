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
  return {
    buildWebviewState,
    handleWebviewMessage,
    createWebviewPanel,
    openExportedMarkdown,
    clipboardWriteText,
    openTextDocument,
    showTextDocument,
    stat,
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
