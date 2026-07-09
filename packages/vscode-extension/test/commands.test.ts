import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '@ariadne/core';
import { handleChatCommand, formatStatus } from '../src/commands.js';

describe('chat participant command logic', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('creates a task via /task new and marks it current', () => {
    const result = handleChatCommand(store, { command: 'task', prompt: 'new Implement auth' });
    expect(result.newCurrentTaskId).toBeTruthy();
    expect(result.markdown).toContain('Implement auth');

    const task = store.getTask(result.newCurrentTaskId!);
    expect(task?.title).toBe('Implement auth');
  });

  it('reports no current task for /status when none is set', () => {
    const result = handleChatCommand(store, { command: 'status', prompt: '' });
    expect(result.markdown).toMatch(/no current task/i);
  });

  it('adds and lists todos scoped to the current task', () => {
    const task = store.createTask({ title: 'Task with todos' });
    handleChatCommand(store, { command: 'todo', prompt: 'add Write tests', currentTaskId: task.id });
    handleChatCommand(store, { command: 'todo', prompt: 'add Wire up MCP', currentTaskId: task.id });

    const list = handleChatCommand(store, { command: 'todo', prompt: 'list', currentTaskId: task.id });
    expect(list.markdown).toContain('Write tests');
    expect(list.markdown).toContain('Wire up MCP');
  });

  it('marks a todo done via /todo done <id>', () => {
    const task = store.createTask({ title: 'Task with todos' });
    const added = handleChatCommand(store, { command: 'todo', prompt: 'add Ship it', currentTaskId: task.id });
    const idMatch = added.markdown.match(/`([0-9A-Z]+)`/);
    expect(idMatch).toBeTruthy();
    const todoId = idMatch![1];

    handleChatCommand(store, { command: 'todo', prompt: `done ${todoId}`, currentTaskId: task.id });
    expect(store.getTodo(todoId)?.status).toBe('done');
  });

  it('records a checkpoint and reflects it in formatStatus', () => {
    const task = store.createTask({ title: 'Task with checkpoint' });
    handleChatCommand(store, { command: 'checkpoint', prompt: 'Wired up SQLite schema', currentTaskId: task.id });

    const status = formatStatus(store, task.id);
    expect(status).toContain('Wired up SQLite schema');
  });

  it('records and resolves an error', () => {
    const task = store.createTask({ title: 'Task with error' });
    const recorded = handleChatCommand(store, { command: 'error', prompt: 'TypeError: x is undefined', currentTaskId: task.id });
    const idMatch = recorded.markdown.match(/`([0-9A-Z]+)`/);
    const errorId = idMatch![1];

    expect(formatStatus(store, task.id)).toContain('TypeError');
    handleChatCommand(store, { command: 'error', prompt: `resolve ${errorId}`, currentTaskId: task.id });
    expect(store.listErrors(task.id, { resolved: false })).toHaveLength(0);
  });

  it('falls back to status for a plain @ariadne message with no slash command', () => {
    const task = store.createTask({ title: 'Plain message task', goal: 'Just chat' });
    const result = handleChatCommand(store, { prompt: 'what are we doing again?', currentTaskId: task.id });
    expect(result.markdown).toContain('Plain message task');
  });
});
