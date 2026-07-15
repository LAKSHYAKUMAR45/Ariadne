import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openWorkspaceStore, setCurrentTaskId } from '@ariadne-dev/core';

const TEST_TMP_ROOT = path.join(process.cwd(), 'packages', 'cli', 'test', '.tmp-graphify');

function makeWorkspace(name: string): string {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const root = path.join(TEST_TMP_ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

// Mocks only the graphify bits of @ariadne-dev/core (spread the real module
// for everything else) so `ariadne graphify` can be exercised without a real
// `graphify` binary on PATH — mirrors sync.test.ts's approach for syncClient.
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

describe('ariadne graphify', () => {
  let originalCwd: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
    originalCwd = process.cwd();
    isGraphifyInstalledMock.mockReset();
    runGraphifyMock.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('forwards args to the graphify binary and logs a checkpoint against the current task on success', async () => {
    const root = makeWorkspace('success');
    process.chdir(root);
    const store = openWorkspaceStore(root);
    const task = store.createTask({ title: 'Graphify test' });
    setCurrentTaskId(task.id, root);
    store.close();

    isGraphifyInstalledMock.mockReturnValue(true);
    runGraphifyMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const { program } = await import('../src/index.js');
    await program.parseAsync(['node', 'ariadne', 'graphify', 'query', 'how does auth work']);

    expect(runGraphifyMock).toHaveBeenCalledWith(['query', 'how does auth work'], {
      cwd: root,
      mode: 'inherit',
    });

    const store2 = openWorkspaceStore(root);
    try {
      const checkpoints = store2.listCheckpoints(task.id);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].summary).toContain('graphify query how does auth work');
      expect(checkpoints[0].summary).toContain('ok');
    } finally {
      store2.close();
    }
  });

  it('does not log a checkpoint when there is no current task', async () => {
    const root = makeWorkspace('no-task');
    process.chdir(root);

    isGraphifyInstalledMock.mockReturnValue(true);
    runGraphifyMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const { program } = await import('../src/index.js');
    await program.parseAsync(['node', 'ariadne', 'graphify', 'update', '.']);

    expect(runGraphifyMock).toHaveBeenCalled();
    // No task exists in this workspace at all — nothing should throw, and
    // there's nothing to assert a checkpoint against since there's no store.
  });

  it('sets a non-zero exit code when graphify itself fails', async () => {
    const root = makeWorkspace('failure');
    process.chdir(root);

    isGraphifyInstalledMock.mockReturnValue(true);
    runGraphifyMock.mockResolvedValue({ exitCode: 3, stdout: '', stderr: 'boom' });

    const { program } = await import('../src/index.js');
    const previousExitCode = process.exitCode;
    await program.parseAsync(['node', 'ariadne', 'graphify', 'explain', 'X']);

    expect(process.exitCode).toBe(3);
    process.exitCode = previousExitCode;
  });

  it('errors clearly and exits 1 when graphify is not installed, without invoking it', async () => {
    const root = makeWorkspace('not-installed');
    process.chdir(root);

    isGraphifyInstalledMock.mockReturnValue(false);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { program } = await import('../src/index.js');
    const previousExitCode = process.exitCode;
    await program.parseAsync(['node', 'ariadne', 'graphify', 'query', 'x']);

    expect(runGraphifyMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('graphifyy'));
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });
});
