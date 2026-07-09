import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openWorkspaceStore, closeRegistry } from '@ariadne/core';
import { withResolvedTask } from '../src/withTask.js';

// These tests exercise cross-workspace task resolution directly (rather
// than shelling out to the built CLI binary), since withResolvedTask is
// what every task-scoped CLI command (checkpoint/decision/todo/error/
// question/status/resume/git-sync/export/task pause|done|archive|reopen)
// delegates to for "operate on this task id even if it's in another
// workspace." See packages/core/test/CrossWorkspace.test.ts for the
// underlying resolveTaskAnyWorkspace behavior.
describe('withResolvedTask (cross-workspace task resolution for the CLI)', () => {
  let tmpDir: string;
  let previousRegistryPath: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-crossws-test-'));
    previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = path.join(tmpDir, 'registry.db');
    closeRegistry();
    previousCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a task in the current workspace without needing the registry fallback', () => {
    const rootA = path.join(tmpDir, 'ws-a');
    fs.mkdirSync(rootA, { recursive: true });
    const storeA = openWorkspaceStore(rootA);
    const task = storeA.createTask({ title: 'Local task', goal: null });
    storeA.close();

    process.chdir(rootA);
    const result = withResolvedTask(task.id, (_store, taskId, workspaceRoot) => ({ taskId, workspaceRoot }));
    expect(result).toEqual({ taskId: task.id, workspaceRoot: rootA });
  });

  it('transparently resolves and opens a task that belongs to a different workspace', () => {
    const rootA = path.join(tmpDir, 'ws-a');
    const rootB = path.join(tmpDir, 'ws-b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });

    const storeB = openWorkspaceStore(rootB);
    const task = storeB.createTask({ title: 'Task only in B', goal: null });
    storeB.close();

    process.chdir(rootA);
    const result = withResolvedTask(task.id, (store, taskId, workspaceRoot) => {
      const found = store.getTask(taskId);
      return { workspaceRoot, title: found?.title };
    });
    expect(result).toEqual({ workspaceRoot: rootB, title: 'Task only in B' });
  });

  it('exits the process with an error for a completely unknown task id', () => {
    const rootA = path.join(tmpDir, 'ws-a');
    fs.mkdirSync(rootA, { recursive: true });
    openWorkspaceStore(rootA).close();
    process.chdir(rootA);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => withResolvedTask('does-not-exist', () => undefined)).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
