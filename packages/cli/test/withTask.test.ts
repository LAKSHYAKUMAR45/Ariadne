import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openWorkspaceStore, closeRegistry } from '@ariadne/core';
import { withResolvedTask, withScopedStore } from '../src/withTask.js';

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

// withScopedStore backs the sub-entity mutation commands (`todo done`,
// `error resolve`, `question resolve`) that operate on a raw sub-entity id
// rather than a task id — the registry only indexes tasks, so an explicit
// --task hint is required to route to another workspace's store.
describe('withScopedStore (sub-entity mutation store resolution for the CLI)', () => {
  let tmpDir: string;
  let previousRegistryPath: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-scoped-store-test-'));
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

  it('without a hint, operates on the current workspace store', () => {
    const rootA = path.join(tmpDir, 'ws-a');
    fs.mkdirSync(rootA, { recursive: true });
    const storeA = openWorkspaceStore(rootA);
    const task = storeA.createTask({ title: 'Local task', goal: null });
    const todo = storeA.createTodo({ taskId: task.id, text: 'a todo' });
    storeA.close();

    process.chdir(rootA);
    withScopedStore(undefined, (store) => store.updateTodoStatus(todo.id, 'done'));

    const verify = openWorkspaceStore(rootA);
    expect(verify.listTodos(task.id).find((t) => t.id === todo.id)?.status).toBe('done');
    verify.close();
  });

  it('with a --task hint belonging to a different workspace, operates against that workspace store', () => {
    const rootA = path.join(tmpDir, 'ws-a');
    const rootB = path.join(tmpDir, 'ws-b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });

    const storeB = openWorkspaceStore(rootB);
    const task = storeB.createTask({ title: 'Task in B', goal: null });
    const todo = storeB.createTodo({ taskId: task.id, text: 'a todo in B' });
    storeB.close();

    process.chdir(rootA);
    withScopedStore(task.id, (store) => store.updateTodoStatus(todo.id, 'done'));

    const verifyB = openWorkspaceStore(rootB);
    expect(verifyB.listTodos(task.id).find((t) => t.id === todo.id)?.status).toBe('done');
    verifyB.close();
  });
});
