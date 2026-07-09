import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '../src/TaskStore.js';
import { searchWorkspace } from '../src/Search.js';

describe('searchWorkspace', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('matches on task title and goal', () => {
    const a = store.createTask({ title: 'Fix login bug', goal: 'Users cannot authenticate' });
    store.createTask({ title: 'Unrelated task' });

    const results = searchWorkspace(store, 'login');
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe(a.id);
    expect(results[0].matches[0]).toMatchObject({ category: 'title' });

    const goalResults = searchWorkspace(store, 'authenticate');
    expect(goalResults[0].matches[0]).toMatchObject({ category: 'goal' });
  });

  it('matches across checkpoints, decisions, todos, errors, questions, files, and commits', () => {
    const task = store.createTask({ title: 'Networking work' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Wired up the socket transport' });
    store.recordDecision({ taskId: task.id, text: 'Use unix sockets for IPC' });
    store.createTodo({ taskId: task.id, text: 'Add socket permission checks' });
    store.recordError({ taskId: task.id, message: 'socket EACCES' });
    store.recordOpenQuestion({ taskId: task.id, text: 'Should sockets be per-workspace?' });
    store.touchFile({ taskId: task.id, path: 'src/socket.ts', role: 'edited' });
    store.recordCommit({ sha: 'abc123', taskId: task.id, message: 'feat: add socket transport' });

    const results = searchWorkspace(store, 'socket');
    expect(results).toHaveLength(1);
    const categories = results[0].matches.map((m) => m.category).sort();
    expect(categories).toEqual(['checkpoint', 'commit', 'decision', 'error', 'file', 'question', 'todo'].sort());
  });

  it('ranks tasks with more matches first', () => {
    const heavy = store.createTask({ title: 'apple task' });
    store.createTodo({ taskId: heavy.id, text: 'apple todo one' });
    store.createTodo({ taskId: heavy.id, text: 'apple todo two' });
    store.createTask({ title: 'just apple' });

    const results = searchWorkspace(store, 'apple');
    expect(results[0].taskId).toBe(heavy.id);
  });

  it('is case-insensitive', () => {
    store.createTask({ title: 'CaSe Sensitive Title' });
    expect(searchWorkspace(store, 'case sensitive')).toHaveLength(1);
    expect(searchWorkspace(store, 'CASE')).toHaveLength(1);
  });

  it('returns nothing for an empty or whitespace-only query', () => {
    store.createTask({ title: 'Anything' });
    expect(searchWorkspace(store, '')).toHaveLength(0);
    expect(searchWorkspace(store, '   ')).toHaveLength(0);
  });

  it('honors limit and maxMatchesPerTask', () => {
    for (let i = 0; i < 5; i++) {
      const t = store.createTask({ title: `banana task ${i}` });
      for (let j = 0; j < 5; j++) store.createTodo({ taskId: t.id, text: `banana todo ${j}` });
    }

    const results = searchWorkspace(store, 'banana', { limit: 2, maxMatchesPerTask: 3 });
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.matches.length).toBeLessThanOrEqual(3);
  });

  it('returns no results when nothing matches', () => {
    store.createTask({ title: 'Anything' });
    expect(searchWorkspace(store, 'nonexistent-needle')).toHaveLength(0);
  });
});
