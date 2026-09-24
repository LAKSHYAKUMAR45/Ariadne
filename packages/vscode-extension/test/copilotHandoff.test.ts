import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommand = vi.fn();
const sendText = vi.fn();
const showTerminal = vi.fn();
let lastCreatedTerminalName: string | undefined;
let terminalExitStatus: unknown;

vi.mock('node:fs', () => ({
  promises: {
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('vscode', () => ({
  commands: {
    executeCommand,
    registerCommand: () => ({ dispose: () => {} }),
  },
  window: {
    createTerminal: (name: string) => {
      lastCreatedTerminalName = name;
      return {
        show: showTerminal,
        sendText,
        get exitStatus() {
          return terminalExitStatus;
        },
      };
    },
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
  },
  chat: { createChatParticipant: () => ({ dispose: () => {} }) },
  workspace: {
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    onDidSaveTextDocument: () => ({ dispose: () => {} }),
    getConfiguration: () => ({ get: (_key: string, def?: unknown) => def }),
  },
  extensions: { getExtension: () => undefined },
  languages: { onDidChangeDiagnostics: () => ({ dispose: () => {} }), getDiagnostics: () => [] },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
}));

describe('Copilot Chat/CLI handoff', () => {
  beforeEach(() => {
    executeCommand.mockReset();
    sendText.mockReset();
    showTerminal.mockReset();
    lastCreatedTerminalName = undefined;
    terminalExitStatus = undefined;
  });

  it('sends the task context markdown as an auto-executed Copilot Chat query', async () => {
    const { openInCopilotChat } = await import('../src/extension.js');
    await openInCopilotChat('# Task Context\nGoal: ship it');

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.chat.open', {
      query: '# Task Context\nGoal: ship it',
    });
  });

  it('opens (or reuses) an integrated terminal and auto-sends a copilot CLI command', async () => {
    const { openInCopilotCli } = await import('../src/extension.js');
    await openInCopilotCli('# Task Context\nGoal: ship it');

    expect(lastCreatedTerminalName).toBe('Ariadne Copilot CLI');
    expect(showTerminal).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const [command, addNewLine] = sendText.mock.calls[0];
    expect(addNewLine).toBe(true);
    expect(command).toMatch(/^copilot -i "\$\(cat ".*\.md"\)"$/);

    // A second call while the terminal is still alive reuses it instead of
    // creating a new one.
    await openInCopilotCli('# More context');
    expect(sendText).toHaveBeenCalledTimes(2);
  });
});
