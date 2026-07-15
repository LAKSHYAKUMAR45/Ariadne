import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskStore } from '@ariadne-dev/core';

// Mocks only the graphify bits of @ariadne-dev/core (spreads the real
// module for everything else, including TaskStore) so `/graphify` can be
// exercised without a real `graphify` binary on PATH.
const { isGraphifyInstalledMock, runGraphifySyncMock } = vi.hoisted(() => ({
  isGraphifyInstalledMock: vi.fn(),
  runGraphifySyncMock: vi.fn(),
}));

vi.mock('@ariadne-dev/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ariadne-dev/core')>();
  return {
    ...actual,
    isGraphifyInstalled: isGraphifyInstalledMock,
    runGraphifySync: runGraphifySyncMock,
  };
});

describe('/graphify chat command', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-graphify-chat-'));
    store = new TaskStore(':memory:');
    isGraphifyInstalledMock.mockReset();
    runGraphifySyncMock.mockReset();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('shows a usage hint when no args are given', async () => {
    const { handleChatCommand } = await import('../src/commands.js');
    const result = handleChatCommand(store, { command: 'graphify', prompt: '', workspaceRoot: root });
    expect(result.markdown).toContain('Usage: `/graphify');
    expect(runGraphifySyncMock).not.toHaveBeenCalled();
  });

  it('shows the install hint and does not run anything when graphify is missing', async () => {
    const { handleChatCommand } = await import('../src/commands.js');
    isGraphifyInstalledMock.mockReturnValue(false);
    const result = handleChatCommand(store, { command: 'graphify', prompt: 'query x', workspaceRoot: root });
    expect(result.markdown).toContain('graphifyy');
    expect(runGraphifySyncMock).not.toHaveBeenCalled();
  });

  it('splits quoted args, runs graphify, and logs a checkpoint against the current task', async () => {
    const { handleChatCommand } = await import('../src/commands.js');
    const task = store.createTask({ title: 'Graphify chat test' });
    isGraphifyInstalledMock.mockReturnValue(true);
    runGraphifySyncMock.mockReturnValue({ exitCode: 0, stdout: 'Shortest path (2 hops)...\n', stderr: '' });

    const result = handleChatCommand(store, {
      command: 'graphify',
      prompt: 'path "Foo Bar" "Baz"',
      currentTaskId: task.id,
      workspaceRoot: root,
    });

    expect(runGraphifySyncMock).toHaveBeenCalledWith(['path', 'Foo Bar', 'Baz'], { cwd: root });
    expect(result.markdown).toContain('Shortest path (2 hops)');

    const checkpoints = store.listCheckpoints(task.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].summary).toContain('graphify path Foo Bar Baz');
  });

  it('reports a non-zero exit code without throwing', async () => {
    const { handleChatCommand } = await import('../src/commands.js');
    isGraphifyInstalledMock.mockReturnValue(true);
    runGraphifySyncMock.mockReturnValue({ exitCode: 2, stdout: '', stderr: 'no path found' });

    const result = handleChatCommand(store, { command: 'graphify', prompt: 'path A B', workspaceRoot: root });

    expect(result.markdown).toContain('no path found');
    expect(result.markdown).toContain('exited with code 2');
  });
});
