import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { closeRegistry, openWorkspaceStore, type TaskStore } from '@ariadne-dev/core';
import { buildWebviewState, handleWebviewMessage } from '../src/webview/handleWebviewMessage.js';

function setupRegistry(): () => void {
  const previous = process.env.ARIADNE_REGISTRY_PATH;
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-webview-registry-'));
  process.env.ARIADNE_REGISTRY_PATH = path.join(registryDir, 'registry.db');
  closeRegistry();
  return () => {
    closeRegistry();
    if (previous === undefined) {
      delete process.env.ARIADNE_REGISTRY_PATH;
    } else {
      process.env.ARIADNE_REGISTRY_PATH = previous;
    }
    fs.rmSync(registryDir, { recursive: true, force: true });
  };
}

function makeWorkspace(label: string): { root: string; store: TaskStore; taskId: string; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ariadne-webview-${label}-`));
  const store = openWorkspaceStore(root);
  const task = store.createTask({ title: `${label} task`, goal: 'Ship the panel' });
  store.createTodo({ taskId: task.id, text: 'Write host tests' });
  store.recordDecision({ taskId: task.id, text: 'Use React webview', rationale: 'Local UI only' });
  store.recordError({ taskId: task.id, message: 'Build failed' });
  store.recordOpenQuestion({ taskId: task.id, text: 'Review VSIX?' });
  store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Started rework' });
  return {
    root,
    store,
    taskId: task.id,
    close: () => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('buildWebviewState', () => {
  it('builds a current-task snapshot with counts and editable categories', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('build-state');
    const state = buildWebviewState({ store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root });

    expect(state.currentTask?.id).toBe(workspace.taskId);
    expect(state.tasks.map((t) => t.id)).toContain(workspace.taskId);
    expect(state.todos).toHaveLength(1);
    expect(state.decisions).toHaveLength(1);
    expect(state.errors).toHaveLength(1);
    expect(state.questions).toHaveLength(1);
    expect(state.checkpoints[0].summary).toBe('Started rework');
    expect(state.counts).toEqual({ pendingTodos: 1, unresolvedErrors: 1, openQuestions: 1 });
    workspace.close();
    cleanupRegistry();
  });
});

describe('handleWebviewMessage', () => {
  it('creates, edits, completes, reopens, and deletes todos', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('todo-crud');
    const add = handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root },
      { id: '1', type: 'todo.create', payload: { text: 'Add bridge' } },
    );
    expect(add.ok).toBe(true);
    const created = workspace.store.listTodos(workspace.taskId).find((todo) => todo.text === 'Add bridge');
    expect(created).toBeDefined();

    handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root },
      { id: '2', type: 'todo.updateText', payload: { id: created!.id, text: 'Add typed bridge' } },
    );
    handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root },
      { id: '3', type: 'todo.setStatus', payload: { id: created!.id, status: 'done' } },
    );
    expect(workspace.store.listTodos(workspace.taskId).find((todo) => todo.id === created!.id)?.status).toBe('done');

    handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root },
      { id: '4', type: 'todo.delete', payload: { id: created!.id } },
    );
    expect(workspace.store.listTodos(workspace.taskId).some((todo) => todo.id === created!.id)).toBe(false);
    workspace.close();
    cleanupRegistry();
  });

  it('rejects invalid todo statuses instead of coercing them', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('todo-status');
    const created = workspace.store.listTodos(workspace.taskId)[0];
    const response = handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root },
      { id: 'bad-status', type: 'todo.setStatus', payload: { id: created.id, status: 'finished' } },
    );

    expect(response).toEqual({
      id: 'bad-status',
      ok: false,
      error: 'todo.setStatus requires payload.id and payload.status to be pending, done, or blocked.',
    });
    expect(workspace.store.listTodos(workspace.taskId).find((todo) => todo.id === created.id)?.status).toBe('pending');
    workspace.close();
    cleanupRegistry();
  });

  it('switches to a task from another registered workspace', () => {
    const cleanupRegistry = setupRegistry();
    const current = makeWorkspace('current');
    const other = makeWorkspace('other');
    const setCurrentTaskId = vi.fn();

    const response = handleWebviewMessage(
      { store: current.store, currentTaskId: current.taskId, workspaceRoot: current.root, setCurrentTaskId },
      { id: 'switch-cross', type: 'task.switch', payload: { id: other.taskId } },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.state?.currentTask?.id).toBe(other.taskId);
      expect(response.state?.workspaceRoot).toBe(other.root);
      expect(response.state?.currentTaskId).toBe(other.taskId);
    }
    expect(setCurrentTaskId).toHaveBeenCalledWith(other.taskId);
    expect(other.store.getCurrentTaskId()).toBe(other.taskId);
    current.close();
    other.close();
    cleanupRegistry();
  });

  it('rejects unknown task ids', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('unknown-task');
    const response = handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root },
      { id: 'switch-missing', type: 'task.switch', payload: { id: 'missing-task' } },
    );

    expect(response).toEqual({ id: 'switch-missing', ok: false, error: 'Task not found: missing-task' });
    workspace.close();
    cleanupRegistry();
  });

  it('keeps local task switching working', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('local-switch');
    const second = workspace.store.createTask({ title: 'local task 2', goal: 'Stay local' });
    const setCurrentTaskId = vi.fn();

    const response = handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root, setCurrentTaskId },
      { id: 'switch-local', type: 'task.switch', payload: { id: second.id } },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.state?.currentTask?.id).toBe(second.id);
      expect(response.state?.workspaceRoot).toBe(workspace.root);
      expect(response.state?.currentTaskId).toBe(second.id);
    }
    expect(setCurrentTaskId).toHaveBeenCalledWith(second.id);
    expect(workspace.store.getCurrentTaskId()).toBe(second.id);
    workspace.close();
    cleanupRegistry();
  });

  it('returns an error response instead of throwing when a task is required', () => {
    const cleanupRegistry = setupRegistry();
    const store = openWorkspaceStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-webview-missing-')));
    const response = handleWebviewMessage(
      { store, currentTaskId: undefined, workspaceRoot: undefined },
      { id: 'missing', type: 'todo.create', payload: { text: 'No task' } },
    );
    expect(response).toEqual({ id: 'missing', ok: false, error: 'No current Ariadne task is selected.' });
    store.close();
    cleanupRegistry();
  });

  it('runs sync and export through injected host actions', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('sync-export');
    const syncPush = vi.fn(() => 'pushed');
    const writeExport = vi.fn(() => '/repo/.ariadne/export/task.md');

    expect(
      handleWebviewMessage(
        { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root, sync: { push: syncPush, pull: vi.fn(), listRemote: vi.fn() }, writeExport },
        { id: 'sync', type: 'sync.push' },
      ),
    ).toMatchObject({ id: 'sync', ok: true, data: { output: 'pushed' } });

    expect(
      handleWebviewMessage(
        { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root, sync: { push: syncPush, pull: vi.fn(), listRemote: vi.fn() }, writeExport },
        { id: 'export', type: 'export.markdown' },
      ),
    ).toMatchObject({ id: 'export', ok: true, data: { path: '/repo/.ariadne/export/task.md' } });
    workspace.close();
    cleanupRegistry();
  });
});
