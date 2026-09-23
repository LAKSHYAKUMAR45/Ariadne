import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const buildWebviewState = vi.fn();
  const handleWebviewMessage = vi.fn();
  const createWebviewPanel = vi.fn();
  const openExportedMarkdown = vi.fn();
  return {
    buildWebviewState,
    handleWebviewMessage,
    createWebviewPanel,
    openExportedMarkdown,
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
    window: {
      createWebviewPanel: (...args: unknown[]) => mocks.createWebviewPanel(...args),
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
    };

    openAriadnePanel({ extensionUri: { fsPath: '/extension' } } as never, deps);
    postedMessages = [];
    mocks.buildWebviewState.mockReturnValue(refreshedState);

    refreshAriadnePanel();

    expect(postedMessages).toContainEqual({ type: 'stateUpdate', state: refreshedState });
  });
});
