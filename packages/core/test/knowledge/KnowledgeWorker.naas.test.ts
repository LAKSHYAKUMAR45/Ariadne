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

const PROJECT_ID = 'synthetic-naas-acceptance';
const FIXTURE_ROOT = join(process.cwd(), 'test/knowledge/fixtures/naas');
const FIXTURE_CONTENT_PATH = 'sources/files';
const CREATED_AT = '2026-09-28T00:00:00.000Z';
const TYPED_EDGE_TYPES = new Set(['calls', 'contains', 'defines', 'imports', 'inherits', 'references']);
const TYPED_EVIDENCE_TYPES = new Set(['explicit_link', 'semantic_relationship']);

interface KnowledgeAccuracyQuestion {
  id: string;
  query: string;
  expectedPaths: string[];
  expectedSymbols: string[];
}

interface KnowledgeAccuracyReport {
  questionCount: number;
  top1PathHits: number;
  top3PathHits: number;
  spanCitationHits: number;
  typedGraphEvidenceHits: number;
}

interface GraphEvidenceRow {
  node_type: string;
  edge_type: string;
  evidence_json: string;
}

function hasTypedGraphEvidence(
  db: Database.Database,
  sourcePath: string,
  expectedSymbols: readonly string[],
): boolean {
  if (expectedSymbols.length === 0) return false;
  const placeholders = expectedSymbols.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT node.node_type, edge.edge_type, edge.evidence_json
     FROM knowledge_graph_nodes node
     JOIN knowledge_sources source
       ON source.project_id = node.project_id
      AND source.source_path = ?
     JOIN knowledge_source_versions version
       ON version.project_id = source.project_id
      AND version.source_id = source.id
      AND version.id = node.source_version_id
     JOIN knowledge_graph_edges edge
       ON edge.project_id = node.project_id
      AND (edge.source_node_id = node.id OR edge.target_node_id = node.id)
     WHERE node.project_id = ?
       AND node.label IN (${placeholders})`,
  ).all(sourcePath, PROJECT_ID, ...expectedSymbols) as GraphEvidenceRow[];

  return rows.some((row) => {
    if (!['class', 'function', 'method', 'module'].includes(row.node_type)) return false;
    if (!TYPED_EDGE_TYPES.has(row.edge_type)) return false;
    const storedEvidence: unknown = JSON.parse(row.evidence_json);
    if (typeof storedEvidence !== 'object' || storedEvidence === null || Array.isArray(storedEvidence)) return false;
    const evidence = (storedEvidence as { evidence?: unknown }).evidence;
    return Array.isArray(evidence) && evidence.some(
      (kind) => typeof kind === 'string' && TYPED_EVIDENCE_TYPES.has(kind),
    );
  });
}

function scoreAccuracy(
  db: Database.Database,
  questions: readonly KnowledgeAccuracyQuestion[],
): KnowledgeAccuracyReport {
  let top1PathHits = 0;
  let top3PathHits = 0;
  let spanCitationHits = 0;
  let typedGraphEvidenceHits = 0;

  for (const question of questions) {
    const results = searchKnowledge(question.query, { db, projectId: PROJECT_ID, mode: 'sources' });
    const expectedResults = results.filter((result) => question.expectedPaths.includes(result.title));
    if (question.expectedPaths.includes(results[0]?.title ?? '')) top1PathHits += 1;
    if (results.slice(0, 3).some((result) => question.expectedPaths.includes(result.title))) top3PathHits += 1;
    if (expectedResults.some((result) => result.citations.some((citation) => citation.span !== null))) {
      spanCitationHits += 1;
    }
    if (question.expectedPaths.some((sourcePath) =>
      hasTypedGraphEvidence(db, sourcePath, question.expectedSymbols),
    )) {
      typedGraphEvidenceHits += 1;
    }
  }

  return {
    questionCount: questions.length,
    top1PathHits,
    top3PathHits,
    spanCitationHits,
    typedGraphEvidenceHits,
  };
}

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
    const questions = JSON.parse(
      readFileSync(join(FIXTURE_ROOT, 'questions.json'), 'utf8'),
    ) as KnowledgeAccuracyQuestion[];
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
    const report = scoreAccuracy(db, questions);

    expect(Object.keys(report).sort()).toEqual([
      'questionCount',
      'spanCitationHits',
      'top1PathHits',
      'top3PathHits',
      'typedGraphEvidenceHits',
    ]);
    expect(report.questionCount).toBe(10);
    expect(report.top3PathHits).toBeGreaterThanOrEqual(8);
    expect(report.spanCitationHits).toBe(10);
    expect(report.typedGraphEvidenceHits).toBeGreaterThanOrEqual(8);

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
