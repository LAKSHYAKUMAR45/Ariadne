import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openWorkspaceStore, closeRegistry } from '@ariadne-dev/core';
import { handleChatCommand } from '../src/commands.js';
import { closeAllStores } from '../src/storeCache.js';

// Exercises the chat participant's cross-workspace task resolution: task
// pause/done/archive/reopen with an explicit id, and /task list & /search
// with --all-workspaces, should all work across real workspace roots via
// the shared global registry (see resolveCrossWorkspaceTask in commands.ts).
describe('chat participant cross-workspace commands', () => {
  let tmpDir: string;
  let rootA: string;
  let rootB: string;
  let previousRegistryPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-ext-crossws-test-'));
    rootA = path.join(tmpDir, 'ws-a');
    rootB = path.join(tmpDir, 'ws-b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = path.join(tmpDir, 'registry.db');
    closeRegistry();
  });

  afterEach(() => {
    closeAllStores();
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('/task done <id> resolves and updates a task belonging to a different workspace', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = storeB.createTask({ title: 'Task in B' });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    const result = handleChatCommand(storeA, { command: 'task', prompt: `done ${task.id}`, workspaceRoot: rootA });
    expect(result.markdown).toContain(rootB);
    storeA.close();

    const verifyB = openWorkspaceStore(rootB);
    expect(verifyB.getTask(task.id)?.status).toBe('done');
    verifyB.close();
  });

  it('/task done <id> returns an error when the id is unknown everywhere', () => {
    const storeA = openWorkspaceStore(rootA);
    const result = handleChatCommand(storeA, { command: 'task', prompt: 'done nonexistent-id', workspaceRoot: rootA });
    expect(result.markdown).toContain('No task found');
    storeA.close();
  });

  it('/task list --all-workspaces lists tasks from every known workspace', () => {
    const storeA = openWorkspaceStore(rootA);
    const taskA = storeA.createTask({ title: 'A task' });
    storeA.close();

    const storeB = openWorkspaceStore(rootB);
    const taskB = storeB.createTask({ title: 'B task' });

    const result = handleChatCommand(storeB, { command: 'task', prompt: 'list --all-workspaces', workspaceRoot: rootB });
    expect(result.markdown).toContain(taskA.id);
    expect(result.markdown).toContain(taskB.id);
    expect(result.markdown).toContain(rootA);
    expect(result.markdown).toContain(rootB);
    storeB.close();
  });

  it('"list tasks in all workspaces" natural-language phrasing also works', () => {
    const storeA = openWorkspaceStore(rootA);
    const taskA = storeA.createTask({ title: 'A task' });

    const result = handleChatCommand(storeA, { prompt: 'list tasks in all workspaces', workspaceRoot: rootA });
    expect(result.markdown).toContain(taskA.id);
    storeA.close();
  });

  it('/search --all-workspaces finds matches across workspaces', () => {
    const storeA = openWorkspaceStore(rootA);
    const taskA = storeA.createTask({ title: 'Alpha task' });
    storeA.createCheckpoint({ taskId: taskA.id, level: 'micro', summary: 'a very unique marker string' });
    storeA.close();

    const storeB = openWorkspaceStore(rootB);
    const result = handleChatCommand(storeB, {
      command: 'search',
      prompt: 'unique marker --all-workspaces',
      workspaceRoot: rootB,
    });
    expect(result.markdown).toContain(taskA.id);
    expect(result.markdown).toContain(rootA);
    storeB.close();
  });

  it('/status <id> shows a task belonging to a different workspace', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = storeB.createTask({ title: 'Task in B', goal: 'Ship the feature' });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    const result = handleChatCommand(storeA, { command: 'status', prompt: task.id, workspaceRoot: rootA });
    expect(result.markdown).toContain('Task in B');
    expect(result.markdown).toContain(rootB);
    storeA.close();
  });

  it('/resume <id> returns an error when the id is unknown everywhere', () => {
    const storeA = openWorkspaceStore(rootA);
    const result = handleChatCommand(storeA, { command: 'resume', prompt: 'nonexistent-id', workspaceRoot: rootA });
    expect(result.markdown).toContain('No task found');
    storeA.close();
  });

  it('a plain @ariadne message with no recognized intent still falls back to the current task, ignoring the raw text as an id', () => {
    const storeA = openWorkspaceStore(rootA);
    const task = storeA.createTask({ title: 'Current task in A' });
    const result = handleChatCommand(storeA, { prompt: 'some unrecognized freeform message', currentTaskId: task.id, workspaceRoot: rootA });
    expect(result.markdown).toContain('Current task in A');
    storeA.close();
  });

  it('/todo done <id> --task <taskId> resolves a todo belonging to a different workspace', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = storeB.createTask({ title: 'Task in B' });
    const todo = storeB.createTodo({ taskId: task.id, text: 'fix the thing' });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    const result = handleChatCommand(storeA, {
      command: 'todo',
      prompt: `done ${todo.id} --task ${task.id}`,
      workspaceRoot: rootA,
    });
    expect(result.markdown).toContain('done');
    storeA.close();

    const verifyB = openWorkspaceStore(rootB);
    expect(verifyB.listTodos(task.id).find((t) => t.id === todo.id)?.status).toBe('done');
    verifyB.close();
  });

  it('/error resolve <id> --task <taskId> resolves an error belonging to a different workspace', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = storeB.createTask({ title: 'Task in B' });
    const err = storeB.recordError({ taskId: task.id, message: 'boom' });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    const result = handleChatCommand(storeA, {
      command: 'error',
      prompt: `resolve ${err.id} --task ${task.id}`,
      workspaceRoot: rootA,
    });
    expect(result.markdown).toContain('resolved');
    storeA.close();

    const verifyB = openWorkspaceStore(rootB);
    expect(verifyB.listErrors(task.id).find((e) => e.id === err.id)?.resolved).toBe(true);
    verifyB.close();
  });

  it('/question resolve <id> --task <taskId> resolves a question belonging to a different workspace', () => {
    const storeB = openWorkspaceStore(rootB);
    const task = storeB.createTask({ title: 'Task in B' });
    const q = storeB.recordOpenQuestion({ taskId: task.id, text: 'unix socket or TCP?' });
    storeB.close();

    const storeA = openWorkspaceStore(rootA);
    const result = handleChatCommand(storeA, {
      command: 'question',
      prompt: `resolve ${q.id} --task ${task.id}`,
      workspaceRoot: rootA,
    });
    expect(result.markdown).toContain('resolved');
    storeA.close();

    const verifyB = openWorkspaceStore(rootB);
    expect(verifyB.listOpenQuestions(task.id, { resolved: true }).find((x) => x.id === q.id)).toBeTruthy();
    verifyB.close();
  });
});
