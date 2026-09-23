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
  it('creates a task and selects it for the webview', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('task-create');
    const setCurrentTaskId = vi.fn();

    const response = handleWebviewMessage(
      { store: workspace.store, workspaceRoot: workspace.root, setCurrentTaskId },
      { id: 'task-create', type: 'task.create', payload: { title: 'New task', goal: 'Ship P1' } },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ title: 'New task', goal: 'Ship P1', status: 'active' });
      expect(response.state?.currentTask?.title).toBe('New task');
      expect(response.state?.currentTask?.goal).toBe('Ship P1');
    }
    expect(setCurrentTaskId).toHaveBeenCalledWith(expect.any(String));
    workspace.close();
    cleanupRegistry();
  });

  it('edits a task and applies lifecycle status transitions', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('task-lifecycle');
    const task = workspace.store.getTask(workspace.taskId)!;

    const edit = handleWebviewMessage(
      { store: workspace.store, currentTaskId: task.id, workspaceRoot: workspace.root },
      { id: 'task-edit', type: 'task.update', payload: { title: 'Renamed', goal: 'Updated goal' } },
    );
    expect(edit.ok).toBe(true);

    const status = handleWebviewMessage(
      { store: workspace.store, currentTaskId: task.id, workspaceRoot: workspace.root },
      { id: 'task-status', type: 'task.setStatus', payload: { status: 'paused' } },
    );
    expect(status.ok).toBe(true);
    expect(workspace.store.getTask(task.id)).toMatchObject({ title: 'Renamed', goal: 'Updated goal', status: 'paused' });

    const done = handleWebviewMessage(
      { store: workspace.store, currentTaskId: task.id, workspaceRoot: workspace.root },
      { id: 'task-done', type: 'task.setStatus', payload: { id: task.id, status: 'done' } },
    );
    expect(done.ok).toBe(true);
    expect(workspace.store.getTask(task.id)?.status).toBe('done');
    workspace.close();
    cleanupRegistry();
  });

  it('creates a checkpoint and returns it in refreshed state', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('checkpoint-create');
    const response = handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root },
      { id: 'checkpoint-create', type: 'checkpoint.create', payload: { summary: 'P1 contract complete', level: 'session' } },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ summary: 'P1 contract complete', level: 'session', taskId: workspace.taskId });
      expect(response.state?.checkpoints[0].summary).toBe('P1 contract complete');
    }
    workspace.close();
    cleanupRegistry();
  });

  it('returns ContextBuilder resume data and includes it with markdown export', () => {
    const cleanupRegistry = setupRegistry();
    const workspace = makeWorkspace('context-export');
    workspace.store.createCheckpoint({ taskId: workspace.taskId, level: 'session', summary: 'Resume from here' });

    const context = handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root },
      { id: 'context', type: 'context.get', payload: { tokenBudget: 500 } },
    );
    expect(context).toMatchObject({
      id: 'context',
      ok: true,
      data: {
        context: {
          taskId: workspace.taskId,
          latestSummary: 'Resume from here',
          openTodos: ['Write host tests'],
        },
      },
    });

    const exportPath = path.join(workspace.root, 'task.md');
    const exported = handleWebviewMessage(
      { store: workspace.store, currentTaskId: workspace.taskId, workspaceRoot: workspace.root, writeExport: () => exportPath },
      { id: 'export-context', type: 'export.markdown' },
    );
    expect(exported).toMatchObject({
      id: 'export-context',
      ok: true,
      data: {
        path: exportPath,
        markdown: expect.stringContaining('Resume from here'),
        context: { taskId: workspace.taskId, latestSummary: 'Resume from here' },
      },
    });
    workspace.close();
    cleanupRegistry();
  });

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
    const setCurrentTaskIdForWorkspace = vi.fn();

    const response = handleWebviewMessage(
      {
        store: current.store,
        currentTaskId: current.taskId,
        workspaceRoot: current.root,
        setCurrentTaskId,
        setCurrentTaskIdForWorkspace,
      },
      { id: 'switch-cross', type: 'task.switch', payload: { id: other.taskId } },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.state?.currentTask?.id).toBe(other.taskId);
      expect(response.state?.workspaceRoot).toBe(other.root);
      expect(response.state?.currentTaskId).toBe(other.taskId);
    }
    expect(setCurrentTaskId).not.toHaveBeenCalled();
    expect(setCurrentTaskIdForWorkspace).toHaveBeenCalledWith(other.taskId, other.root);
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
    const setCurrentTaskIdForWorkspace = vi.fn();

    const response = handleWebviewMessage(
      {
        store: workspace.store,
        currentTaskId: workspace.taskId,
        workspaceRoot: workspace.root,
        setCurrentTaskId,
        setCurrentTaskIdForWorkspace,
      },
      { id: 'switch-local', type: 'task.switch', payload: { id: second.id } },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.state?.currentTask?.id).toBe(second.id);
      expect(response.state?.workspaceRoot).toBe(workspace.root);
      expect(response.state?.currentTaskId).toBe(second.id);
    }
    expect(setCurrentTaskId).toHaveBeenCalledWith(second.id);
    expect(setCurrentTaskIdForWorkspace).not.toHaveBeenCalled();
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
