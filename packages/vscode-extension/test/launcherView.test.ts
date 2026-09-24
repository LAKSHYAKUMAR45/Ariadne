import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommand = vi.fn();
const showErrorMessage = vi.fn();

vi.mock('vscode', () => ({
  commands: { executeCommand },
  window: {
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    showErrorMessage,
  },
}));

describe('Ariadne launcher view', () => {
  beforeEach(() => {
    executeCommand.mockReset();
    showErrorMessage.mockReset();
  });

  async function createResolvedProvider(overrides: Partial<{ hasTask: boolean }> = {}) {
    const { AriadneLauncherViewProvider } = await import('../src/webview/launcherView.js');
    const hasTask = overrides.hasTask ?? true;
    const openContextInChat = vi.fn().mockResolvedValue(undefined);
    const openContextInCli = vi.fn().mockResolvedValue(undefined);
    const provider = new AriadneLauncherViewProvider({
      getCurrentTask: () =>
        hasTask
          ? ({ id: 't1', title: 'Ship it', status: 'active', branch: 'main', goal: 'Goal' } as never)
          : undefined,
      getWorkspaceRoot: () => '/repo',
      logError: (context: string, err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return message;
      },
      openContextInChat,
      openContextInCli,
    });

    let receiveMessage: ((message: unknown) => void) | undefined;
    const webviewView = {
      webview: {
        options: {},
        html: '',
        cspSource: 'vscode-resource:',
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receiveMessage = listener;
          return { dispose: () => {} };
        },
      },
    };
    provider.resolveWebviewView(webviewView as never);

    return { provider, webviewView, openContextInChat, openContextInCli, receiveMessage: () => receiveMessage };
  }

  it('renders enabled Copilot Chat/CLI buttons when a task is selected', async () => {
    const { webviewView } = await createResolvedProvider({ hasTask: true });
    expect(webviewView.webview.html).toContain('Open in Copilot Chat');
    expect(webviewView.webview.html).toContain('Open in Copilot CLI');
    expect(webviewView.webview.html).not.toMatch(/data-command="openInChat"[^>]*disabled/);
  });

  it('disables the Copilot Chat/CLI buttons when no task is selected', async () => {
    const { webviewView } = await createResolvedProvider({ hasTask: false });
    expect(webviewView.webview.html).toMatch(/data-command="openInChat"[^>]*disabled/);
    expect(webviewView.webview.html).toMatch(/data-command="openInCli"[^>]*disabled/);
  });

  it('delegates the openInChat command to the openContextInChat dependency', async () => {
    const { openContextInChat, receiveMessage } = await createResolvedProvider({ hasTask: true });
    await receiveMessage()?.({ command: 'openInChat' });
    expect(openContextInChat).toHaveBeenCalledTimes(1);
  });

  it('delegates the openInCli command to the openContextInCli dependency', async () => {
    const { openContextInCli, receiveMessage } = await createResolvedProvider({ hasTask: true });
    await receiveMessage()?.({ command: 'openInCli' });
    expect(openContextInCli).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error message when the Copilot Chat handoff fails', async () => {
    const { AriadneLauncherViewProvider } = await import('../src/webview/launcherView.js');
    const provider = new AriadneLauncherViewProvider({
      getCurrentTask: () => undefined,
      getWorkspaceRoot: () => '/repo',
      logError: (context: string, err: unknown) => (err instanceof Error ? err.message : String(err)),
      openContextInChat: vi.fn().mockRejectedValue(new Error('No current task is selected.')),
      openContextInCli: vi.fn().mockResolvedValue(undefined),
    });

    let receiveMessage: ((message: unknown) => void) | undefined;
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: '',
        cspSource: 'vscode-resource:',
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receiveMessage = listener;
          return { dispose: () => {} };
        },
      },
    } as never);

    await receiveMessage?.({ command: 'openInChat' });
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('No current task is selected.'));
  });
});
