import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskStore } from '@ariadne-dev/core';
import { setCurrentTaskId } from '../src/workspace.js';

// Mocks only the graphify bits of @ariadne-dev/core (spreads the real module
// for everything else, including TaskStore) so `graphifyRun` can be tested
// without a real `graphify` binary on PATH.
const { isGraphifyInstalledMock, runGraphifyMock } = vi.hoisted(() => ({
  isGraphifyInstalledMock: vi.fn(),
  runGraphifyMock: vi.fn(),
}));

vi.mock('@ariadne-dev/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ariadne-dev/core')>();
  return {
    ...actual,
    isGraphifyInstalled: isGraphifyInstalledMock,
    runGraphify: runGraphifyMock,
  };
});

describe('mcp-server graphify tool', () => {
  let store: TaskStore;
  let workspaceRoot: string;

  beforeEach(async () => {
    store = new TaskStore(':memory:');
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-mcp-graphify-test-'));
    isGraphifyInstalledMock.mockReset();
    runGraphifyMock.mockReset();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('forwards args to graphify and returns its output', async () => {
    const tools = await import('../src/tools.js');
    isGraphifyInstalledMock.mockReturnValue(true);
    runGraphifyMock.mockResolvedValue({ exitCode: 0, stdout: 'Node: Foo\n', stderr: '' });

    const result = await tools.graphifyRun(store, workspaceRoot, { args: ['explain', 'Foo'] });

    expect(runGraphifyMock).toHaveBeenCalledWith(['explain', 'Foo'], { cwd: workspaceRoot, mode: 'capture' });
    expect(result).toEqual({ exitCode: 0, stdout: 'Node: Foo\n', stderr: '' });
  });

  it('logs a checkpoint against the current task when one is set', async () => {
    const tools = await import('../src/tools.js');
    const task = store.createTask({ title: 'Graphify MCP test' });
    setCurrentTaskId(task.id, workspaceRoot);

    isGraphifyInstalledMock.mockReturnValue(true);
    runGraphifyMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await tools.graphifyRun(store, workspaceRoot, { args: ['update', '.'] });

    const checkpoints = store.listCheckpoints(task.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].summary).toContain('graphify update .');
  });

  it('does not throw when there is no current task (skips checkpoint logging)', async () => {
    const tools = await import('../src/tools.js');
    isGraphifyInstalledMock.mockReturnValue(true);
    runGraphifyMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await expect(tools.graphifyRun(store, workspaceRoot, { args: ['update', '.'] })).resolves.toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('throws a clear install hint when graphify is not installed, without invoking it', async () => {
    const tools = await import('../src/tools.js');
    isGraphifyInstalledMock.mockReturnValue(false);

    await expect(tools.graphifyRun(store, workspaceRoot, { args: ['query', 'x'] })).rejects.toThrow(/graphifyy/);
    expect(runGraphifyMock).not.toHaveBeenCalled();
  });
});
