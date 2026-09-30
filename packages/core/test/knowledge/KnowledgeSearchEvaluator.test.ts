import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import {
  KNOWLEDGE_ACCEPTANCE_THRESHOLDS,
  evaluateKnowledgeAcceptanceGate,
  hasKnowledgeTypedGraphEvidence,
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

  const validQuestion = {
    id: 'q1',
    prompt: 'find the loader',
    expectedPaths: ['task-managers/use_case.py'],
    expectedSymbols: ['UseCaseLoader'],
    required: true,
  };

  it('preserves corpus order and ids', () => {
    const corpus = parseKnowledgeAccuracyCorpus({
      corpusVersion: 'naas-v1',
      questions: [
        { ...validQuestion, id: 'z-last' },
        { ...validQuestion, id: 'a-first' },
      ],
    });

    expect(corpus.questions.map(({ id }) => id)).toEqual(['z-last', 'a-first']);
  });

  it.each([
    ['missing corpusVersion', { questions: [validQuestion] }, /corpusVersion must be a string/],
    ['empty corpusVersion', { corpusVersion: '  ', questions: [validQuestion] }, /corpusVersion must be a non-empty string/],
    ['non-array questions', { corpusVersion: 'naas-v1', questions: {} }, /questions must be an array/],
    [
      'duplicate ids',
      { corpusVersion: 'naas-v1', questions: [validQuestion, { ...validQuestion, prompt: 'other' }] },
      /duplicate question id "q1"/,
    ],
    [
      'empty prompt',
      { corpusVersion: 'naas-v1', questions: [{ ...validQuestion, prompt: '' }] },
      /questions\[0\]\.prompt must be a non-empty string/,
    ],
    [
      'empty expectedPaths',
      { corpusVersion: 'naas-v1', questions: [{ ...validQuestion, expectedPaths: [] }] },
      /questions\[0\]\.expectedPaths must contain at least 1 item/,
    ],
    [
      'non-boolean required',
      { corpusVersion: 'naas-v1', questions: [{ ...validQuestion, required: 'yes' }] },
      /questions\[0\]\.required must be a boolean/,
    ],
    [
      'legacy query-only entry',
      { corpusVersion: 'naas-v1', questions: [{ query: 'find the loader' }] },
      /questions\[0\]\.id must be a string/,
    ],
  ])('rejects %s', (_name, input, message) => {
    expect(() => parseKnowledgeAccuracyCorpus(input)).toThrow(message);
  });
});

// Real search results carry extra fields the scorer must ignore.
function searchResultWithSnippet(
  title: string,
  span: unknown,
  snippet: string,
): KnowledgeAccuracySearchResult {
  const result = { title, citations: [{ span }], snippet };
  return result;
}

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
      missing: ['top3', 'spanCitation', 'typedGraphEvidence'],
    });
  });

  it('does not expose source contents in failures', () => {
    const report = scoreKnowledgeAccuracy(
      corpus,
      () => [searchResultWithSnippet('secret.py', null, 'must not be serialized')],
      () => false,
    );

    expect(JSON.stringify(report)).not.toContain('must not be serialized');
  });

  it('does not invoke graph evidence for non-required questions', () => {
    let calls = 0;

    scoreKnowledgeAccuracy(
      {
        ...corpus,
        questions: [
          { ...corpus.questions[0], required: false },
          { ...corpus.questions[1], required: false },
        ],
      },
      () => [],
      () => {
        calls += 1;
        return true;
      },
    );

    expect(calls).toBe(0);
  });

  it('serializes identical inputs deterministically across repeated runs', () => {
    const search = (): readonly KnowledgeAccuracySearchResult[] => [
      searchResultWithSnippet('b.py', { startOffset: 3 }, 'should stay out of reports'),
      { title: 'a.py', citations: [{ span: null }] },
    ];

    const first = JSON.stringify(scoreKnowledgeAccuracy(corpus, search, () => false));
    const second = JSON.stringify(scoreKnowledgeAccuracy(corpus, search, () => false));

    expect(first).toBe(second);
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

  it('treats an expected path at rank four as a top-three miss', () => {
    const results: KnowledgeAccuracySearchResult[] = ['x.py', 'y.py', 'z.py', 'a.py']
      .map((title) => ({ title, citations: [{ span: { startOffset: 1 } }] }));
    const report = scoreKnowledgeAccuracy(
      { corpusVersion: 'naas-v1', questions: [corpus.questions[0]!] },
      () => results,
      () => true,
    );

    expect(report).toMatchObject({ top1PathHits: 0, top3PathHits: 0, spanCitationHits: 1 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.missing).toEqual(['top3']);
    expect(report.failures[0]!.returnedPaths).toEqual(['x.py', 'y.py', 'z.py', 'a.py']);
  });

  it('does not count a span on a non-expected result as a span citation', () => {
    const report = scoreKnowledgeAccuracy(
      { corpusVersion: 'naas-v1', questions: [corpus.questions[0]!] },
      () => [
        { title: 'a.py', citations: [{ span: null }] },
        { title: 'other.py', citations: [{ span: { startOffset: 1 } }] },
      ],
      () => true,
    );

    expect(report).toMatchObject({ top1PathHits: 1, top3PathHits: 1, spanCitationHits: 0 });
    expect(report.failures.map(({ missing }) => missing)).toEqual([['spanCitation']]);
  });

  it('does not mutate search results or corpus while scoring', () => {
    const results: KnowledgeAccuracySearchResult[] = [
      { title: 'a.py', citations: [{ span: { startOffset: 1 } }] },
    ];
    const originalResults = structuredClone(results);
    const originalCorpus = structuredClone(corpus);

    scoreKnowledgeAccuracy(corpus, () => results, () => true);

    expect(results).toEqual(originalResults);
    expect(corpus).toEqual(originalCorpus);
  });

  describe('acceptance gate', () => {
    const tenQuestions = (): KnowledgeAccuracyCorpus => ({
      corpusVersion: 'naas-v1',
      questions: Array.from({ length: 10 }, (_, index) => ({
        id: `q${index}`,
        prompt: `q${index}`,
        expectedPaths: [`f${index}.py`],
        expectedSymbols: ['Sym'],
        required: true,
      })),
    });

    it('declares the approved thresholds as data', () => {
      expect(KNOWLEDGE_ACCEPTANCE_THRESHOLDS).toEqual({
        questionCount: 10,
        top3PathHits: 8,
        spanCitationHits: 10,
        typedGraphEvidenceHits: 8,
      });
    });

    it('passes when top-one misses but every declared threshold is met', () => {
      const report = scoreKnowledgeAccuracy(
        tenQuestions(),
        (prompt) => {
          const index = prompt.slice(1);
          return [
            { title: 'decoy.py', citations: [{ span: null }] },
            { title: `f${index}.py`, citations: [{ span: { startOffset: 1 } }] },
          ];
        },
        () => true,
      );

      expect(report.top1PathHits).toBe(0);
      expect(report.top3PathHits).toBe(10);
      expect(report.failures).toEqual([]);
      expect(evaluateKnowledgeAcceptanceGate(report)).toEqual([]);
    });

    it('reports each violated threshold', () => {
      const report = scoreKnowledgeAccuracy(
        tenQuestions(),
        (prompt) => (prompt === 'q0' || prompt === 'q1' || prompt === 'q2'
          ? []
          : [{ title: `f${prompt.slice(1)}.py`, citations: [{ span: { startOffset: 1 } }] }]),
        () => false,
      );

      expect(evaluateKnowledgeAcceptanceGate(report)).toEqual([
        expect.stringMatching(/top3PathHits 7 < 8/),
        expect.stringMatching(/spanCitationHits 7 < 10/),
        expect.stringMatching(/typedGraphEvidenceHits 0 < 8/),
      ]);
    });

    it('rejects a corpus whose size differs from the declared question count', () => {
      const report = scoreKnowledgeAccuracy(corpus, () => [], () => false);

      expect(evaluateKnowledgeAcceptanceGate(report)[0]).toMatch(/questionCount 2 !== 10/);
    });
  });

  describe('hasKnowledgeTypedGraphEvidence', () => {
    it('uses the supplied project id when checking typed graph evidence', () => {
      const db = openDatabase(':memory:');

      try {
        applyKnowledgeMigrations(db);
        const sourceStore = new KnowledgeSourceStore(db);
        const createdAt = '2026-09-29T00:00:00.000Z';

        db.prepare(
          `INSERT INTO knowledge_projects
           (id, workspace_root, name, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        ).run('project-a', '/workspace/a', 'Project A', createdAt, createdAt);
        db.prepare(
          `INSERT INTO knowledge_projects
           (id, workspace_root, name, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        ).run('project-b', '/workspace/b', 'Project B', createdAt, createdAt);

        const source = sourceStore.register({
          projectId: 'project-a',
          kind: 'file',
          path: 'task-managers/use_case.py',
          content: 'class UseCaseLoader:\n    pass\n',
          contentPath: 'sources/files/task-managers-use_case.py',
          mimeType: 'text/x-python',
        });
        const sourceVersionId = sourceStore.listVersions('project-a', source.id)[0]!.id;

        db.prepare(
          `INSERT INTO knowledge_graph_nodes
           (id, project_id, node_type, label, source_kind, source_id, qualified_name, source_version_id, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'node-a',
          'project-a',
          'class',
          'UseCaseLoader',
          'source',
          source.id,
          'task-managers.use_case.UseCaseLoader',
          sourceVersionId,
          1,
          createdAt,
          createdAt,
        );
        db.prepare(
          `INSERT INTO knowledge_graph_nodes
           (id, project_id, node_type, label, source_kind, source_id, qualified_name, source_version_id, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'node-b',
          'project-a',
          'module',
          'use_case',
          'source',
          source.id,
          'task-managers.use_case',
          sourceVersionId,
          1,
          createdAt,
          createdAt,
        );
        db.prepare(
          `INSERT INTO knowledge_graph_edges
           (id, project_id, source_node_id, target_node_id, edge_type, evidence_json, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'edge-a',
          'project-a',
          'node-b',
          'node-a',
          'defines',
          JSON.stringify({
            evidence: ['explicit_link'],
            weight: 1,
            provenance: [{ kind: 'source', id: source.id, sourceVersionId, confidence: 1 }],
          }),
          1,
          createdAt,
          createdAt,
        );

        expect(hasKnowledgeTypedGraphEvidence(db, {
          projectId: 'project-a',
          sourcePath: 'task-managers/use_case.py',
          expectedSymbols: ['UseCaseLoader'],
        })).toBe(true);
        expect(hasKnowledgeTypedGraphEvidence(db, {
          projectId: 'project-b',
          sourcePath: 'task-managers/use_case.py',
          expectedSymbols: ['UseCaseLoader'],
        })).toBe(false);
      } finally {
        db.close();
      }
    });
  });
});
