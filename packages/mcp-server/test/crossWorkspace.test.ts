import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { closeRegistry } from '@ariadne/core';
import * as tools from '../src/tools.js';
import { openWorkspaceStore } from '../src/workspace.js';

// Exercises the cross-workspace fallback baked into withTaskStore (see
// tools.ts): every tool that accepts a taskId should transparently operate
// on that task's real owning workspace, even when it's not the workspace
// whose store was handed to the tool function. Also covers task_list/search
// with allWorkspaces: true.
describe('mcp-server cross-workspace tools', () => {
  let tmpDir: string;
  let rootA: string;
  let rootB: string;
  let previousRegistryPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-mcp-crossws-test-'));
    rootA = path.join(tmpDir, 'ws-a');
    rootB = path.join(tmpDir, 'ws-b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = path.join(tmpDir, 'registry.db');
    closeRegistry();
  });

  afterEach(() => {
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('checkpoint_add writes into the owning workspace when taskId belongs elsewhere', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = tools.taskNew(storeB, rootB, { title: 'Task in B' });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    const checkpoint = tools.checkpointAdd(storeA, rootA, { summary: 'from A', taskId: task.id });
    expect(checkpoint.taskId).toBe(task.id);
    storeA.close();

    // Verify it actually landed in B's own store, not A's.
    const verifyB = openWorkspaceStore(rootB);
    const checkpoints = verifyB.listCheckpoints(task.id);
    expect(checkpoints.some((c) => c.summary === 'from A')).toBe(true);
    verifyB.close();

    const verifyA = openWorkspaceStore(rootA);
    expect(verifyA.listCheckpoints(task.id)).toEqual([]);
    verifyA.close();
  });

  it('get_context and export_task resolve a cross-workspace taskId', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = tools.taskNew(storeB, rootB, { title: 'Task in B', goal: 'demo goal' });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    const context = tools.getContext(storeA, rootA, { taskId: task.id });
    expect(context.taskId).toBe(task.id);
    expect(context.goal).toBe('demo goal');

    const exported = tools.exportTask(storeA, rootA, { taskId: task.id });
    expect(exported.markdown).toContain('Task in B');
    storeA.close();
  });

  it('task_list with allWorkspaces returns tasks from every known workspace', () => {
    const storeA = openWorkspaceStore(rootA);
    const taskA = tools.taskNew(storeA, rootA, { title: 'A task' });
    storeA.close();

    const storeB = openWorkspaceStore(rootB);
    const taskB = tools.taskNew(storeB, rootB, { title: 'B task' });

    const all = tools.taskList(storeB, { allWorkspaces: true });
    const ids = all.map((t) => (t as { taskId: string }).taskId);
    expect(ids).toEqual(expect.arrayContaining([taskA.id, taskB.id]));
    storeB.close();
  });

  it('search with allWorkspaces finds matches across workspaces', () => {
    const storeA = openWorkspaceStore(rootA);
    const taskA = tools.taskNew(storeA, rootA, { title: 'Alpha task' });
    tools.checkpointAdd(storeA, rootA, { summary: 'a very unique marker string', taskId: taskA.id });
    storeA.close();

    const storeB = openWorkspaceStore(rootB);
    const results = tools.searchTasks(storeB, { query: 'unique marker', allWorkspaces: true });
    expect(results.some((r) => r.taskId === taskA.id)).toBe(true);
    storeB.close();
  });

  it('todo_done with a taskId hint marks a todo done in a different workspace', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = tools.taskNew(storeB, rootB, { title: 'Task in B' });
    const todo = tools.todoAdd(storeB, rootB, { text: 'a todo', taskId: task.id });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    tools.todoDone(storeA, rootA, { todoId: todo.id, taskId: task.id });
    storeA.close();

    const verifyB = openWorkspaceStore(rootB);
    expect(verifyB.listTodos(task.id).find((t) => t.id === todo.id)?.status).toBe('done');
    verifyB.close();
  });

  it('error_resolve with a taskId hint resolves an error in a different workspace', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = tools.taskNew(storeB, rootB, { title: 'Task in B' });
    const err = tools.errorAdd(storeB, rootB, { message: 'boom', taskId: task.id });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    tools.errorResolve(storeA, rootA, { errorId: err.id, taskId: task.id });
    storeA.close();

    const verifyB = openWorkspaceStore(rootB);
    expect(verifyB.listErrors(task.id).find((e) => e.id === err.id)?.resolved).toBe(true);
    verifyB.close();
  });

  it('question_resolve with a taskId hint resolves a question in a different workspace', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = tools.taskNew(storeB, rootB, { title: 'Task in B' });
    const q = tools.questionAdd(storeB, rootB, { text: 'unix socket or TCP?', taskId: task.id });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    tools.questionResolve(storeA, rootA, { questionId: q.id, taskId: task.id });
    storeA.close();

    const verifyB = openWorkspaceStore(rootB);
    expect(verifyB.listOpenQuestions(task.id, { resolved: true }).find((x) => x.id === q.id)).toBeTruthy();
    verifyB.close();
  });
});
