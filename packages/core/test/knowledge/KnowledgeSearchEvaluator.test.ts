import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import {
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
