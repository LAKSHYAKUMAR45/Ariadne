import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from '@ariadne-dev/core';
import { buildWebviewState, handleWebviewMessage } from '../src/webview/handleWebviewMessage.js';

function makeStore() {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ title: 'Webview task', goal: 'Ship the panel' });
  store.createTodo({ taskId: task.id, text: 'Write host tests' });
  store.recordDecision({ taskId: task.id, text: 'Use React webview', rationale: 'Local UI only' });
  store.recordError({ taskId: task.id, message: 'Build failed' });
  store.recordOpenQuestion({ taskId: task.id, text: 'Review VSIX?' });
  store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Started rework' });
  return { store, task };
}

describe('buildWebviewState', () => {
  it('builds a current-task snapshot with counts and editable categories', () => {
    const { store, task } = makeStore();
    const state = buildWebviewState({ store, currentTaskId: task.id, workspaceRoot: '/repo' });

    expect(state.currentTask?.id).toBe(task.id);
    expect(state.tasks.map((t) => t.id)).toContain(task.id);
    expect(state.todos).toHaveLength(1);
    expect(state.decisions).toHaveLength(1);
    expect(state.errors).toHaveLength(1);
    expect(state.questions).toHaveLength(1);
    expect(state.checkpoints[0].summary).toBe('Started rework');
    expect(state.counts).toEqual({ pendingTodos: 1, unresolvedErrors: 1, openQuestions: 1 });
    store.close();
  });
});

describe('handleWebviewMessage', () => {
  it('creates, edits, completes, reopens, and deletes todos', () => {
    const { store, task } = makeStore();
    const add = handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: '1', type: 'todo.create', payload: { text: 'Add bridge' } },
    );
    expect(add.ok).toBe(true);
    const created = store.listTodos(task.id).find((todo) => todo.text === 'Add bridge');
    expect(created).toBeDefined();

    handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: '2', type: 'todo.updateText', payload: { id: created!.id, text: 'Add typed bridge' } },
    );
    handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: '3', type: 'todo.setStatus', payload: { id: created!.id, status: 'done' } },
    );
    expect(store.listTodos(task.id).find((todo) => todo.id === created!.id)?.status).toBe('done');

    handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: '4', type: 'todo.delete', payload: { id: created!.id } },
    );
    expect(store.listTodos(task.id).some((todo) => todo.id === created!.id)).toBe(false);
    store.close();
  });

  it('rejects invalid todo statuses instead of coercing them', () => {
    const { store, task } = makeStore();
    const created = store.listTodos(task.id)[0];
    const response = handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: 'bad-status', type: 'todo.setStatus', payload: { id: created.id, status: 'finished' } },
    );

    expect(response).toEqual({
      id: 'bad-status',
      ok: false,
      error: 'todo.setStatus requires payload.id and payload.status to be pending, done, or blocked.',
    });
    expect(store.listTodos(task.id).find((todo) => todo.id === created.id)?.status).toBe('pending');
    store.close();
  });

  it('keeps cross-workspace switching explicit and safe', () => {
    const { store } = makeStore();
    const response = handleWebviewMessage(
      { store, currentTaskId: undefined, workspaceRoot: '/repo' },
      { id: 'switch', type: 'task.switch', payload: { id: 'missing-task' } },
    );

    expect(response).toEqual({
      id: 'switch',
      ok: false,
      error: 'task.switch only supports tasks in the current workspace. Cross-workspace switching is not available in this layer.',
    });
    store.close();
  });

  it('returns an error response instead of throwing when a task is required', () => {
    const store = new TaskStore(':memory:');
    const response = handleWebviewMessage(
      { store, currentTaskId: undefined, workspaceRoot: '/repo' },
      { id: 'missing', type: 'todo.create', payload: { text: 'No task' } },
    );
    expect(response).toEqual({ id: 'missing', ok: false, error: 'No current Ariadne task is selected.' });
    store.close();
  });

  it('runs sync and export through injected host actions', () => {
    const { store, task } = makeStore();
    const syncPush = vi.fn(() => 'pushed');
    const writeExport = vi.fn(() => '/repo/.ariadne/export/task.md');

    expect(
      handleWebviewMessage(
        { store, currentTaskId: task.id, workspaceRoot: '/repo', sync: { push: syncPush, pull: vi.fn(), listRemote: vi.fn() }, writeExport },
        { id: 'sync', type: 'sync.push' },
      ),
    ).toMatchObject({ id: 'sync', ok: true, data: { output: 'pushed' } });

    expect(
      handleWebviewMessage(
        { store, currentTaskId: task.id, workspaceRoot: '/repo', sync: { push: syncPush, pull: vi.fn(), listRemote: vi.fn() }, writeExport },
        { id: 'export', type: 'export.markdown' },
      ),
    ).toMatchObject({ id: 'export', ok: true, data: { path: '/repo/.ariadne/export/task.md' } });
    store.close();
  });
});
