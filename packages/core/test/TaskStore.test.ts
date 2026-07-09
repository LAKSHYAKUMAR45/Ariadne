import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '../src/TaskStore.js';

describe('TaskStore', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('creates and retrieves a task', () => {
    const task = store.createTask({ title: 'Implement auth', goal: 'JWT login' });
    expect(task.id).toBeTruthy();
    expect(task.title).toBe('Implement auth');
    expect(task.status).toBe('active');

    const fetched = store.getTask(task.id);
    expect(fetched).toEqual(task);
  });

  it('lists tasks filtered by status, most recently updated first', () => {
    const a = store.createTask({ title: 'A' });
    const b = store.createTask({ title: 'B' });
    store.updateTaskStatus(b.id, 'done');

    expect(store.listTasks({ status: 'active' }).map((t) => t.id)).toEqual([a.id]);
    expect(store.listTasks({ status: 'done' }).map((t) => t.id)).toEqual([b.id]);
  });

  it('creates checkpoints and finds the latest one', () => {
    const task = store.createTask({ title: 'Task with checkpoints' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'first' });
    const second = store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'second' });

    const latest = store.latestCheckpoint(task.id);
    expect(latest?.id).toBe(second.id);
    expect(store.listCheckpoints(task.id)).toHaveLength(2);
  });

  it('upserts file touches and keeps the latest role', () => {
    const task = store.createTask({ title: 'Task with files' });
    store.touchFile({ taskId: task.id, path: 'src/index.ts', role: 'read' });
    store.touchFile({ taskId: task.id, path: 'src/index.ts', role: 'edited' });

    const files = store.listFiles(task.id);
    expect(files).toHaveLength(1);
    expect(files[0].role).toBe('edited');
  });

  it('records commits, decisions, todos, commands, errors, and open questions', () => {
    const task = store.createTask({ title: 'Full lifecycle task' });

    const commit = store.recordCommit({ taskId: task.id, sha: 'abc123', message: 'init' });
    expect(store.listCommits(task.id)).toEqual([commit]);

    const decision = store.recordDecision({ taskId: task.id, text: 'Use SQLite' });
    expect(store.listDecisions(task.id)).toEqual([decision]);

    const todo = store.createTodo({ taskId: task.id, text: 'Write tests' });
    expect(store.listTodos(task.id, { status: 'pending' })).toEqual([todo]);
    store.updateTodoStatus(todo.id, 'done');
    expect(store.listTodos(task.id, { status: 'done' })[0].id).toBe(todo.id);

    const command = store.recordCommand({ taskId: task.id, cmdRedacted: 'npm test', exitCode: 0 });
    expect(store.listCommands(task.id)).toEqual([command]);

    const error = store.recordError({ taskId: task.id, message: 'TypeError: x is undefined' });
    expect(store.listErrors(task.id, { resolved: false })).toEqual([error]);
    store.resolveError(error.id, 'Added null check');
    expect(store.listErrors(task.id, { resolved: true })[0].resolution).toBe('Added null check');

    const question = store.recordOpenQuestion({ taskId: task.id, text: 'Unix socket or TCP?' });
    expect(store.listOpenQuestions(task.id, { resolved: false })).toEqual([question]);
    store.resolveOpenQuestion(question.id);
    expect(store.listOpenQuestions(task.id, { resolved: true })[0].id).toBe(question.id);
  });

  it('tracks the current task id in the DB (schema_meta), not a separate file', () => {
    expect(store.getCurrentTaskId()).toBeUndefined();
    const task = store.createTask({ title: 'A' });
    store.setCurrentTaskId(task.id);
    expect(store.getCurrentTaskId()).toBe(task.id);

    const task2 = store.createTask({ title: 'B' });
    store.setCurrentTaskId(task2.id);
    expect(store.getCurrentTaskId()).toBe(task2.id);
  });

  it('supports editing and deleting a task title/goal (curation)', () => {
    const task = store.createTask({ title: 'Original title', goal: 'Original goal' });
    store.updateTaskTitle(task.id, 'Fixed title');
    store.updateTaskGoal(task.id, 'Fixed goal');
    const updated = store.getTask(task.id);
    expect(updated?.title).toBe('Fixed title');
    expect(updated?.goal).toBe('Fixed goal');

    store.updateTaskGoal(task.id, null);
    expect(store.getTask(task.id)?.goal).toBeNull();
  });

  it('supports editing and deleting a decision (curation)', () => {
    const task = store.createTask({ title: 'A' });
    const decision = store.recordDecision({ taskId: task.id, text: 'Use SQLite', rationale: 'simple' });

    store.updateDecision(decision.id, { text: 'Use SQLite (WAL mode)' });
    expect(store.getDecision(decision.id)?.text).toBe('Use SQLite (WAL mode)');
    expect(store.getDecision(decision.id)?.rationale).toBe('simple');

    store.updateDecision(decision.id, { rationale: null });
    expect(store.getDecision(decision.id)?.rationale).toBeNull();

    store.deleteDecision(decision.id);
    expect(store.getDecision(decision.id)).toBeUndefined();
    expect(store.listDecisions(task.id)).toEqual([]);
  });

  it('supports editing and deleting a todo, and reopening a done todo (curation)', () => {
    const task = store.createTask({ title: 'A' });
    const todo = store.createTodo({ taskId: task.id, text: 'Write tests' });

    store.updateTodoText(todo.id, 'Write more tests');
    expect(store.getTodo(todo.id)?.text).toBe('Write more tests');

    store.updateTodoStatus(todo.id, 'done');
    expect(store.getTodo(todo.id)?.status).toBe('done');
    // "Reopen" is just setting status back to pending — already supported by updateTodoStatus.
    store.updateTodoStatus(todo.id, 'pending');
    expect(store.getTodo(todo.id)?.status).toBe('pending');

    store.deleteTodo(todo.id);
    expect(store.getTodo(todo.id)).toBeUndefined();
  });

  it('supports editing, deleting, and reopening a resolved error (curation)', () => {
    const task = store.createTask({ title: 'A' });
    const error = store.recordError({ taskId: task.id, message: 'boom' });

    store.updateError(error.id, 'boom (with stack trace)');
    expect(store.getError(error.id)?.message).toBe('boom (with stack trace)');

    store.resolveError(error.id, 'fixed');
    expect(store.getError(error.id)?.resolved).toBe(true);
    store.unresolveError(error.id);
    expect(store.getError(error.id)?.resolved).toBe(false);
    expect(store.getError(error.id)?.resolution).toBeNull();

    store.deleteError(error.id);
    expect(store.getError(error.id)).toBeUndefined();
  });

  it('supports editing, deleting, and reopening a resolved open question (curation)', () => {
    const task = store.createTask({ title: 'A' });
    const question = store.recordOpenQuestion({ taskId: task.id, text: 'Unix socket or TCP?' });

    store.updateOpenQuestion(question.id, 'Unix socket, TCP, or named pipe?');
    expect(store.getOpenQuestion(question.id)?.text).toBe('Unix socket, TCP, or named pipe?');

    store.resolveOpenQuestion(question.id);
    expect(store.getOpenQuestion(question.id)?.resolved).toBe(true);
    store.unresolveOpenQuestion(question.id);
    expect(store.getOpenQuestion(question.id)?.resolved).toBe(false);

    store.deleteOpenQuestion(question.id);
    expect(store.getOpenQuestion(question.id)).toBeUndefined();
  });

  it('bumps the parent task updated_at when a todo/error/question is resolved or reopened', async () => {
    const task = store.createTask({ title: 'A' });
    const initialUpdatedAt = store.getTask(task.id)!.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const todo = store.createTodo({ taskId: task.id, text: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.updateTodoStatus(todo.id, 'done');
    expect(store.getTask(task.id)!.updatedAt > initialUpdatedAt).toBe(true);

    const afterTodoDone = store.getTask(task.id)!.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const error = store.recordError({ taskId: task.id, message: 'boom' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.resolveError(error.id);
    expect(store.getTask(task.id)!.updatedAt > afterTodoDone).toBe(true);

    const afterErrorResolve = store.getTask(task.id)!.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const question = store.recordOpenQuestion({ taskId: task.id, text: 'y?' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.resolveOpenQuestion(question.id);
    expect(store.getTask(task.id)!.updatedAt > afterErrorResolve).toBe(true);
  });
});
