import { describe, expect, it } from 'vitest';
import {
  parseKnowledgeAccuracyCorpus,
  scoreKnowledgeAccuracy,
  type KnowledgeAccuracyCorpus,
  type KnowledgeAccuracySearchResult,
} from './KnowledgeSearchEvaluator.js';

describe('parseKnowledgeAccuracyCorpus', () => {
  it('requires stable ids, prompts, expected paths, symbols, and required flags', () => {
    expect(() =>
      parseKnowledgeAccuracyCorpus({
        corpusVersion: 'naas-v1',
        questions: [
          {
            id: 'q1',
            prompt: 'find the loader',
            expectedPaths: ['task-managers/use_case.py'],
            expectedSymbols: ['UseCaseLoader'],
            required: true,
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects duplicate ids, empty prompts, and empty expected paths', () => {
    expect(() =>
      parseKnowledgeAccuracyCorpus({
        corpusVersion: 'naas-v1',
        questions: [
          {
            id: 'q1',
            prompt: '',
            expectedPaths: [],
            expectedSymbols: [],
            required: true,
          },
          {
            id: 'q1',
            prompt: 'duplicate',
            expectedPaths: ['x.py'],
            expectedSymbols: [],
            required: true,
          },
        ],
      }),
    ).toThrow(/questions|prompt|expectedPaths|duplicate/i);
  });
});

describe('scoreKnowledgeAccuracy', () => {
  const corpus: KnowledgeAccuracyCorpus = {
    corpusVersion: 'naas-v1',
    questions: [
      {
        id: 'q1',
        prompt: 'q1',
        expectedPaths: ['a.py', 'b.py'],
        expectedSymbols: [],
        required: true,
      },
      {
        id: 'q2',
        prompt: 'q2',
        expectedPaths: ['c.py'],
        expectedSymbols: [],
        required: false,
      },
    ],
  };

  it('scores acceptable paths and records only failed required questions', () => {
    const report = scoreKnowledgeAccuracy(
      corpus,
      (prompt) =>
        prompt === 'q1'
          ? [{ title: 'a.py', citations: [{ span: { startOffset: 1 } }] }]
          : [{ title: 'wrong.py', citations: [{ span: null }] }],
      (question, path) => question.id === 'q1' && path === 'a.py',
    );

    expect(report).toMatchObject({
      corpusVersion: 'naas-v1',
      questionCount: 2,
      top1PathHits: 1,
      top3PathHits: 1,
      spanCitationHits: 1,
      typedGraphEvidenceHits: 1,
    });
    expect(report.failures).toHaveLength(0);
  });

  it('keeps failure ordering equal to corpus ordering and does not mutate inputs', () => {
    const original = structuredClone(corpus);
    const report = scoreKnowledgeAccuracy(corpus, () => [], () => false);

    expect(corpus).toEqual(original);
    expect(report.failures.map(({ id }) => id)).toEqual(['q1']);
    expect(report.failures[0]).toMatchObject({
      id: 'q1',
      prompt: 'q1',
      expectedPaths: ['a.py', 'b.py'],
      returnedPaths: [],
      missing: ['top1', 'top3', 'spanCitation', 'typedGraphEvidence'],
    });
  });

  it('counts top-three hits from later acceptable paths', () => {
    const report = scoreKnowledgeAccuracy(
      {
        corpusVersion: 'naas-v1',
        questions: [
          {
            id: 'q1',
            prompt: 'q1',
            expectedPaths: ['a.py', 'b.py'],
            expectedSymbols: [],
            required: true,
          },
        ],
      },
      () =>
        [
          { title: 'x.py', citations: [{ span: null }] },
          { title: 'b.py', citations: [{ span: null }] },
          { title: 'y.py', citations: [{ span: null }] },
        ] satisfies readonly KnowledgeAccuracySearchResult[],
      () => false,
    );

    expect(report).toMatchObject({
      top1PathHits: 0,
      top3PathHits: 1,
      spanCitationHits: 0,
      typedGraphEvidenceHits: 0,
    });
  });
});
