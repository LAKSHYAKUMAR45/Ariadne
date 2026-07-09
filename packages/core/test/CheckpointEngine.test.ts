import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '../src/TaskStore.js';
import {
  maybeCheckpointOnFileActivity,
  checkpointOnCommit,
  checkpointOnError,
  maybeCheckpointOnIdle,
  rollupCheckpoints,
  summarizeFileBatch,
  summarizeCommit,
  summarizeError,
  summarizeIdle,
} from '../src/CheckpointEngine.js';

describe('summarize* rule-based generators', () => {
  it('summarizeFileBatch lists files, capping and counting overflow', () => {
    expect(summarizeFileBatch(['a.ts', 'b.ts'])).toBe('Edited 2 files: a.ts, b.ts');
    expect(summarizeFileBatch(['a.ts'])).toBe('Edited 1 file: a.ts');
    const many = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    expect(summarizeFileBatch(many)).toBe('Edited 10 files: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts (+2 more)');
  });

  it('summarizeCommit shortens the sha and includes the message', () => {
    expect(summarizeCommit('abcdef1234567', 'Fix bug')).toBe('Committed abcdef1: Fix bug');
    expect(summarizeCommit('abcdef1234567', null)).toBe('Committed abcdef1');
  });

  it('summarizeError/summarizeIdle format plainly', () => {
    expect(summarizeError('Build failed')).toBe('New error: Build failed');
    expect(summarizeIdle(3)).toBe('Session paused after 3 files touched (idle).');
    expect(summarizeIdle(1)).toBe('Session paused after 1 file touched (idle).');
  });
});

describe('CheckpointEngine triggers', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('maybeCheckpointOnFileActivity only triggers once the threshold is met', () => {
    const task = store.createTask({ title: 'A' });
    for (let i = 0; i < 4; i++) store.touchFile({ taskId: task.id, path: `f${i}.ts`, role: 'edited' });

    expect(maybeCheckpointOnFileActivity(store, task.id, { threshold: 5 })).toBeNull();

    store.touchFile({ taskId: task.id, path: 'f4.ts', role: 'edited' });
    const cp = maybeCheckpointOnFileActivity(store, task.id, { threshold: 5 });
    expect(cp).not.toBeNull();
    expect(cp!.level).toBe('micro');
    expect(cp!.summary).toContain('Edited 5 files');
  });

  it('maybeCheckpointOnFileActivity only counts files touched since the last checkpoint', () => {
    const task = store.createTask({ title: 'A' });
    for (let i = 0; i < 5; i++) store.touchFile({ taskId: task.id, path: `f${i}.ts`, role: 'edited' });
    const first = maybeCheckpointOnFileActivity(store, task.id, { threshold: 5 });
    expect(first).not.toBeNull();

    // No new files touched since — shouldn't trigger again.
    expect(maybeCheckpointOnFileActivity(store, task.id, { threshold: 5 })).toBeNull();
  });

  it('checkpointOnCommit and checkpointOnError always create a checkpoint', () => {
    const task = store.createTask({ title: 'A' });
    const commitCp = checkpointOnCommit(store, task.id, 'abcdef1234567', 'Fix bug');
    expect(commitCp.summary).toBe('Committed abcdef1: Fix bug');

    const errorCp = checkpointOnError(store, task.id, 'Build failed');
    expect(errorCp.summary).toBe('New error: Build failed');
  });

  it('maybeCheckpointOnIdle triggers only after idle threshold with prior file activity', async () => {
    const task = store.createTask({ title: 'A' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'first' });
    const latest = store.latestCheckpoint(task.id)!;

    // No files touched since checkpoint -> no idle checkpoint even if "now" is far in the future.
    const farFuture = new Date(Date.parse(latest.createdAt) + 60 * 60_000);
    expect(maybeCheckpointOnIdle(store, task.id, { idleMinutes: 10, now: farFuture })).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure distinct timestamp (ms resolution)
    store.touchFile({ taskId: task.id, path: 'a.ts', role: 'edited' });

    // Not idle long enough yet.
    const soon = new Date(Date.parse(latest.createdAt) + 2 * 60_000);
    expect(maybeCheckpointOnIdle(store, task.id, { idleMinutes: 10, now: soon })).toBeNull();

    // Idle long enough.
    const cp = maybeCheckpointOnIdle(store, task.id, { idleMinutes: 10, now: farFuture });
    expect(cp).not.toBeNull();
    expect(cp!.summary).toContain('idle');
  });
});

describe('rollupCheckpoints', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('returns null when there is nothing to roll up', () => {
    const task = store.createTask({ title: 'A' });
    expect(rollupCheckpoints(store, task.id, 'micro', 'session')).toBeNull();
  });

  it('rolls up micro checkpoints into a session checkpoint, deduping identical summaries, and re-parents them', () => {
    const task = store.createTask({ title: 'A' });
    const c1 = store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Edited 5 files' });
    const c2 = store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Committed abc123: fix' });
    const c3 = store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Edited 5 files' }); // duplicate

    const session = rollupCheckpoints(store, task.id, 'micro', 'session');
    expect(session).not.toBeNull();
    expect(session!.level).toBe('session');
    expect(session!.summary).toBe('- Edited 5 files\n- Committed abc123: fix');

    for (const c of [c1, c2, c3]) {
      expect(store.getCheckpoint(c.id)!.parentCheckpointId).toBe(session!.id);
    }
  });

  it('only rolls up items since the last session-or-higher checkpoint (no double rollup)', async () => {
    const task = store.createTask({ title: 'A' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'batch 1' });
    const firstSession = rollupCheckpoints(store, task.id, 'micro', 'session');
    expect(firstSession).not.toBeNull();

    // No new micro checkpoints since the rollup -> nothing left to roll up.
    expect(rollupCheckpoints(store, task.id, 'micro', 'session')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure distinct timestamp (ms resolution)
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'batch 2' });
    const secondSession = rollupCheckpoints(store, task.id, 'micro', 'session');
    expect(secondSession).not.toBeNull();
    expect(secondSession!.summary).toBe('- batch 2');
  });

  it('rejects rolling up to an equal or lower level', () => {
    const task = store.createTask({ title: 'A' });
    expect(() => rollupCheckpoints(store, task.id, 'session', 'micro')).toThrow(/strictly higher level/);
    expect(() => rollupCheckpoints(store, task.id, 'session', 'session')).toThrow(/strictly higher level/);
  });

  it('rolls up session checkpoints into a milestone checkpoint', () => {
    const task = store.createTask({ title: 'A' });
    store.createCheckpoint({ taskId: task.id, level: 'session', summary: 'session A' });
    store.createCheckpoint({ taskId: task.id, level: 'session', summary: 'session B' });

    const milestone = rollupCheckpoints(store, task.id, 'session', 'milestone');
    expect(milestone!.level).toBe('milestone');
    expect(milestone!.summary).toBe('- session A\n- session B');
  });
});
