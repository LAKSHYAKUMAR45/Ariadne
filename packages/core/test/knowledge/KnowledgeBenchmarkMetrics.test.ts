import { describe, expect, it } from 'vitest';
import {
  calculateKnowledgeBenchmarkQuality,
  nearestRankPercentile,
  roundMetric,
} from './KnowledgeBenchmarkMetrics.js';

describe('calculateKnowledgeBenchmarkQuality', () => {
  it('calculates recall, MRR, nDCG, citation, graph, ambiguity, and zero rates', () => {
    const metrics = calculateKnowledgeBenchmarkQuality([
      {
        id: 'q1',
        expectedPaths: ['a.py'],
        results: [{ title: 'a.py', hasSpanCitation: true, searchConfidence: 'clear' }],
        hasTypedGraphEvidence: true,
      },
      {
        id: 'q2',
        expectedPaths: ['b.py'],
        results: [
          { title: 'x.py', hasSpanCitation: false, searchConfidence: 'ambiguous' },
          { title: 'y.py', hasSpanCitation: false, searchConfidence: null },
          { title: 'z.py', hasSpanCitation: false, searchConfidence: null },
          { title: 'b.py', hasSpanCitation: true, searchConfidence: null },
        ],
        hasTypedGraphEvidence: false,
      },
      {
        id: 'q3',
        expectedPaths: ['c.py'],
        results: [],
        hasTypedGraphEvidence: false,
      },
    ]);

    expect(metrics.recallAt1).toEqual({ count: 1, total: 3, rate: 0.333333 });
    expect(metrics.recallAt3).toEqual({ count: 1, total: 3, rate: 0.333333 });
    expect(metrics.recallAt10).toEqual({ count: 2, total: 3, rate: 0.666667 });
    expect(metrics.meanReciprocalRank).toBe(0.416667);
    expect(metrics.zeroResultRate).toEqual({ count: 1, total: 3, rate: 0.333333 });
    expect(metrics.ambiguityRate).toEqual({ count: 1, total: 3, rate: 0.333333 });
    expect(metrics.exactSpanCitationRate).toEqual({ count: 2, total: 3, rate: 0.666667 });
    expect(metrics.typedGraphEvidenceRate).toEqual({ count: 1, total: 3, rate: 0.333333 });
  });

  it('only counts ambiguity when the leading result is ambiguous', () => {
    const metrics = calculateKnowledgeBenchmarkQuality([
      {
        id: 'q1',
        expectedPaths: ['a.py'],
        results: [
          { title: 'a.py', hasSpanCitation: false, searchConfidence: 'clear' },
          { title: 'b.py', hasSpanCitation: false, searchConfidence: 'ambiguous' },
        ],
        hasTypedGraphEvidence: false,
      },
      {
        id: 'q2',
        expectedPaths: ['c.py'],
        results: [
          { title: 'x.py', hasSpanCitation: false, searchConfidence: null },
          { title: 'c.py', hasSpanCitation: true, searchConfidence: 'ambiguous' },
        ],
        hasTypedGraphEvidence: false,
      },
    ]);

    expect(metrics.ambiguityRate).toEqual({ count: 0, total: 2, rate: 0 });
  });

  it('uses the ideal denominator bounded by the number of expected paths and rank 10', () => {
    const metrics = calculateKnowledgeBenchmarkQuality([
      {
        id: 'q1',
        expectedPaths: ['a.py', 'b.py'],
        results: [
          { title: 'x.py', hasSpanCitation: false, searchConfidence: null },
          { title: 'a.py', hasSpanCitation: false, searchConfidence: null },
        ],
        hasTypedGraphEvidence: false,
      },
    ]);

    expect(metrics.ndcgAt10).toBe(0.386853);
  });
});

describe('nearestRankPercentile', () => {
  it.each([
    [0.5, 3],
    [0.95, 5],
    [0.99, 5],
  ])('uses nearest-rank percentile %s', (percentile, expected) => {
    expect(nearestRankPercentile([5, 1, 4, 2, 3], percentile)).toBe(expected);
  });
});

describe('roundMetric', () => {
  it('rounds to six decimals by default', () => {
    expect(roundMetric(0.123456789)).toBe(0.123457);
  });
});

describe('validation', () => {
  it('rejects empty outcomes, duplicate ids, empty expected paths, and invalid numbers', () => {
    expect(() => calculateKnowledgeBenchmarkQuality([])).toThrow(/outcome/i);
    expect(() =>
      calculateKnowledgeBenchmarkQuality([
        {
          id: 'q1',
          expectedPaths: ['a.py'],
          results: [],
          hasTypedGraphEvidence: false,
        },
        {
          id: 'q1',
          expectedPaths: ['b.py'],
          results: [],
          hasTypedGraphEvidence: false,
        },
      ]),
    ).toThrow(/duplicate outcome id/i);
    expect(() =>
      calculateKnowledgeBenchmarkQuality([
        {
          id: 'q1',
          expectedPaths: [],
          results: [],
          hasTypedGraphEvidence: false,
        },
      ]),
    ).toThrow(/expectedpaths/i);
    expect(() => nearestRankPercentile([], 0.5)).toThrow(/values/i);
    expect(() => nearestRankPercentile([1], 0)).toThrow(/percentile/i);
    expect(() => nearestRankPercentile([Number.NaN], 0.5)).toThrow(/finite/i);
  });
});
