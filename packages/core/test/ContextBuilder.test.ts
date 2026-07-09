import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '../src/TaskStore.js';
import { buildContext, estimateTokens, DEFAULT_TOKEN_BUDGET } from '../src/ContextBuilder.js';

describe('estimateTokens', () => {
  it('estimates roughly chars/4, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('buildContext', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('throws for an unknown task', () => {
    expect(() => buildContext(store, 'nope')).toThrow(/No task found/);
  });

  it('always includes goal and latest checkpoint summary, uncapped by budget', () => {
    const task = store.createTask({ title: 'Fix login bug', goal: 'Users cannot log in' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Reproduced the bug' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Found root cause' });

    // Budget of 0 would normally trim everything else, but never-trim items still show up.
    const ctx = buildContext(store, task.id, { tokenBudget: 0 });
    expect(ctx.goal).toBe('Users cannot log in');
    expect(ctx.latestSummary).toBe('Found root cause');
  });

  it('defaults to DEFAULT_TOKEN_BUDGET when no budget is given', () => {
    const task = store.createTask({ title: 'A' });
    const ctx = buildContext(store, task.id);
    expect(ctx.truncated).toEqual({});
    expect(DEFAULT_TOKEN_BUDGET).toBeGreaterThan(0);
  });

  it('separates current decisions (high tier) from superseded ones (low tier)', () => {
    const task = store.createTask({ title: 'A' });
    const oldDecision = store.recordDecision({ taskId: task.id, text: 'Use MySQL' });
    store.recordDecision({ taskId: task.id, text: 'Use SQLite instead', supersedesId: oldDecision.id });

    const ctx = buildContext(store, task.id, { tokenBudget: 10_000 });
    expect(ctx.decisions).toEqual(['Use SQLite instead']);
    expect(ctx.truncated).toEqual({});
  });

  it('prioritizes high tier over medium/low tier even when the high-tier item is older', () => {
    const task = store.createTask({ title: 'A' });
    // Same-length text everywhere so costs are equal and only tier ordering decides what fits.
    store.recordOpenQuestion({ taskId: task.id, text: 'AAAA' }); // high, oldest
    store.touchFile({ taskId: task.id, path: 'AAAA', role: 'edited' }); // medium
    store.createTodo({ taskId: task.id, text: 'AAAA' }); // medium (pending)
    const doneTodo = store.createTodo({ taskId: task.id, text: 'AAAA' });
    store.updateTodoStatus(doneTodo.id, 'done'); // low (resolved), newest

    // Budget for exactly one ranked item.
    const oneItemBudget = estimateTokens('AAAA');
    const ctx = buildContext(store, task.id, { tokenBudget: oneItemBudget });

    expect(ctx.openQuestions).toEqual(['AAAA']);
    expect(ctx.recentFiles).toEqual([]);
    expect(ctx.openTodos).toEqual([]);
    expect(ctx.truncated.recentFiles).toBe(1);
    expect(ctx.truncated.pendingTodos).toBe(1);
    expect(ctx.truncated.resolvedTodos).toBe(1);
  });

  it('with a large enough budget, includes everything and reports no truncation', () => {
    const task = store.createTask({ title: 'A' });
    store.recordOpenQuestion({ taskId: task.id, text: 'Which DB?' });
    store.recordError({ taskId: task.id, message: 'Build failed' });
    store.touchFile({ taskId: task.id, path: 'src/a.ts', role: 'edited' });
    store.createTodo({ taskId: task.id, text: 'Write tests' });
    store.recordCommand({ taskId: task.id, cmdRedacted: 'npm test', summary: '3 passed' });

    const ctx = buildContext(store, task.id, { tokenBudget: 10_000 });
    expect(ctx.openQuestions).toEqual(['Which DB?']);
    expect(ctx.unresolvedErrors).toEqual(['Build failed']);
    expect(ctx.recentFiles).toEqual([{ path: 'src/a.ts', role: 'edited' }]);
    expect(ctx.openTodos).toEqual(['Write tests']);
    expect(ctx.recentCommands).toEqual([{ cmd: '3 passed', exitCode: null }]);
    expect(ctx.truncated).toEqual({});
  });

  it('surfaces recently run commands, most-recent-first, falling back to the raw redacted command when there is no summary', () => {
    const task = store.createTask({ title: 'A' });
    store.recordCommand({ taskId: task.id, cmdRedacted: 'npm install', summary: undefined, exitCode: 0 });
    store.recordCommand({ taskId: task.id, cmdRedacted: 'npm test', summary: '3 passed', exitCode: 1 });

    const ctx = buildContext(store, task.id, { tokenBudget: 10_000 });
    expect(ctx.recentCommands).toEqual([
      { cmd: '3 passed', exitCode: 1 },
      { cmd: 'npm install', exitCode: 0 },
    ]);
  });

  it('only includes commits recorded since the latest checkpoint', async () => {
    const task = store.createTask({ title: 'A' });
    store.recordCommit({ sha: 'aaa1111', taskId: task.id, message: 'before checkpoint' });
    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure distinct timestamps (ms resolution)
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'checkpoint' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.recordCommit({ sha: 'bbb2222', taskId: task.id, message: 'after checkpoint' });

    const ctx = buildContext(store, task.id, { tokenBudget: 10_000 });
    expect(ctx.recentCommits).toEqual([{ sha: 'bbb2222', message: 'after checkpoint' }]);
  });

  it('produces a JSON-serializable, structured package (not a rendered string)', () => {
    const task = store.createTask({ title: 'A', goal: 'B' });
    const ctx = buildContext(store, task.id);
    expect(() => JSON.stringify(ctx)).not.toThrow();
    expect(ctx.taskId).toBe(task.id);
  });
});
