import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TaskStore, closeRegistry, openWorkspaceStore, type TaskStore as WorkspaceTaskStore } from '@ariadne-dev/core';
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

function makeWorkspace(label: string): { root: string; store: WorkspaceTaskStore; taskId: string; close: () => void } {
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

function makeStore(): { store: TaskStore; task: ReturnType<TaskStore['createTask']> } {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ title: 'Webview task', goal: 'Webview task goal' });
  store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Webview task checkpoint' });
  store.createTodo({ taskId: task.id, text: 'Write host tests' });
  store.recordDecision({ taskId: task.id, text: 'Use a typed contract', rationale: 'Keep the host and webview aligned' });
  store.recordError({ taskId: task.id, message: 'Host capture failed' });
  store.recordOpenQuestion({ taskId: task.id, text: 'Which panel owns the preview?' });
  return { store, task };
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
  it('builds a reverse chronological activity timeline for the current task', () => {
    const { store, task } = makeStore();
    const resolvedQuestion = store.recordOpenQuestion({ taskId: task.id, text: 'Was the first pass approved?' });
    store.resolveOpenQuestion(resolvedQuestion.id);
    store.recordCommand({ taskId: task.id, cmdRedacted: 'pnpm test', exitCode: 0 });
    store.recordCommit({ taskId: task.id, sha: 'abcdef1234567890', message: 'feat: timeline' });

    const response = handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: 'activity', type: 'activity.list' },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      const items = (response.data as { items: Array<{ kind: string; title: string; detail?: string; createdAt: string }> }).items;
      const kinds = items.map((item) => item.kind);
      const createdAt = items.map((item) => item.createdAt);
      expect(response.data).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ kind: 'command', title: 'pnpm test', status: 'success' }),
          expect.objectContaining({ kind: 'commit', title: 'abcdef1', detail: 'feat: timeline', targetTab: 'files' }),
          expect.objectContaining({ kind: 'checkpoint', targetTab: 'overview' }),
          expect.objectContaining({ kind: 'todo', targetTab: 'todos' }),
          expect.objectContaining({ kind: 'decision', targetTab: 'decisions' }),
          expect.objectContaining({ kind: 'error', targetTab: 'errors', status: 'error' }),
          expect.objectContaining({ kind: 'question', targetTab: 'questions' }),
          expect.objectContaining({ kind: 'question', title: 'Was the first pass approved?', detail: 'Resolved', status: 'success' }),
        ]),
      });
      expect(createdAt).toEqual([...createdAt].sort((left, right) => right.localeCompare(left)));
      expect(kinds.indexOf('commit')).toBeLessThan(kinds.indexOf('checkpoint'));
      expect(kinds.indexOf('command')).toBeLessThan(kinds.indexOf('checkpoint'));
    }
    store.close();
  });

  it('returns capture health using explicit host capabilities and task state', () => {
    const { store, task } = makeStore();
    store.updateTaskBranch(task.id, 'feat/current');
    store.recordCommand({ taskId: task.id, cmdRedacted: 'pnpm build', exitCode: 1 });

    const response = handleWebviewMessage(
      {
        store,
        currentTaskId: task.id,
        workspaceRoot: '/repo',
        passiveCapture: {
          enabled: true,
          shellIntegrationAvailable: true,
          gitExtensionAvailable: false,
          currentBranch: 'main',
        },
      },
      { id: 'health', type: 'capture.health' },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({
        health: {
          workspaceRoot: '/repo',
          currentTaskId: task.id,
          passiveCaptureEnabled: true,
          shellIntegrationAvailable: true,
          gitExtensionAvailable: false,
          branchMatches: false,
          taskBranch: 'feat/current',
          currentBranch: 'main',
          unresolvedErrors: 1,
          warnings: expect.arrayContaining([expect.stringContaining('branch')]),
        },
      });
    }
    store.close();
  });

  it('returns empty activity and unknown health when no task is selected', () => {
    const store = new TaskStore(':memory:');

    expect(handleWebviewMessage({ store, workspaceRoot: '/repo' }, { id: 'activity-empty', type: 'activity.list' })).toMatchObject({
      id: 'activity-empty',
      ok: true,
      data: { items: [], truncated: false },
    });
    expect(handleWebviewMessage({ store, workspaceRoot: '/repo' }, { id: 'health-empty', type: 'capture.health' })).toMatchObject({
      id: 'health-empty',
      ok: true,
      data: { health: expect.objectContaining({ branchMatches: 'unknown', warnings: expect.arrayContaining([expect.stringContaining('No current task')]) }) },
    });
    expect(handleWebviewMessage({ store, workspaceRoot: '/repo' }, { id: 'context-empty', type: 'context.preview' })).toEqual({
      id: 'context-empty',
      ok: false,
      error: 'No current Ariadne task is selected.',
    });
    store.close();
  });

  it('returns a markdown context preview with a caller-selected token budget', () => {
    const { store, task } = makeStore();
    store.recordCommand({ taskId: task.id, cmdRedacted: 'pnpm install', summary: 'installed dependencies', exitCode: 0 });
    store.recordCommand({ taskId: task.id, cmdRedacted: 'pnpm test', summary: 'tests passed', exitCode: 0 });
    store.recordCommand({ taskId: task.id, cmdRedacted: 'pnpm build', summary: 'bundle failed', exitCode: 1 });

    const response = handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: 'context', type: 'context.preview', payload: { tokenBudget: 20 } },
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({
        preview: {
          tokenBudget: 20,
          markdown: expect.stringContaining('Webview task'),
          context: expect.objectContaining({ taskId: task.id, workspaceRoot: '/repo' }),
          sections: expect.arrayContaining([
            expect.objectContaining({ id: 'summary', label: 'Summary' }),
            expect.objectContaining({ id: 'todos', label: 'Todos' }),
            expect.objectContaining({ id: 'questions', label: 'Questions' }),
            expect.objectContaining({ id: 'errors', label: 'Errors' }),
            expect.objectContaining({ id: 'decisions', label: 'Decisions' }),
            expect.objectContaining({ id: 'files', label: 'Files' }),
            expect.objectContaining({ id: 'commits', label: 'Commits' }),
            expect.objectContaining({ id: 'commands', label: 'Commands', truncatedCount: expect.any(Number) }),
          ]),
        },
      });
      const preview = response.data as { preview: { context: { truncated: Record<string, number> }; sections: Array<{ id: string; truncatedCount?: number }> } };
      expect(preview.preview.context.truncated.commands).toBeGreaterThan(0);
      expect(preview.preview.sections.find((section) => section.id === 'commands')?.truncatedCount).toBe(
        preview.preview.context.truncated.commands,
      );
    }
    store.close();
  });

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
