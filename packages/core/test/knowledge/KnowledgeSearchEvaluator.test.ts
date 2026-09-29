import { describe, expect, it } from 'vitest';
import { parseKnowledgeAccuracyCorpus } from './KnowledgeSearchEvaluator.js';

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
