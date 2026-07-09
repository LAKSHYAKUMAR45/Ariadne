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

  it('pauses, completes, archives, and reopens the current task via /task', () => {
    const task = store.createTask({ title: 'Lifecycle task' });

    handleChatCommand(store, { command: 'task', prompt: 'pause', currentTaskId: task.id });
    expect(store.getTask(task.id)?.status).toBe('paused');

    handleChatCommand(store, { command: 'task', prompt: 'done', currentTaskId: task.id });
    expect(store.getTask(task.id)?.status).toBe('done');

    handleChatCommand(store, { command: 'task', prompt: 'archive', currentTaskId: task.id });
    expect(store.getTask(task.id)?.status).toBe('archived');

    handleChatCommand(store, { command: 'task', prompt: 'reopen', currentTaskId: task.id });
    expect(store.getTask(task.id)?.status).toBe('active');
  });

  it('supports /task pause|done|archive|reopen with an explicit task id, independent of the current task', () => {
    const current = store.createTask({ title: 'Current task' });
    const other = store.createTask({ title: 'Other task' });

    handleChatCommand(store, { command: 'task', prompt: `done ${other.id}`, currentTaskId: current.id });
    expect(store.getTask(other.id)?.status).toBe('done');
    expect(store.getTask(current.id)?.status).toBe('active');
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

  it('searches across tasks and their entities via /search', () => {
    const task = store.createTask({ title: 'Networking work' });
    store.createTodo({ taskId: task.id, text: 'Pick a transport for IPC' });
    store.createTask({ title: 'Unrelated task' });

    const result = handleChatCommand(store, { command: 'search', prompt: 'transport', currentTaskId: task.id });
    expect(result.markdown).toContain('Networking work');
    expect(result.markdown).toContain('transport');
    expect(result.markdown).not.toContain('Unrelated task');
  });

  it('reports no matches for a /search with no hits', () => {
    store.createTask({ title: 'Anything' });
    const result = handleChatCommand(store, { command: 'search', prompt: 'nonexistent-needle' });
    expect(result.markdown).toMatch(/no matches/i);
  });

  it('adds, lists, and resolves an open question via /question', () => {
    const task = store.createTask({ title: 'Task with questions' });
    const added = handleChatCommand(store, {
      command: 'question',
      prompt: 'add Unix socket or TCP for IPC?',
      currentTaskId: task.id,
    });
    const questionId = added.markdown.match(/`([0-9A-Z]+)`/)![1];
    expect(formatStatus(store, task.id)).toContain('Unix socket or TCP for IPC?');

    const list = handleChatCommand(store, { command: 'question', prompt: 'list', currentTaskId: task.id });
    expect(list.markdown).toContain('Unix socket or TCP for IPC?');

    handleChatCommand(store, { command: 'question', prompt: `resolve ${questionId}`, currentTaskId: task.id });
    expect(store.listOpenQuestions(task.id, { resolved: false })).toHaveLength(0);
  });

  it('falls back to status for a plain @ariadne message with no slash command', () => {
    const task = store.createTask({ title: 'Plain message task', goal: 'Just chat' });
    const result = handleChatCommand(store, { prompt: 'what are we doing again?', currentTaskId: task.id });
    expect(result.markdown).toContain('Plain message task');
  });

  it('edits task title/goal via /task edit', () => {
    const task = store.createTask({ title: 'Old title', goal: 'Old goal' });
    handleChatCommand(store, { command: 'task', prompt: 'edit --title New title', currentTaskId: task.id });
    expect(store.getTask(task.id)?.title).toBe('New title');
    expect(store.getTask(task.id)?.goal).toBe('Old goal');

    handleChatCommand(store, { command: 'task', prompt: 'edit --goal New goal', currentTaskId: task.id });
    expect(store.getTask(task.id)?.goal).toBe('New goal');
  });

  it('reopens, blocks, edits, and deletes a todo via /todo', () => {
    const task = store.createTask({ title: 'Todo curation task' });
    const created = store.createTodo({ taskId: task.id, text: 'Write tests' });

    handleChatCommand(store, { command: 'todo', prompt: `done ${created.id}`, currentTaskId: task.id });
    expect(store.getTodo(created.id)?.status).toBe('done');

    handleChatCommand(store, { command: 'todo', prompt: `reopen ${created.id}`, currentTaskId: task.id });
    expect(store.getTodo(created.id)?.status).toBe('pending');

    handleChatCommand(store, { command: 'todo', prompt: `block ${created.id}`, currentTaskId: task.id });
    expect(store.getTodo(created.id)?.status).toBe('blocked');

    handleChatCommand(store, {
      command: 'todo',
      prompt: `edit ${created.id} --text Write more tests`,
      currentTaskId: task.id,
    });
    expect(store.getTodo(created.id)?.text).toBe('Write more tests');

    handleChatCommand(store, { command: 'todo', prompt: `delete ${created.id}`, currentTaskId: task.id });
    expect(store.getTodo(created.id)).toBeUndefined();
  });

  it('lists, edits, and deletes decisions via /decision', () => {
    const task = store.createTask({ title: 'Decision curation task' });
    const decision = store.recordDecision({ taskId: task.id, text: 'Use SQLite', rationale: 'simple' });

    const list = handleChatCommand(store, { command: 'decision', prompt: 'list', currentTaskId: task.id });
    expect(list.markdown).toContain('Use SQLite');

    handleChatCommand(store, {
      command: 'decision',
      prompt: `edit ${decision.id} --text Use Postgres`,
      currentTaskId: task.id,
    });
    expect(store.getDecision(decision.id)?.text).toBe('Use Postgres');

    handleChatCommand(store, { command: 'decision', prompt: `delete ${decision.id}`, currentTaskId: task.id });
    expect(store.getDecision(decision.id)).toBeUndefined();
  });

  it('reopens, edits, and deletes an error via /error', () => {
    const task = store.createTask({ title: 'Error curation task' });
    const err = store.recordError({ taskId: task.id, message: 'TypeError: x is undefined' });

    handleChatCommand(store, { command: 'error', prompt: `resolve ${err.id}`, currentTaskId: task.id });
    expect(store.getError(err.id)?.resolved).toBe(true);

    handleChatCommand(store, { command: 'error', prompt: `reopen ${err.id}`, currentTaskId: task.id });
    expect(store.getError(err.id)?.resolved).toBe(false);

    handleChatCommand(store, {
      command: 'error',
      prompt: `edit ${err.id} --message Fixed message`,
      currentTaskId: task.id,
    });
    expect(store.getError(err.id)?.message).toBe('Fixed message');

    handleChatCommand(store, { command: 'error', prompt: `delete ${err.id}`, currentTaskId: task.id });
    expect(store.getError(err.id)).toBeUndefined();
  });

  it('reopens, edits, and deletes an open question via /question', () => {
    const task = store.createTask({ title: 'Question curation task' });
    const q = store.recordOpenQuestion({ taskId: task.id, text: 'Should we use X?' });

    handleChatCommand(store, { command: 'question', prompt: `resolve ${q.id}`, currentTaskId: task.id });
    expect(store.getOpenQuestion(q.id)?.resolved).toBe(true);

    handleChatCommand(store, { command: 'question', prompt: `reopen ${q.id}`, currentTaskId: task.id });
    expect(store.getOpenQuestion(q.id)?.resolved).toBe(false);

    handleChatCommand(store, {
      command: 'question',
      prompt: `edit ${q.id} --text Should we use Y?`,
      currentTaskId: task.id,
    });
    expect(store.getOpenQuestion(q.id)?.text).toBe('Should we use Y?');

    handleChatCommand(store, { command: 'question', prompt: `delete ${q.id}`, currentTaskId: task.id });
    expect(store.getOpenQuestion(q.id)).toBeUndefined();
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

    it('records an open question from "question: <text>" phrasing', () => {
      const task = store.createTask({ title: 'Task with questions' });
      handleChatCommand(store, { prompt: 'question: does this support multi-repo?', currentTaskId: task.id });
      expect(store.listOpenQuestions(task.id).some((q) => q.text === 'does this support multi-repo?')).toBe(true);
    });

    it('resolves an open question from "resolve question <id>" phrasing', () => {
      const task = store.createTask({ title: 'Task with questions' });
      const added = handleChatCommand(store, { command: 'question', prompt: 'add pick a transport', currentTaskId: task.id });
      const questionId = added.markdown.match(/`([0-9A-Z]+)`/)![1];

      handleChatCommand(store, { prompt: `resolve question ${questionId}`, currentTaskId: task.id });
      expect(store.listOpenQuestions(task.id, { resolved: false })).toHaveLength(0);
    });

    it('routes "status"/"how\'s it going" to the status view', () => {
      const task = store.createTask({ title: 'Status phrasing task' });
      const result = handleChatCommand(store, { prompt: "how's it going", currentTaskId: task.id });
      expect(result.markdown).toContain('Status phrasing task');
    });

    it('pauses, completes, archives, and reopens the current task from plain-language phrasing', () => {
      const task = store.createTask({ title: 'Lifecycle phrasing task' });

      handleChatCommand(store, { prompt: 'pause', currentTaskId: task.id });
      expect(store.getTask(task.id)?.status).toBe('paused');

      handleChatCommand(store, { prompt: 'mark task done', currentTaskId: task.id });
      expect(store.getTask(task.id)?.status).toBe('done');

      handleChatCommand(store, { prompt: 'archive', currentTaskId: task.id });
      expect(store.getTask(task.id)?.status).toBe('archived');

      handleChatCommand(store, { prompt: 'reopen', currentTaskId: task.id });
      expect(store.getTask(task.id)?.status).toBe('active');
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
