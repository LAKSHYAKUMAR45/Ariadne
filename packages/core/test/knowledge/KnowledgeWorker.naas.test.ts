import { describe, expect, it } from 'vitest';
import { searchKnowledge } from '../../src/knowledge/KnowledgeSearch.js';
import {
  KNOWLEDGE_ACCEPTANCE_THRESHOLDS,
  evaluateKnowledgeAcceptanceGate,
  hasKnowledgeTypedGraphEvidence,
  scoreKnowledgeAccuracy,
} from './KnowledgeSearchEvaluator.js';
import { createKnowledgeBenchmarkHarness } from './KnowledgeBenchmarkFixture.js';

describe('KnowledgeWorker synthetic NAAS-shaped acceptance', () => {
  it('meets path, citation, and typed-graph thresholds for ten offline worker questions', async () => {
    const harness = createKnowledgeBenchmarkHarness({
      projectId: 'synthetic-naas-acceptance',
    });
    try {
      harness.seedInitialSources();
      await harness.runWorker('naas-acceptance');
      const report = scoreKnowledgeAccuracy(
        harness.input.corpus,
        (prompt) => searchKnowledge(prompt, { db: harness.db, projectId: harness.projectId, mode: 'sources' }),
        (question, sourcePath) => hasKnowledgeTypedGraphEvidence(harness.db, {
          projectId: harness.projectId,
          sourcePath,
          expectedSymbols: question.expectedSymbols,
        }),
      );

      expect(Object.keys(report).sort()).toEqual([
        'corpusVersion',
        'failures',
        'questionCount',
        'spanCitationHits',
        'top1PathHits',
        'top3PathHits',
        'typedGraphEvidenceHits',
      ]);
      expect(report.corpusVersion).toBe('naas-v1');
      expect(report.questionCount).toBe(10);
      expect(KNOWLEDGE_ACCEPTANCE_THRESHOLDS).toEqual({
        questionCount: 10,
        top3PathHits: 8,
        spanCitationHits: 10,
        typedGraphEvidenceHits: 8,
      });
      expect(report.top3PathHits).toBeGreaterThanOrEqual(8);
      expect(report.spanCitationHits).toBe(10);
      expect(report.typedGraphEvidenceHits).toBeGreaterThanOrEqual(8);
      expect(evaluateKnowledgeAcceptanceGate(report)).toEqual([]);
      // top1PathHits is reported for optimization only and is not gated.
      expect(JSON.stringify(report)).not.toContain('config.task_manager_defaults');

      const remainingJobs = harness.db.prepare(
        `SELECT status, COUNT(*) AS count
         FROM knowledge_jobs
         WHERE project_id = ? AND status IN ('queued', 'running')
         GROUP BY status`,
      ).all(harness.projectId);
      expect(remainingJobs).toEqual([]);
      const terminalJobs = harness.db.prepare(
        `SELECT status, failure_code
         FROM knowledge_jobs
         WHERE project_id = ?`,
      ).all(harness.projectId) as Array<{ status: string; failure_code: string | null }>;
      expect(terminalJobs).toHaveLength(harness.input.sources.length);
      expect(terminalJobs.every((job) =>
        job.status === 'completed' || (job.status === 'failed' && job.failure_code !== null),
      )).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});
