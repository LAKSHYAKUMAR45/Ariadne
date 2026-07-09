import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '@ariadne/core';
import * as tools from '../src/tools.js';
import { readCurrentTaskId } from '../src/workspace.js';

describe('mcp-server tools', () => {
  let store: TaskStore;
  let workspaceRoot: string;

  beforeEach(() => {
    store = new TaskStore(':memory:');
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-mcp-test-'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('task_new creates a task and sets it as current', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'Fix login bug', goal: 'Users cannot log in' });
    expect(task.title).toBe('Fix login bug');
    expect(readCurrentTaskId(workspaceRoot)).toBe(task.id);
  });

  it('task_list filters by status', () => {
    const a = tools.taskNew(store, workspaceRoot, { title: 'A' });
    const b = tools.taskNew(store, workspaceRoot, { title: 'B' });
    store.updateTaskStatus(b.id, 'done');

    expect(tools.taskList(store, { status: 'active' }).map((t) => t.id)).toEqual([a.id]);
    expect(tools.taskList(store, {}).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('task_use switches the current task and rejects unknown ids', () => {
    const a = tools.taskNew(store, workspaceRoot, { title: 'A' });
    const b = tools.taskNew(store, workspaceRoot, { title: 'B' }); // becomes current
    expect(readCurrentTaskId(workspaceRoot)).toBe(b.id);

    tools.taskUse(store, workspaceRoot, { taskId: a.id });
    expect(readCurrentTaskId(workspaceRoot)).toBe(a.id);

    expect(() => tools.taskUse(store, workspaceRoot, { taskId: 'nope' })).toThrow(/No task found/);
  });

  it('checkpoint_add, todo_add/list/done, decision_add, error_add/resolve operate on the current task', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'A' });

    const cp = tools.checkpointAdd(store, workspaceRoot, { summary: 'did stuff' });
    expect(cp.taskId).toBe(task.id);
    expect(cp.level).toBe('micro');

    const todo = tools.todoAdd(store, workspaceRoot, { text: 'write tests' });
    expect(tools.todoList(store, workspaceRoot, {}).map((t) => t.id)).toContain(todo.id);
    tools.todoDone(store, { todoId: todo.id });
    expect(tools.todoList(store, workspaceRoot, { status: 'done' }).map((t) => t.id)).toContain(todo.id);

    const decision = tools.decisionAdd(store, workspaceRoot, { text: 'use SQLite', rationale: 'simple, local' });
    expect(decision.text).toBe('use SQLite');

    const error = tools.errorAdd(store, workspaceRoot, { message: 'build failed' });
    tools.errorResolve(store, { errorId: error.id, resolution: 'fixed typo' });
    expect(store.listErrors(task.id, { resolved: false })).toHaveLength(0);
  });

  it('resolveTaskId throws with no current task and no explicit id', () => {
    expect(() => tools.resolveTaskId(store, workspaceRoot, undefined)).toThrow(/No task specified/);
  });

  it('search matches task titles and goals case-insensitively', () => {
    tools.taskNew(store, workspaceRoot, { title: 'Fix login bug', goal: 'Users cannot log in' });
    tools.taskNew(store, workspaceRoot, { title: 'Add dark mode' });

    expect(tools.searchTasks(store, { query: 'LOGIN' }).map((t) => t.title)).toEqual(['Fix login bug']);
    expect(tools.searchTasks(store, { query: 'dark' }).map((t) => t.title)).toEqual(['Add dark mode']);
    expect(tools.searchTasks(store, { query: 'nonexistent' })).toEqual([]);
  });

  it('get_context assembles the full task context as structured data', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'Fix login bug' });
    tools.checkpointAdd(store, workspaceRoot, { summary: 'first checkpoint' });
    tools.todoAdd(store, workspaceRoot, { text: 'write tests' });
    tools.errorAdd(store, workspaceRoot, { message: 'build failed' });
    tools.decisionAdd(store, workspaceRoot, { text: 'use SQLite' });

    const ctx = tools.getContext(store, workspaceRoot, {});
    expect(ctx.taskId).toBe(task.id);
    expect(ctx.latestSummary).toBe('first checkpoint');
    expect(ctx.openTodos).toHaveLength(1);
    expect(ctx.unresolvedErrors).toHaveLength(1);
    expect(ctx.decisions).toHaveLength(1);
  });

  it('git_sync records commits from a real git repo at the workspace root', () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspaceRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workspaceRoot });
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'a');
    execFileSync('git', ['add', 'a.txt'], { cwd: workspaceRoot });
    execFileSync('git', ['commit', '-q', '-m', 'Initial commit'], { cwd: workspaceRoot });

    tools.taskNew(store, workspaceRoot, { title: 'A' });
    const result = tools.gitSync(store, workspaceRoot, {});
    expect(result.recordedCommits).toHaveLength(1);
    expect(result.recordedCommits[0].message).toBe('Initial commit');
  });

  it('export_task renders the current task as Markdown', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'Fix login bug' });
    tools.checkpointAdd(store, workspaceRoot, { summary: 'first checkpoint' });

    const result = tools.exportTask(store, workspaceRoot, {});
    expect(result.taskId).toBe(task.id);
    expect(result.markdown).toContain('# Fix login bug');
    expect(result.markdown).toContain('first checkpoint');
  });
});
