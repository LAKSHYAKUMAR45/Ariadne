import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '@ariadne/core';
import { handleChatCommand, formatStatus, formatStatusSections } from '../src/commands.js';

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

  describe('natural language intent routing (no slash command)', () => {
    it('creates a task from "new task: <title>" phrasing', () => {
      const result = handleChatCommand(store, { prompt: 'new task: Implement auth' });
      expect(result.newCurrentTaskId).toBeTruthy();
      expect(result.markdown).toContain('Implement auth');
    });

    it('creates a task from "start a task <title>" phrasing', () => {
      const result = handleChatCommand(store, { prompt: 'start a task refactor the parser' });
      expect(result.newCurrentTaskId).toBeTruthy();
      const task = store.getTask(result.newCurrentTaskId!);
      expect(task?.title).toBe('refactor the parser');
    });

    it('adds a todo from "remind me to <text>" phrasing', () => {
      const task = store.createTask({ title: 'Task with todos' });
      const result = handleChatCommand(store, { prompt: 'remind me to write the changelog', currentTaskId: task.id });
      expect(result.markdown).toMatch(/write the changelog/);
      const todos = store.listTodos(task.id);
      expect(todos.some((t) => t.text === 'write the changelog')).toBe(true);
    });

    it('marks a todo done from "mark todo <id> done" phrasing', () => {
      const task = store.createTask({ title: 'Task with todos' });
      const added = handleChatCommand(store, { command: 'todo', prompt: 'add Ship it', currentTaskId: task.id });
      const todoId = added.markdown.match(/`([0-9A-Z]+)`/)![1];

      handleChatCommand(store, { prompt: `mark todo ${todoId} done`, currentTaskId: task.id });
      expect(store.getTodo(todoId)?.status).toBe('done');
    });

    it('records a decision from "decision: <text>" phrasing', () => {
      const task = store.createTask({ title: 'Task with decisions' });
      handleChatCommand(store, { prompt: 'decision: use SQLite for storage', currentTaskId: task.id });
      const status = formatStatus(store, task.id);
      expect(store.listDecisions(task.id).some((d) => d.text === 'use SQLite for storage')).toBe(true);
      // formatStatus now delegates to buildContext (shared with CLI/MCP), which
      // does render current decisions as a ranked context category.
      expect(status).toContain('use SQLite for storage');
      expect(status).toContain('Task with decisions');
    });

    it('records an error from "error: <text>" phrasing', () => {
      const task = store.createTask({ title: 'Task with errors' });
      handleChatCommand(store, { prompt: 'error: build fails on CI', currentTaskId: task.id });
      expect(formatStatus(store, task.id)).toContain('build fails on CI');
    });

    it('routes "status"/"how\'s it going" to the status view', () => {
      const task = store.createTask({ title: 'Status phrasing task' });
      const result = handleChatCommand(store, { prompt: "how's it going", currentTaskId: task.id });
      expect(result.markdown).toContain('Status phrasing task');
    });
  });

  it('formatStatusSections delegates to buildContext, honoring a token budget like the CLI/MCP surfaces', () => {
    const task = store.createTask({ title: 'Budget task', goal: 'Ship the thing' });
    store.createCheckpoint({ taskId: task.id, level: 'session', summary: 'made progress' });
    for (let i = 0; i < 20; i++) {
      store.createTodo({ taskId: task.id, text: `todo number ${i} with some extra padding text to add up tokens` });
    }

    const unbudgeted = formatStatusSections(store, task.id).join('\n\n');
    const budgeted = formatStatusSections(store, task.id, 50).join('\n\n');

    expect(unbudgeted).toContain('todo number 19');
    expect(budgeted.length).toBeLessThan(unbudgeted.length);
    expect(budgeted).toContain('Trimmed to fit token budget');
  });
});
