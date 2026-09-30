import { describe, expect, it } from 'vitest';
import { orderHybridCandidates, type HybridLexicalEntry } from '../../src/knowledge/KnowledgeHybridOrdering.js';

function lexical(key: string, semanticScore: number, inCluster = false): HybridLexicalEntry {
  return { key, semanticScore, inCluster };
}

const keys = (ordering: ReturnType<typeof orderHybridCandidates>) => ordering.order.map((entry) => entry.key);

describe('orderHybridCandidates', () => {
  it('keeps a clear lexical order untouched and appends expansion candidates after every lexical one', () => {
    const ordering = orderHybridCandidates({
      lexical: [lexical('a', 0.1), lexical('b', 0.9), lexical('c', 0.5)],
      expansion: [
        { key: 'x', semanticScore: 0.99 },
        { key: 'y', semanticScore: 0.2 },
      ],
      confidence: 'clear',
      weakPool: true,
    });

    expect(keys(ordering)).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(ordering.order.map((entry) => entry.expanded)).toEqual([false, false, false, true, true]);
    expect(ordering.rescued).toBe(false);
  });

  it('reorders only the near-tie cluster slots by semantic score, keeping other positions', () => {
    const ordering = orderHybridCandidates({
      lexical: [lexical('a', 0.2, true), lexical('b', 0.9, true), lexical('c', 0.99), lexical('d', 0.5, true)],
      expansion: [],
      confidence: 'ambiguous',
      weakPool: false,
    });

    expect(keys(ordering)).toEqual(['b', 'd', 'c', 'a']);
    expect(ordering.rescued).toBe(false);
  });

  it('is stable for equal semantic scores inside a cluster', () => {
    const ordering = orderHybridCandidates({
      lexical: [lexical('a', 0.5, true), lexical('b', 0.5, true), lexical('c', 0.5, true)],
      expansion: [],
      confidence: 'ambiguous',
      weakPool: false,
    });

    expect(keys(ordering)).toEqual(['a', 'b', 'c']);
  });

  it('appends expansion candidates after lexical ones when ambiguous but a full-coverage lexical candidate exists', () => {
    const ordering = orderHybridCandidates({
      lexical: [lexical('a', 0.1, true), lexical('b', 0.2, true)],
      expansion: [{ key: 'x', semanticScore: 0.99 }],
      confidence: 'ambiguous',
      weakPool: false,
    });

    expect(keys(ordering)).toEqual(['b', 'a', 'x']);
    expect(ordering.rescued).toBe(false);
  });

  it('lets expansion candidates that outscore the whole cluster lead only for a weak ambiguous pool', () => {
    const ordering = orderHybridCandidates({
      lexical: [lexical('a', 0.3, true), lexical('b', 0.5, true), lexical('c', 0.1)],
      expansion: [
        { key: 'x', semanticScore: 0.4 },
        { key: 'y', semanticScore: 0.8 },
        { key: 'z', semanticScore: 0.7 },
      ],
      confidence: 'ambiguous',
      weakPool: true,
    });

    expect(keys(ordering)).toEqual(['y', 'z', 'b', 'a', 'c', 'x']);
    expect(ordering.rescued).toBe(true);
  });

  it('orders a lexically empty pool purely by expansion semantic score and reports a rescue', () => {
    const ordering = orderHybridCandidates({
      lexical: [],
      expansion: [
        { key: 'b', semanticScore: 0.3 },
        { key: 'a', semanticScore: 0.3 },
        { key: 'c', semanticScore: 0.6 },
      ],
      confidence: 'none',
      weakPool: true,
    });

    expect(keys(ordering)).toEqual(['c', 'a', 'b']);
    expect(ordering.rescued).toBe(true);
  });

  it('returns nothing for an empty pool', () => {
    expect(orderHybridCandidates({ lexical: [], expansion: [], confidence: 'none', weakPool: true })).toEqual({ order: [], rescued: false });
  });
});
