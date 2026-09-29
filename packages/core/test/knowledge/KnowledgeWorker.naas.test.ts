import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgeQueue } from '../../src/knowledge/KnowledgeQueue.js';
import { searchKnowledge } from '../../src/knowledge/KnowledgeSearch.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import { KnowledgeWorker } from '../../src/knowledge/KnowledgeWorker.js';
import {
  hasKnowledgeTypedGraphEvidence,
  parseKnowledgeAccuracyCorpus,
  scoreKnowledgeAccuracy,
} from './KnowledgeSearchEvaluator.js';

const PROJECT_ID = 'synthetic-naas-acceptance';
const FIXTURE_ROOT = join(process.cwd(), 'test/knowledge/fixtures/naas');
const FIXTURE_CONTENT_PATH = 'sources/files';
const CREATED_AT = '2026-09-28T00:00:00.000Z';

describe('KnowledgeWorker synthetic NAAS-shaped acceptance', () => {
  let db: Database.Database;
  let workspaceRoot: string;
  let queue: KnowledgeQueue;
  let sourceStore: KnowledgeSourceStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-worker-naas-'));
    db.prepare(
      `INSERT INTO knowledge_projects
       (id, workspace_root, name, status, created_at, updated_at)
       VALUES (?, ?, 'Synthetic NAAS fixtures', 'active', ?, ?)`,
    ).run(PROJECT_ID, workspaceRoot, CREATED_AT, CREATED_AT);
    queue = new KnowledgeQueue(db, { now: () => CREATED_AT });
    sourceStore = new KnowledgeSourceStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('meets path, citation, and typed-graph thresholds for ten offline worker questions', async () => {
    const corpus = parseKnowledgeAccuracyCorpus(JSON.parse(
      readFileSync(join(FIXTURE_ROOT, 'questions.json'), 'utf8'),
    ));
    const fixturePaths = [
      'task-managers/device.py',
      'task-managers/gnmi.py',
      'task-managers/topology.py',
      'task-managers/remote_access.py',
      'task-managers/configlet.py',
      'task-managers/deployment.py',
      'task-managers/use_case.py',
      'task-managers/pytest_bootstrap.py',
    ];

    for (const sourcePath of fixturePaths) {
      const content = readFileSync(join(FIXTURE_ROOT, sourcePath), 'utf8');
      const contentPath = `${FIXTURE_CONTENT_PATH}/${sourcePath.replaceAll('/', '-')}`;
      const storedPath = join(workspaceRoot, '.ariadne/knowledge', contentPath);
      mkdirSync(join(storedPath, '..'), { recursive: true });
      writeFileSync(storedPath, content, 'utf8');
      const source = sourceStore.register({
        projectId: PROJECT_ID,
        kind: 'file',
        path: sourcePath,
        content,
        contentPath,
        mimeType: 'text/x-python',
      });
      const version = sourceStore.listVersions(PROJECT_ID, source.id)[0]!;
      queue.enqueue({
        projectId: PROJECT_ID,
        jobKind: 'analyze',
        sourceVersionId: version.id,
        payload: { sourceVersionId: version.id },
      });
    }

    await new KnowledgeWorker(db, { workerId: 'naas-acceptance', now: () => CREATED_AT }).runOnce(PROJECT_ID);
    const report = scoreKnowledgeAccuracy(
      corpus,
      (prompt) => searchKnowledge(prompt, { db, projectId: PROJECT_ID, mode: 'sources' }),
      (question, sourcePath) => hasKnowledgeTypedGraphEvidence(db, {
        projectId: PROJECT_ID,
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
    expect(report.top3PathHits).toBeGreaterThanOrEqual(8);
    expect(report.spanCitationHits).toBe(10);
    expect(report.typedGraphEvidenceHits).toBeGreaterThanOrEqual(8);
    expect(report.failures).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('config.task_manager_defaults');

    const remainingJobs = db.prepare(
      `SELECT status, COUNT(*) AS count
       FROM knowledge_jobs
       WHERE project_id = ? AND status IN ('queued', 'running')
       GROUP BY status`,
    ).all(PROJECT_ID);
    expect(remainingJobs).toEqual([]);
    const terminalJobs = db.prepare(
      `SELECT status, failure_code
       FROM knowledge_jobs
       WHERE project_id = ?`,
    ).all(PROJECT_ID) as Array<{ status: string; failure_code: string | null }>;
    expect(terminalJobs).toHaveLength(fixturePaths.length);
    expect(terminalJobs.every((job) =>
      job.status === 'completed' || (job.status === 'failed' && job.failure_code !== null),
    )).toBe(true);
  });
});
