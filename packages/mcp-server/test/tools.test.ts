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

  it('taskSetStatus pauses/completes/archives/reopens the current (or given) task', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'Lifecycle task' });

    tools.taskSetStatus(store, workspaceRoot, { status: 'paused' });
    expect(store.getTask(task.id)?.status).toBe('paused');

    tools.taskSetStatus(store, workspaceRoot, { status: 'done' });
    expect(store.getTask(task.id)?.status).toBe('done');

    tools.taskSetStatus(store, workspaceRoot, { status: 'archived' });
    expect(store.getTask(task.id)?.status).toBe('archived');

    tools.taskSetStatus(store, workspaceRoot, { status: 'active' });
    expect(store.getTask(task.id)?.status).toBe('active');

    const other = tools.taskNew(store, workspaceRoot, { title: 'Other task' });
    tools.taskSetStatus(store, workspaceRoot, { taskId: task.id, status: 'done' });
    expect(store.getTask(task.id)?.status).toBe('done');
    expect(store.getTask(other.id)?.status).toBe('active');
  });

  it('checkpoint_add, todo_add/list/done, decision_add, error_add/resolve operate on the current task', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'A' });

    const cp = tools.checkpointAdd(store, workspaceRoot, { summary: 'did stuff' });
    expect(cp.taskId).toBe(task.id);
    expect(cp.level).toBe('micro');

    const todo = tools.todoAdd(store, workspaceRoot, { text: 'write tests' });
    expect(tools.todoList(store, workspaceRoot, {}).map((t) => t.id)).toContain(todo.id);
    tools.todoDone(store, workspaceRoot, { todoId: todo.id });
    expect(tools.todoList(store, workspaceRoot, { status: 'done' }).map((t) => t.id)).toContain(todo.id);

    const decision = tools.decisionAdd(store, workspaceRoot, { text: 'use SQLite', rationale: 'simple, local' });
    expect(decision.text).toBe('use SQLite');

    const error = tools.errorAdd(store, workspaceRoot, { message: 'build failed' });
    tools.errorResolve(store, workspaceRoot, { errorId: error.id, resolution: 'fixed typo' });
    expect(store.listErrors(task.id, { resolved: false })).toHaveLength(0);
  });

  it('question_add/list/resolve operate on the current task', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'A' });

    const q = tools.questionAdd(store, workspaceRoot, { text: 'Unix socket or TCP for IPC?' });
    expect(q.taskId).toBe(task.id);
    expect(q.resolved).toBe(false);

    expect(tools.questionList(store, workspaceRoot, {}).map((x) => x.id)).toContain(q.id);
    expect(tools.questionList(store, workspaceRoot, { resolved: false }).map((x) => x.id)).toContain(q.id);
    expect(tools.questionList(store, workspaceRoot, { resolved: true }).map((x) => x.id)).not.toContain(q.id);

    tools.questionResolve(store, workspaceRoot, { questionId: q.id });
    expect(tools.questionList(store, workspaceRoot, { resolved: true }).map((x) => x.id)).toContain(q.id);
    expect(tools.questionList(store, workspaceRoot, { resolved: false }).map((x) => x.id)).not.toContain(q.id);
  });

  it('resolveTaskId throws with no current task and no explicit id', () => {
    expect(() => tools.resolveTaskId(store, workspaceRoot, undefined)).toThrow(/No task specified/);
  });

  it('search matches task titles and goals case-insensitively', () => {
    tools.taskNew(store, workspaceRoot, { title: 'Fix login bug', goal: 'Users cannot log in' });
    tools.taskNew(store, workspaceRoot, { title: 'Add dark mode' });

    expect(tools.searchTasks(store, { query: 'LOGIN' }).map((r) => r.taskTitle)).toEqual(['Fix login bug']);
    expect(tools.searchTasks(store, { query: 'dark' }).map((r) => r.taskTitle)).toEqual(['Add dark mode']);
    expect(tools.searchTasks(store, { query: 'nonexistent' })).toEqual([]);
  });

  it('search also matches todos, decisions, and errors, not just task title/goal', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'Networking' });
    tools.todoAdd(store, workspaceRoot, { text: 'Pick a transport for IPC', taskId: task.id });

    const results = tools.searchTasks(store, { query: 'transport' });
    expect(results).toHaveLength(1);
    expect(results[0].matches.some((m) => m.category === 'todo')).toBe(true);
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
    expect(ctx.workspaceRoot).toBe(workspaceRoot);
  });

  it('get_context surfaces the task\'s tracked git branch, and null when none is set yet', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'Branch-visible task' });
    const before = tools.getContext(store, workspaceRoot, {});
    expect(before.branch).toBeNull();

    store.updateTaskBranch(task.id, 'feature/xyz');
    const after = tools.getContext(store, workspaceRoot, {});
    expect(after.branch).toBe('feature/xyz');
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

  it('task_edit edits title and/or goal without disturbing the other', () => {
    const task = tools.taskNew(store, workspaceRoot, { title: 'Old title', goal: 'Old goal' });

    tools.taskEdit(store, workspaceRoot, { title: 'New title' });
    expect(store.getTask(task.id)?.title).toBe('New title');
    expect(store.getTask(task.id)?.goal).toBe('Old goal');

    tools.taskEdit(store, workspaceRoot, { goal: 'New goal' });
    expect(store.getTask(task.id)?.goal).toBe('New goal');
  });

  it('todo curation: reopen, block, edit, delete', () => {
    tools.taskNew(store, workspaceRoot, { title: 'Task' });
    const todo = tools.todoAdd(store, workspaceRoot, { text: 'Write tests' });

    tools.todoDone(store, workspaceRoot, { todoId: todo.id });
    expect(store.getTodo(todo.id)?.status).toBe('done');

    tools.todoReopen(store, workspaceRoot, { todoId: todo.id });
    expect(store.getTodo(todo.id)?.status).toBe('pending');

    tools.todoBlock(store, workspaceRoot, { todoId: todo.id });
    expect(store.getTodo(todo.id)?.status).toBe('blocked');

    tools.todoEdit(store, workspaceRoot, { todoId: todo.id, text: 'Write more tests' });
    expect(store.getTodo(todo.id)?.text).toBe('Write more tests');

    tools.todoDelete(store, workspaceRoot, { todoId: todo.id });
    expect(store.getTodo(todo.id)).toBeUndefined();
  });

  it('decision curation: list, edit, delete', () => {
    tools.taskNew(store, workspaceRoot, { title: 'Task' });
    const decision = tools.decisionAdd(store, workspaceRoot, { text: 'Use SQLite', rationale: 'simple' });

    expect(tools.decisionList(store, workspaceRoot, {}).map((d) => d.id)).toEqual([decision.id]);

    tools.decisionEdit(store, workspaceRoot, { decisionId: decision.id, text: 'Use Postgres' });
    expect(store.getDecision(decision.id)?.text).toBe('Use Postgres');

    tools.decisionDelete(store, workspaceRoot, { decisionId: decision.id });
    expect(store.getDecision(decision.id)).toBeUndefined();
  });

  it('error curation: reopen, edit, delete', () => {
    tools.taskNew(store, workspaceRoot, { title: 'Task' });
    const error = tools.errorAdd(store, workspaceRoot, { message: 'TypeError: x is undefined' });

    tools.errorResolve(store, workspaceRoot, { errorId: error.id });
    expect(store.getError(error.id)?.resolved).toBe(true);

    tools.errorReopen(store, workspaceRoot, { errorId: error.id });
    expect(store.getError(error.id)?.resolved).toBe(false);

    tools.errorEdit(store, workspaceRoot, { errorId: error.id, message: 'Fixed message' });
    expect(store.getError(error.id)?.message).toBe('Fixed message');

    tools.errorDelete(store, workspaceRoot, { errorId: error.id });
    expect(store.getError(error.id)).toBeUndefined();
  });

  it('error_list defaults to unresolved-only, and returns everything with all:true', () => {
    tools.taskNew(store, workspaceRoot, { title: 'Task' });
    const unresolved = tools.errorAdd(store, workspaceRoot, { message: 'Still broken' });
    const resolved = tools.errorAdd(store, workspaceRoot, { message: 'Already fixed' });
    tools.errorResolve(store, workspaceRoot, { errorId: resolved.id });

    const defaultList = tools.errorList(store, workspaceRoot, {});
    expect(defaultList.map((e) => e.id)).toEqual([unresolved.id]);

    const allList = tools.errorList(store, workspaceRoot, { all: true });
    expect(allList.map((e) => e.id).sort()).toEqual([resolved.id, unresolved.id].sort());
  });

  it('question curation: reopen, edit, delete', () => {
    tools.taskNew(store, workspaceRoot, { title: 'Task' });
    const question = tools.questionAdd(store, workspaceRoot, { text: 'Should we use X?' });

    tools.questionResolve(store, workspaceRoot, { questionId: question.id });
    expect(store.getOpenQuestion(question.id)?.resolved).toBe(true);

    tools.questionReopen(store, workspaceRoot, { questionId: question.id });
    expect(store.getOpenQuestion(question.id)?.resolved).toBe(false);

    tools.questionEdit(store, workspaceRoot, { questionId: question.id, text: 'Should we use Y?' });
    expect(store.getOpenQuestion(question.id)?.text).toBe('Should we use Y?');

    tools.questionDelete(store, workspaceRoot, { questionId: question.id });
    expect(store.getOpenQuestion(question.id)).toBeUndefined();
  });
});
