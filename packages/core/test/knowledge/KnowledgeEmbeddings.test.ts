import { describe, expect, it } from 'vitest';
import { rankByEmbedding } from '../../src/knowledge/KnowledgeEmbeddings.js';

const candidates = [
  { id: 'a', text: 'database migrations' },
  { id: 'b', text: 'routing protocols' },
];

describe('KnowledgeEmbeddings', () => {
  it('uses a deterministic lexical fallback without a provider', async () => {
    const result = await rankByEmbedding('database', candidates);
    expect(result[0].candidate.id).toBe('a');
    expect(result.every((item) => item.method === 'lexical')).toBe(true);
  });

  it('ranks with an optional provider and validates dimensions', async () => {
    const result = await rankByEmbedding(
      'query',
      candidates,
      { embed: async (text) => (text === 'query' ? [1, 0] : text.includes('database') ? [1, 0] : [0, 1]) },
      { dimension: 2 },
    );
    expect(result[0].candidate.id).toBe('a');
    await expect(rankByEmbedding('query', candidates, { embed: async () => [1] }, { dimension: 2 })).rejects.toThrow(
      'dimension mismatch',
    );
  });

  it('rejects invalid timeout and times out slow providers', async () => {
    await expect(rankByEmbedding('query', candidates, undefined, { timeoutMs: 0 })).rejects.toThrow('positive');
    const provider = { embed: async () => new Promise<number[]>((resolve) => setTimeout(() => resolve([1, 0]), 30)) };
    await expect(rankByEmbedding('query', candidates, provider, { timeoutMs: 1 })).rejects.toThrow('timed out');
  });
});
