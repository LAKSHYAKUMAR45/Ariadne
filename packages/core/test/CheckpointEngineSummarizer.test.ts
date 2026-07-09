import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '../src/TaskStore.js';
import {
  ruleBasedSummarizer,
  maybeCheckpointOnFileActivityWithSummarizer,
  checkpointOnCommitWithSummarizer,
  checkpointOnErrorWithSummarizer,
  maybeCheckpointOnIdleWithSummarizer,
  type CheckpointSummarizer,
} from '../src/CheckpointEngine.js';

/** A stand-in for an LLM-backed summarizer plugin: deterministic, but clearly not a rule-based template. */
function makeFakeLlmSummarizer(): CheckpointSummarizer {
  return {
    async summarizeFileBatch(paths) {
      return `[llm] touched ${paths.length} files`;
    },
    async summarizeCommit(sha) {
      return `[llm] shipped ${sha.slice(0, 4)}`;
    },
    async summarizeError(message) {
      return `[llm] investigate: ${message}`;
    },
    async summarizeIdle(filesTouched) {
      return `[llm] idle after ${filesTouched} edits`;
    },
  };
}

describe('ruleBasedSummarizer', () => {
  it('matches the plain summarize* function output for each method', async () => {
    expect(await ruleBasedSummarizer.summarizeFileBatch(['a.ts', 'b.ts'])).toBe('Edited 2 files: a.ts, b.ts');
    expect(await ruleBasedSummarizer.summarizeCommit('abcdef1234567', 'Fix bug')).toBe('Committed abcdef1: Fix bug');
    expect(await ruleBasedSummarizer.summarizeError('Build failed')).toBe('New error: Build failed');
    expect(await ruleBasedSummarizer.summarizeIdle(3)).toBe('Session paused after 3 files touched (idle).');
  });
});

describe('summarizer-aware CheckpointEngine triggers', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('maybeCheckpointOnFileActivityWithSummarizer defaults to the rule-based summarizer when none is passed', async () => {
    const task = store.createTask({ title: 'A' });
    for (let i = 0; i < 5; i++) store.touchFile({ taskId: task.id, path: `f${i}.ts`, role: 'edited' });

    const cp = await maybeCheckpointOnFileActivityWithSummarizer(store, task.id);
    expect(cp).not.toBeNull();
    expect(cp!.summary).toContain('Edited 5 files');
  });

  it('maybeCheckpointOnFileActivityWithSummarizer defers to a custom summarizer and respects the same threshold rule', async () => {
    const task = store.createTask({ title: 'A' });
    for (let i = 0; i < 4; i++) store.touchFile({ taskId: task.id, path: `f${i}.ts`, role: 'edited' });

    const llm = makeFakeLlmSummarizer();
    expect(await maybeCheckpointOnFileActivityWithSummarizer(store, task.id, llm, { threshold: 5 })).toBeNull();

    store.touchFile({ taskId: task.id, path: 'f4.ts', role: 'edited' });
    const cp = await maybeCheckpointOnFileActivityWithSummarizer(store, task.id, llm, { threshold: 5 });
    expect(cp).not.toBeNull();
    expect(cp!.level).toBe('micro');
    expect(cp!.summary).toBe('[llm] touched 5 files');
  });

  it('checkpointOnCommitWithSummarizer and checkpointOnErrorWithSummarizer use the supplied summarizer', async () => {
    const task = store.createTask({ title: 'A' });
    const llm = makeFakeLlmSummarizer();

    const commitCp = await checkpointOnCommitWithSummarizer(store, task.id, 'abcdef1234567', 'Fix bug', llm);
    expect(commitCp.summary).toBe('[llm] shipped abcd');
    expect(commitCp.level).toBe('micro');

    const errorCp = await checkpointOnErrorWithSummarizer(store, task.id, 'Build failed', llm);
    expect(errorCp.summary).toBe('[llm] investigate: Build failed');
  });

  it('maybeCheckpointOnIdleWithSummarizer respects the idle-time rule and uses the supplied summarizer', async () => {
    const task = store.createTask({ title: 'A' });
    store.touchFile({ taskId: task.id, path: 'f0.ts', role: 'edited' });
    const llm = makeFakeLlmSummarizer();

    // No prior checkpoint, so "since" is Infinity: any idleMinutes threshold is satisfied immediately.
    const cp = await maybeCheckpointOnIdleWithSummarizer(store, task.id, llm, { idleMinutes: 10 });
    expect(cp).not.toBeNull();
    expect(cp!.summary).toBe('[llm] idle after 1 edits');

    // Now there's a checkpoint and no new file activity since it — shouldn't trigger again.
    const again = await maybeCheckpointOnIdleWithSummarizer(store, task.id, llm, { idleMinutes: 10 });
    expect(again).toBeNull();
  });
});
