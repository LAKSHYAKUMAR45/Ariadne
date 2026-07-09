import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '../src/TaskStore.js';
import {
  buildContextWithEmbeddingRanking,
  cosineSimilarity,
  type EmbeddingProvider,
} from '../src/ContextBuilder.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 (not NaN) for a zero-magnitude vector', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

/**
 * A fake embedding provider for tests: represents each text as a bag-of-words
 * vector over a fixed vocabulary, so texts sharing more words are more
 * "similar" — good enough to deterministically verify ranking behavior
 * without any real model or network call.
 */
function fakeEmbeddingProvider(vocab: string[]): EmbeddingProvider {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const words = new Set(text.toLowerCase().split(/\W+/).filter(Boolean));
        return vocab.map((v) => (words.has(v) ? 1 : 0));
      });
    },
  };
}

const VOCAB = ['login', 'database', 'timeout', 'retry', 'cache', 'render', 'button', 'style'];

describe('buildContextWithEmbeddingRanking', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('throws for an unknown task', async () => {
    await expect(
      buildContextWithEmbeddingRanking(store, 'nope', 'login', fakeEmbeddingProvider(VOCAB)),
    ).rejects.toThrow(/No task found/);
  });

  it('always includes goal and latest checkpoint summary, uncapped by budget', async () => {
    const task = store.createTask({ title: 'Fix login bug', goal: 'Users cannot log in' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Found root cause' });

    const ctx = await buildContextWithEmbeddingRanking(store, task.id, 'login', fakeEmbeddingProvider(VOCAB), {
      tokenBudget: 0,
    });
    expect(ctx.goal).toBe('Users cannot log in');
    expect(ctx.latestSummary).toBe('Found root cause');
  });

  it('ranks candidates that are semantically closer to the query ahead of unrelated ones, regardless of tier/recency', async () => {
    const task = store.createTask({ title: 'Investigate flakiness' });

    // Medium-tier candidate that is highly relevant to the query...
    store.createTodo({ taskId: task.id, text: 'login database timeout issue' });

    // ...vs. a high-tier candidate that is completely unrelated to the query.
    store.recordOpenQuestion({ taskId: task.id, text: 'button render style question' });

    // With a tight budget that can only fit one candidate, similarity
    // ranking should prefer the relevant (but lower-tier) todo over the
    // irrelevant (but higher-tier) question — the opposite of what
    // buildContext's tier-first ordering would pick.
    const oneCandidateBudget = Math.ceil('login database timeout issue'.length / 4) + 1;
    const ctx = await buildContextWithEmbeddingRanking(
      store,
      task.id,
      'login database timeout',
      fakeEmbeddingProvider(VOCAB),
      { tokenBudget: oneCandidateBudget, topK: 1 },
    );
    expect(ctx.openTodos).toEqual(['login database timeout issue']);
    expect(ctx.openQuestions).toEqual([]);
  });

  it('falls back to tier order for candidates beyond topK so nothing is silently dropped when budget allows', async () => {
    const task = store.createTask({ title: 'Investigate flakiness' });
    store.recordOpenQuestion({ taskId: task.id, text: 'unrelated question one' });
    store.recordOpenQuestion({ taskId: task.id, text: 'unrelated question two' });

    const ctx = await buildContextWithEmbeddingRanking(store, task.id, 'login', fakeEmbeddingProvider(VOCAB), {
      tokenBudget: 10000,
      topK: 0,
    });
    // Neither question matches the query, but with topK=0 and a huge budget,
    // both should still appear via the tier-order fallback for the remainder.
    expect(ctx.openQuestions).toHaveLength(2);
  });

  it('respects the token budget via the same greedy fill as buildContext', async () => {
    const task = store.createTask({ title: 'A' });
    store.recordOpenQuestion({ taskId: task.id, text: 'login issue' });
    store.recordOpenQuestion({ taskId: task.id, text: 'a'.repeat(400) });

    const ctx = await buildContextWithEmbeddingRanking(store, task.id, 'login', fakeEmbeddingProvider(VOCAB), {
      tokenBudget: 20,
    });
    expect(ctx.truncated.openQuestions).toBeGreaterThanOrEqual(1);
  });

  it('returns an empty-but-valid package when there are no candidates at all', async () => {
    const task = store.createTask({ title: 'Empty task' });
    const ctx = await buildContextWithEmbeddingRanking(store, task.id, 'login', fakeEmbeddingProvider(VOCAB));
    expect(ctx.openQuestions).toEqual([]);
    expect(ctx.truncated).toEqual({});
  });
});
