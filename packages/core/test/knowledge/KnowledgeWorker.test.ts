import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { createKnowledgeId } from '../../src/knowledge/KnowledgeIds.js';
import { KnowledgeExtractionStore, type DeterministicExtraction } from '../../src/knowledge/KnowledgeExtractionStore.js';
import { KnowledgeGeneratorService } from '../../src/knowledge/KnowledgeGeneratorService.js';
import { KnowledgeGraphMaterializer } from '../../src/knowledge/KnowledgeGraphMaterializer.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';
import { KnowledgeQueue } from '../../src/knowledge/KnowledgeQueue.js';
import { createKnowledgeReview, listKnowledgeReviews } from '../../src/knowledge/KnowledgeReview.js';
import { searchKnowledge } from '../../src/knowledge/KnowledgeSearch.js';
import { KnowledgeSearchIndex } from '../../src/knowledge/KnowledgeSearchIndex.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import { KnowledgeWorker, type KnowledgeEnrichmentService } from '../../src/knowledge/KnowledgeWorker.js';
import { KnowledgeGraph } from '../../src/knowledge/graph/KnowledgeGraph.js';
import { KnowledgeGraphReporter } from '../../src/knowledge/KnowledgeGraphReporting.js';
import { createDefaultAnalyzerRegistry, type AnalyzerInput, type AnalyzerSelectionInput, type DeterministicAnalyzer } from '../../src/knowledge/analyzers/index.js';

const PROJECT_A = 'project_a';
const PROJECT_B = 'project_b';
const CREATED_AT = '2026-09-25T00:00:00.000Z';

interface TestSource {
  sourceId: string;
  sourceVersionId: string;
  contentPath: string;
}

class CountingQueue extends KnowledgeQueue {
  public claimCount = 0;

  public override claim(projectId: string, workerId: string) {
    this.claimCount += 1;
    return super.claim(projectId, workerId);
  }
}

class StubAnalyzer implements DeterministicAnalyzer {
  public constructor(
    public readonly id: string,
    public readonly version: string,
    private readonly supported: boolean,
    private readonly analyzeImpl: (input: AnalyzerInput) => Promise<DeterministicExtraction>,
  ) {}

  public supports(_input: AnalyzerSelectionInput): boolean {
    return this.supported;
  }

  public analyze(input: AnalyzerInput): Promise<DeterministicExtraction> {
    return this.analyzeImpl(input);
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createExtraction(input: AnalyzerInput, overrides: Partial<DeterministicExtraction> = {}): DeterministicExtraction {
  return {
    analyzerId: overrides.analyzerId ?? 'stub-analyzer',
    analyzerVersion: overrides.analyzerVersion ?? '1.0.0',
    sourceVersionId: input.sourceVersionId,
    title: overrides.title ?? (input.sourcePath ?? input.sourceVersionId),
    summary: overrides.summary ?? 'Deterministic summary',
    sections: overrides.sections ?? [
      {
        id: 'section_1',
        kind: 'body',
        title: 'Body',
        text: input.content,
        confidence: 1,
        span: {
          startOffset: 0,
          endOffset: input.content.length,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: Math.max(1, input.content.length + 1),
          label: 'body',
        },
      },
    ],
    symbols: overrides.symbols ?? [
      {
        id: 'module_1',
        kind: 'module',
        name: 'sample',
        qualifiedName: 'sample',
        confidence: 1,
        span: {
          startOffset: 0,
          endOffset: Math.max(1, input.content.length),
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: Math.max(1, input.content.length + 1),
          label: 'module',
        },
      },
    ],
    relationships: overrides.relationships ?? [],
    links: overrides.links ?? [],
    diagnostics: overrides.diagnostics ?? [],
  };
}

describe('KnowledgeWorker', () => {
  let db: Database.Database;
  let sourceStore: KnowledgeSourceStore;
  let extractionStore: KnowledgeExtractionStore;
  let pageStore: KnowledgePageStore;
  let queue: KnowledgeQueue;
  let workspaceRoots: string[];

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    sourceStore = new KnowledgeSourceStore(db);
    extractionStore = new KnowledgeExtractionStore(db);
    pageStore = new KnowledgePageStore(db);
    queue = new KnowledgeQueue(db, { leaseDurationMs: 90, now: () => CREATED_AT });
    workspaceRoots = [];
    insertProject(PROJECT_A, createWorkspaceRoot(PROJECT_A));
    insertProject(PROJECT_B, createWorkspaceRoot(PROJECT_B));
  });

  afterEach(() => {
    db.close();
    for (const workspaceRoot of workspaceRoots.splice(0)) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs the analyze pipeline through extraction, graph, deterministic pages, and exact-span search', async () => {
    const python = registerSource(PROJECT_A, 'src/example.py', [
      'class Greeter:',
      '    def greet(self, name):',
      "        return f'hello {name}'",
      '',
    ].join('\n'));
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });

    const worker = new KnowledgeWorker(db, { workerId: 'worker-happy', now: () => CREATED_AT });
    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({
      projectId: PROJECT_A,
      claimed: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      warnings: [],
    });
    expect(queue.get(job.id)).toMatchObject({
      status: 'completed',
      failureCode: null,
      workerId: null,
      result: expect.objectContaining({
        processingMode: 'deterministic',
        graphNodeCount: expect.any(Number),
        graphEdgeCount: expect.any(Number),
      }),
    });

    const extraction = db.prepare(
      `SELECT id, analyzer_id, analyzer_version
       FROM knowledge_extractions
       WHERE project_id = ? AND source_version_id = ?`,
    ).get(PROJECT_A, python.sourceVersionId) as { id: string; analyzer_id: string; analyzer_version: string };
    expect(extraction).toBeDefined();
    expect(extractionStore.getCurrent(PROJECT_A, python.sourceVersionId, extraction.analyzer_id, extraction.analyzer_version)).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 3 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_edges WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 2 });
    expect(pageStore.listPages(PROJECT_A, 'source')).toHaveLength(1);

    const searchResults = searchKnowledge('greet', { db, projectId: PROJECT_A, mode: 'sources' });
    expect(searchResults[0]).toMatchObject({
      kind: 'source',
      title: 'src/example.py',
    });
    expect(searchResults[0]?.snippet).toContain('greet');
    expect(searchResults[0]?.citations[0]?.span).toMatchObject({
      startLine: 2,
      endLine: 2,
    });

    expect(queue.listProgressEvents(job.id).map((event) => event.stage)).toEqual([
      'loading',
      'analyzing',
      'persisting',
      'graph',
      'generating',
      'completed',
    ]);
  });

  it('fails unsupported job kinds and rejects direct processing when the worker does not own the job', async () => {
    const python = registerSource(PROJECT_A, 'src/unsupported.py', 'print("hello")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'summarize',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const worker = new KnowledgeWorker(db, { workerId: 'worker-unsupported', now: () => CREATED_AT });

    await expect(worker.processJob(PROJECT_A, job.id)).rejects.toThrow(/owned by worker-unsupported/i);

    const result = await worker.runOnce(PROJECT_A);
    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1, cancelled: 0 });
    expect(queue.get(job.id)).toMatchObject({
      status: 'failed',
      failureCode: 'unsupported_source',
    });
  });

  it('materializes the search index in the same transaction as extraction persistence', async () => {
    const python = registerSource(PROJECT_A, 'src/indexed.py', 'class Indexed:\n    def greet(self):\n        return 1\n');
    queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });

    const worker = new KnowledgeWorker(db, { workerId: 'worker-index', now: () => CREATED_AT });
    await worker.runOnce(PROJECT_A);

    const extraction = db.prepare(
      'SELECT id FROM knowledge_extractions WHERE project_id = ? AND source_version_id = ?',
    ).get(PROJECT_A, python.sourceVersionId) as { id: string };
    expect(
      db.prepare(
        'SELECT status, coverage, extraction_id AS extractionId, field_count AS fieldCount FROM knowledge_search_indexes WHERE project_id = ? AND source_version_id = ?',
      ).get(PROJECT_A, python.sourceVersionId),
    ).toMatchObject({ status: 'active', coverage: 'extraction', extractionId: extraction.id, fieldCount: expect.any(Number) });
    expect(new KnowledgeSearchIndex(db).getStatus(PROJECT_A)).toMatchObject({ indexedCount: 1, unindexedCount: 0 });
    expect(searchKnowledge('greet', { db, projectId: PROJECT_A, mode: 'sources' })[0]).toMatchObject({
      title: 'src/indexed.py',
      metadata: expect.objectContaining({ extractionId: extraction.id }),
    });
  });

  it('rolls back extraction persistence and fails the job when the search index write fails', async () => {
    const python = registerSource(PROJECT_A, 'src/rollback.py', 'print("rollback")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const worker = new KnowledgeWorker(
      db,
      { workerId: 'worker-index-fail', now: () => CREATED_AT },
      {
        searchIndex: {
          replaceForSourceVersion() {
            throw new Error('index write failed');
          },
        },
      },
    );

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(queue.get(job.id)).toMatchObject({ status: 'failed', failureCode: 'extraction_persist_failed' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_extractions WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_source_spans WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_search_indexes WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 0 });
  });

  it('fails permanently when immutable source content no longer matches its recorded hash', async () => {
    const python = registerSource(PROJECT_A, 'src/hash.py', 'print("expected")\n');
    writeStoredContent(PROJECT_A, python.contentPath, 'print("tampered")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });

    const worker = new KnowledgeWorker(db, { workerId: 'worker-hash', now: () => CREATED_AT });
    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1, cancelled: 0 });
    expect(queue.get(job.id)).toMatchObject({
      status: 'failed',
      failureCode: 'source_hash_mismatch',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_extractions WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 0 });
    expect(pageStore.listPages(PROJECT_A)).toHaveLength(0);
  });

  it('completes malformed-but-parseable Python sources with an analyzer diagnostic warning', async () => {
    const python = registerSource(PROJECT_A, 'src/broken.py', [
      'import os',
      '',
      'class Example:',
      '    def broken(self):',
      '        value = missing(',
      '        return value',
      '',
    ].join('\r\n'));
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });

    const worker = new KnowledgeWorker(db, { workerId: 'worker-warn', now: () => CREATED_AT });
    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(queue.get(job.id)?.result?.warnings).toEqual([
      expect.objectContaining({ code: 'analyzer_diagnostics' }),
    ]);
  });

  it('records cancellation between durable stages when the signal aborts after graph materialization', async () => {
    const python = registerSource(PROJECT_A, 'src/cancel.py', 'print("cancel")\n');
    const controller = new AbortController();
    const realMaterializer = new KnowledgeGraphMaterializer(new KnowledgeGraph(db));
    const worker = new KnowledgeWorker(
      db,
      { workerId: 'worker-cancel', now: () => CREATED_AT, signal: controller.signal },
      {
        graphMaterializer: {
          materialize(input) {
            const result = realMaterializer.materialize(input);
            controller.abort();
            return result;
          },
        },
      },
    );
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 0, cancelled: 1 });
    expect(queue.get(job.id)?.status).toBe('cancelled');
    expect(pageStore.listPages(PROJECT_A)).toHaveLength(0);
  });

  it('stops before further writes when ownership changes before persistence', async () => {
    const python = registerSource(PROJECT_A, 'src/ownership.py', 'print("ownership")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    queue.claim(PROJECT_A, 'worker-lease');

    const analyzer = new StubAnalyzer('ownership-analyzer', '1.0.0', true, async (input) => {
      db.prepare(
        `UPDATE knowledge_jobs
         SET worker_id = 'other-worker', lease_expires_at = ?
         WHERE id = ?`,
      ).run('2026-09-25T00:00:00.001Z', job.id);
      return createExtraction(input);
    });
    const worker = new KnowledgeWorker(
      db,
      { workerId: 'worker-lease', now: () => CREATED_AT },
      {
        analyzers: {
          require() {
            return analyzer;
          },
        },
      },
    );

    await expect(worker.processJob(PROJECT_A, job.id)).rejects.toThrow(/lease|ownership/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_extractions WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 0 });
    expect(pageStore.listPages(PROJECT_A)).toHaveLength(0);
  });

  it('treats lease loss during terminal failure handling as an expected race instead of aborting the worker loop', async () => {
    const python = registerSource(PROJECT_A, 'src/lease-race.py', 'print("lease race")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const generator = {
      async runKnowledgeGeneration() {
        db.prepare(
          `UPDATE knowledge_jobs
           SET worker_id = 'worker-other', lease_expires_at = ?
           WHERE id = ?`,
        ).run('2026-09-25T00:00:00.001Z', job.id);
        throw new Error('generation failed after ownership drift');
      },
    } as unknown as KnowledgeGeneratorService;
    const worker = new KnowledgeWorker(
      db,
      { workerId: 'worker-lease-race', now: () => CREATED_AT },
      { generator },
    );

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 0, cancelled: 0 });
    expect(queue.get(job.id)).toMatchObject({
      id: job.id,
      status: 'running',
      workerId: 'worker-other',
    });
  });

  it('requires explicit matching project context for direct job processing', async () => {
    const python = registerSource(PROJECT_A, 'src/direct.py', 'print("direct")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    expect(queue.claim(PROJECT_A, 'worker-direct')?.id).toBe(job.id);
    const worker = new KnowledgeWorker(db, { workerId: 'worker-direct', now: () => CREATED_AT });

    await expect(worker.processJob(PROJECT_B, job.id)).rejects.toThrow(/project/i);
    await expect(worker.processJob(PROJECT_A, job.id)).resolves.toMatchObject({
      id: job.id,
      status: 'completed',
      projectId: PROJECT_A,
    });
  });

  it('reruns unchanged source versions idempotently without duplicating deterministic artifacts', async () => {
    const python = registerSource(PROJECT_A, 'src/idempotent.py', 'def greet(name):\n    return name\n');
    const firstJob = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const worker = new KnowledgeWorker(db, { workerId: 'worker-idempotent', now: () => CREATED_AT });

    await worker.runOnce(PROJECT_A);
    expect(queue.get(firstJob.id)?.status).toBe('completed');
    const firstCounts = countsForProject(PROJECT_A);

    db.prepare(
      `INSERT INTO knowledge_jobs
       (id, project_id, job_kind, source_version_id, status, payload_json, requested_at, retry_count, max_retries)
       VALUES (?, ?, 'analyze', NULL, 'queued', ?, ?, 0, 3)`,
    ).run(
      createKnowledgeId('job', 'rerun'),
      PROJECT_A,
      JSON.stringify({ sourceVersionId: python.sourceVersionId }),
      '2026-09-25T00:01:00.000Z',
    );

    const rerun = await worker.runOnce(PROJECT_A);
    expect(rerun).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(countsForProject(PROJECT_A)).toEqual(firstCounts);
  });

  it('treats enrichment rejection as warning-only and redacts the warning metadata', async () => {
    const python = registerSource(PROJECT_A, 'src/enrich.py', 'print("enrich")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const enrich: KnowledgeEnrichmentService = {
      async enrich() {
        throw new Error(`Provider rejected sk-live-12345678901234567890 ${'x'.repeat(800)}`);
      },
    };
    const worker = new KnowledgeWorker(db, { workerId: 'worker-enrich', now: () => CREATED_AT, enrich });

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    const warnings = queue.get(job.id)?.result?.warnings ?? [];
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'enrichment_failed', message: expect.stringContaining('***') }),
    ]);
    expect(warnings[0]?.message.length).toBeLessThanOrEqual(280);
  });

  it('keeps processingMode deterministic when an enrichment service returns no result', async () => {
    const python = registerSource(PROJECT_A, 'src/no-enrich.py', 'print("no enrich")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const enrich: KnowledgeEnrichmentService = {
      async enrich() {
        return;
      },
    };
    const worker = new KnowledgeWorker(db, { workerId: 'worker-no-enrich', now: () => CREATED_AT, enrich });

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0, warnings: [] });
    expect(queue.get(job.id)?.result).toMatchObject({
      processingMode: 'deterministic',
    });
  });

  it('keeps processingMode deterministic when enrichment only returns warnings', async () => {
    const python = registerSource(PROJECT_A, 'src/warn-only.py', 'print("warn only")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const enrich: KnowledgeEnrichmentService = {
      async enrich() {
        return {
          warnings: [
            {
              code: 'provider_http_error',
              message: 'Provider request failed with status 502. Response body was redacted.',
            },
          ],
        };
      },
    };
    const worker = new KnowledgeWorker(db, { workerId: 'worker-warn-only', now: () => CREATED_AT, enrich });

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(queue.get(job.id)?.result).toMatchObject({
      processingMode: 'deterministic',
      warnings: [expect.objectContaining({ code: 'provider_http_error' })],
    });
  });

  it('keeps processingMode deterministic when enrichment outputs are only invalid items', async () => {
    const python = registerSource(PROJECT_A, 'src/invalid-items.py', 'print("invalid items")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const enrich: KnowledgeEnrichmentService = {
      async enrich() {
        return {
          reviews: [{ pageVersionId: '', summary: '   ' }],
          insights: [{ type: '', contentPath: '', confidence: Number.NaN }],
        };
      },
    };
    const worker = new KnowledgeWorker(db, { workerId: 'worker-invalid-items', now: () => CREATED_AT, enrich });

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(queue.get(job.id)?.result).toMatchObject({
      processingMode: 'deterministic',
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'enrichment_invalid_review' }),
        expect.objectContaining({ code: 'enrichment_invalid_insight' }),
      ]),
    });
  });

  it('creates bounded idempotent contradiction reviews and research-gap insights from enrichment', async () => {
    const python = registerSource(PROJECT_A, 'src/reviewable.py', 'print("review me")\n');
    const enrich: KnowledgeEnrichmentService = {
      async enrich({ pageVersionIds }) {
        return {
          reviews: [
            {
              pageVersionId: pageVersionIds[0] ?? null,
              summary: 'Contradiction: API contract disagrees with generated source summary',
            },
          ],
          insights: [
            {
              type: 'research_gap',
              contentPath: 'src/reviewable.py',
              confidence: 0.72,
            },
          ],
        };
      },
    };
    const worker = new KnowledgeWorker(db, { workerId: 'worker-review', now: () => CREATED_AT, enrich });

    queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    await worker.runOnce(PROJECT_A);
    const firstReviewIds = listKnowledgeReviews(db, PROJECT_A).map((review) => review.id);
    const firstInsights = db.prepare(
      `SELECT id, insight_type, content_path
       FROM knowledge_insights
       WHERE project_id = ?
       ORDER BY id`,
    ).all(PROJECT_A) as Array<{ id: string; insight_type: string; content_path: string }>;

    db.prepare(
      `INSERT INTO knowledge_jobs
       (id, project_id, job_kind, source_version_id, status, payload_json, requested_at, retry_count, max_retries)
       VALUES (?, ?, 'analyze', NULL, 'queued', ?, ?, 0, 3)`,
    ).run(
      createKnowledgeId('job', 'review-rerun'),
      PROJECT_A,
      JSON.stringify({ sourceVersionId: python.sourceVersionId }),
      '2026-09-25T00:02:00.000Z',
    );
    await worker.runOnce(PROJECT_A);

    expect(listKnowledgeReviews(db, PROJECT_A).map((review) => review.id)).toEqual(firstReviewIds);
    expect(
      db.prepare(
        `SELECT id, insight_type, content_path
         FROM knowledge_insights
         WHERE project_id = ?
         ORDER BY id`,
      ).all(PROJECT_A),
    ).toEqual(firstInsights);
  });

  it('persists grounded project-level enrichment reviews without requiring a page version id', async () => {
    const python = registerSource(PROJECT_A, 'src/project-review.py', 'print("project review")\n');
    const enrich: KnowledgeEnrichmentService = {
      async enrich() {
        return {
          reviews: [
            {
              summary: 'Review: reconcile the generated overview with the current project scope',
            },
          ],
        };
      },
    };
    const worker = new KnowledgeWorker(db, { workerId: 'worker-project-review', now: () => CREATED_AT, enrich });

    queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(
      listKnowledgeReviews(db, PROJECT_A).filter(
        (review) => review.summary === 'Review: reconcile the generated overview with the current project scope',
      ),
    ).toEqual([
      expect.objectContaining({
        pageVersionId: null,
        status: 'pending',
      }),
    ]);
  });

  it('keeps valid enrichment siblings when invalid items are interleaved and reruns idempotently', async () => {
    const python = registerSource(PROJECT_A, 'src/mixed.py', 'print("mixed")\n');
    const enrich: KnowledgeEnrichmentService = {
      async enrich({ pageVersionIds }) {
        return {
          reviews: [
            { pageVersionId: '', summary: 'invalid empty page version id' },
            {
              pageVersionId: pageVersionIds[0] ?? null,
              summary: 'Contradiction: valid sibling survives invalid review entries',
            },
            { pageVersionId: pageVersionIds[0] ?? null, summary: '   ' },
          ],
          insights: [
            { type: 'research_gap', contentPath: 'src/mixed.py', confidence: 0.61 },
            { type: '', contentPath: 'src/mixed.py', confidence: 0.25 },
            { type: 'research_gap', contentPath: 'src/mixed.py', confidence: Number.NaN },
          ],
        };
      },
    };
    const worker = new KnowledgeWorker(db, { workerId: 'worker-mixed-enrich', now: () => CREATED_AT, enrich });

    queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const firstRun = await worker.runOnce(PROJECT_A);

    expect(firstRun).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(firstRun.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'enrichment_invalid_review' }),
        expect.objectContaining({ code: 'enrichment_invalid_insight' }),
      ]),
    );
    expect(
      listKnowledgeReviews(db, PROJECT_A).filter(
        (review) => review.summary === 'Contradiction: valid sibling survives invalid review entries',
      ),
    ).toHaveLength(1);
    expect(
      db.prepare(
        `SELECT insight_type, content_path
         FROM knowledge_insights
         WHERE project_id = ?
         ORDER BY id`,
      ).all(PROJECT_A),
    ).toEqual([
      {
        insight_type: 'research_gap',
        content_path: 'src/mixed.py',
      },
    ]);
    const firstReviewIds = listKnowledgeReviews(db, PROJECT_A).map((review) => review.id);
    const firstInsightIds = (
      db.prepare(`SELECT id FROM knowledge_insights WHERE project_id = ? ORDER BY id`).all(PROJECT_A) as Array<{ id: string }>
    ).map(({ id }) => id);

    db.prepare(
      `INSERT INTO knowledge_jobs
       (id, project_id, job_kind, source_version_id, status, payload_json, requested_at, retry_count, max_retries)
       VALUES (?, ?, 'analyze', NULL, 'queued', ?, ?, 0, 3)`,
    ).run(
      createKnowledgeId('job', 'mixed-rerun'),
      PROJECT_A,
      JSON.stringify({ sourceVersionId: python.sourceVersionId }),
      '2026-09-25T00:03:00.000Z',
    );
    const secondRun = await worker.runOnce(PROJECT_A);

    expect(secondRun).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(listKnowledgeReviews(db, PROJECT_A).map((review) => review.id)).toEqual(firstReviewIds);
    expect(
      (db.prepare(`SELECT id FROM knowledge_insights WHERE project_id = ? ORDER BY id`).all(PROJECT_A) as Array<{ id: string }>).map(
        ({ id }) => id,
      ),
    ).toEqual(firstInsightIds);
  });

  it('skips ungrounded enrichment identifiers instead of attaching them to unrelated project pages', async () => {
    const existingPage = pageStore.createPageVersion({
      projectId: PROJECT_A,
      pageId: 'page_existing' as never,
      type: 'source',
      title: 'src/existing.py',
      slug: 'source-src-existing-py',
      content: '# Existing\n',
      contentPath: 'pages/source/source-src-existing-py.md',
      createdAt: CREATED_AT,
    });
    const python = registerSource(PROJECT_A, 'src/grounded.py', 'print("grounded")\n');
    const enrich: KnowledgeEnrichmentService = {
      async enrich() {
        return {
          reviews: [
            {
              pageVersionId: existingPage.id,
              summary: 'Contradiction: unrelated existing page should not be targeted',
            },
          ],
          insights: [
            {
              type: 'research_gap',
              contentPath: 'pages/source/source-src-existing-py.md',
              confidence: 0.6,
            },
          ],
        };
      },
    };
    queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const worker = new KnowledgeWorker(db, { workerId: 'worker-grounding', now: () => CREATED_AT, enrich });

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'enrichment_ungrounded' }),
      ]),
    );
    expect(
      listKnowledgeReviews(db, PROJECT_A).filter(
        (review) => review.summary === 'Contradiction: unrelated existing page should not be targeted',
      ),
    ).toEqual([]);
    expect(
      db.prepare(
        `SELECT COUNT(*) AS count
         FROM knowledge_insights
         WHERE project_id = ? AND content_path = ?`,
      ).get(PROJECT_A, 'pages/source/source-src-existing-py.md'),
    ).toEqual({ count: 0 });
  });

  it('keeps projects isolated while draining only the requested project queue', async () => {
    const sourceA = registerSource(PROJECT_A, 'src/a.py', 'print("a")\n');
    const sourceB = registerSource(PROJECT_B, 'src/b.py', 'print("b")\n');
    const jobA = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: sourceA.sourceVersionId,
      payload: { sourceVersionId: sourceA.sourceVersionId },
    });
    const jobB = queue.enqueue({
      projectId: PROJECT_B,
      jobKind: 'analyze',
      sourceVersionId: sourceB.sourceVersionId,
      payload: { sourceVersionId: sourceB.sourceVersionId },
    });
    const worker = new KnowledgeWorker(db, { workerId: 'worker-isolation', now: () => CREATED_AT });

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ projectId: PROJECT_A, claimed: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(queue.get(jobA.id)?.status).toBe('completed');
    expect(queue.get(jobB.id)?.status).toBe('queued');
    expect(pageStore.listPages(PROJECT_A)).toHaveLength(1);
    expect(pageStore.listPages(PROJECT_B)).toHaveLength(0);
  });

  it('polls in bounded intervals and exits cleanly when watch mode is cancelled', async () => {
    const countingQueue = new CountingQueue(db, { leaseDurationMs: 90, now: () => CREATED_AT });
    const controller = new AbortController();
    const worker = new KnowledgeWorker(
      db,
      { workerId: 'worker-watch', now: () => CREATED_AT, signal: controller.signal },
      { queue: countingQueue },
    );

    setTimeout(() => controller.abort(), 65);
    await worker.runWatch(PROJECT_A, { pollMs: 20 });

    expect(countingQueue.claimCount).toBeGreaterThanOrEqual(2);
    expect(countingQueue.claimCount).toBeLessThanOrEqual(5);
  });

  it('persists bounded redacted failure messages when generation fails after deterministic stages', async () => {
    const python = registerSource(PROJECT_A, 'src/failure.py', 'print("failure")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const generator = {
      async runKnowledgeGeneration() {
        throw new Error(`generation failed sk-test-12345678901234567890 ${'x'.repeat(1_200)}`);
      },
    } as unknown as KnowledgeGeneratorService;
    const worker = new KnowledgeWorker(
      db,
      { workerId: 'worker-failure', now: () => CREATED_AT },
      { generator },
    );

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1, cancelled: 0 });
    const failedJob = queue.get(job.id);
    expect(failedJob).toMatchObject({ status: 'failed', failureCode: 'generation_failed' });
    expect(failedJob?.failureMessage).toContain('***');
    expect(failedJob?.failureMessage?.length ?? 0).toBeLessThanOrEqual(500);
  });

  it('counts expired-lease recovery failures in runOnce results without claiming a new job', async () => {
    const python = registerSource(PROJECT_A, 'src/recovery.py', 'print("recover")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
      maxRetries: 0,
    });
    expect(queue.claim(PROJECT_A, 'worker-recovery')?.id).toBe(job.id);
    queue.setNow(() => '2026-09-25T00:00:01.000Z');
    const worker = new KnowledgeWorker(db, { workerId: 'worker-recovery', now: () => '2026-09-25T00:00:01.000Z' });

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({
      projectId: PROJECT_A,
      claimed: 0,
      completed: 0,
      failed: 1,
      cancelled: 0,
    });
    expect(queue.get(job.id)).toMatchObject({
      status: 'failed',
      failureCode: 'lease_expired',
    });
  });

  it('does not leave completed progress behind when durable completion fails', async () => {
    const python = registerSource(PROJECT_A, 'src/terminal-failure.py', 'print("terminal failure")\n');
    const job = queue.enqueue({
      projectId: PROJECT_A,
      jobKind: 'analyze',
      sourceVersionId: python.sourceVersionId,
      payload: { sourceVersionId: python.sourceVersionId },
    });
    const throwingQueue = new (class extends KnowledgeQueue {
      public override complete(): never {
        throw new Error('simulated terminal completion failure');
      }
    })(db, { leaseDurationMs: 90, now: () => CREATED_AT });
    const worker = new KnowledgeWorker(
      db,
      { workerId: 'worker-terminal-failure', now: () => CREATED_AT },
      { queue: throwingQueue },
    );

    const result = await worker.runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1, cancelled: 0 });
    expect(throwingQueue.get(job.id)?.status).toBe('failed');
    expect(throwingQueue.listProgressEvents(job.id).map((event) => event.stage)).toEqual([
      'loading',
      'analyzing',
      'persisting',
      'graph',
      'generating',
    ]);
  });

  describe('analyzer coverage', () => {
    const SPAN = { startOffset: 0, endOffset: 4, startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 };

    function enqueueAnalyze(sourceVersionId: string) {
      return queue.enqueue({
        projectId: PROJECT_A,
        jobKind: 'analyze',
        sourceVersionId,
        payload: { sourceVersionId },
      });
    }

    function coverageRow(sourceVersionId: string) {
      return db
        .prepare('SELECT * FROM knowledge_analysis_coverage WHERE project_id = ? AND source_version_id = ?')
        .get(PROJECT_A, sourceVersionId) as Record<string, unknown> | undefined;
    }

    function registerBinarySource(sourcePath: string, bytes: Buffer): TestSource {
      const contentPath = `sources/files/${sourcePath.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.bin`;
      const absolutePath = join(workspaceRootFor(PROJECT_A), '.ariadne', 'knowledge', contentPath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, bytes);
      const source = sourceStore.register({
        projectId: PROJECT_A,
        kind: 'file',
        path: sourcePath,
        contentHash: sha256Bytes(bytes),
        contentPath,
        mimeType: 'application/octet-stream',
      });
      const version = sourceStore.listVersions(PROJECT_A, source.id)[0]!;
      return { sourceId: source.id, sourceVersionId: version.id, contentPath };
    }

    function sha256Bytes(bytes: Buffer): string {
      return createHash('sha256').update(bytes).digest('hex');
    }

    it('completes an unsupported source as coverage_only without extraction, page, or graph rows', async () => {
      const ruby = registerSource(PROJECT_A, 'scripts/deploy.rb', 'puts "deploy"\n', 'application/x-ruby');
      const job = enqueueAnalyze(ruby.sourceVersionId);

      const worker = new KnowledgeWorker(db, { workerId: 'worker-coverage-only', now: () => CREATED_AT });
      const result = await worker.runOnce(PROJECT_A);

      expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, cancelled: 0, unsupportedCoverageCount: 1 });
      expect(result.warnings).toEqual([
        expect.objectContaining({ jobId: job.id, code: 'coverage_no_analyzer' }),
      ]);
      expect(queue.get(job.id)).toMatchObject({
        status: 'completed',
        failureCode: null,
        resultSchemaVersion: 1,
        resultState: 'current',
        result: {
          resultKind: 'coverage_only',
          processingMode: 'deterministic',
          coverageStatus: 'unsupported',
          unsupportedReason: 'no_analyzer',
          analyzerId: null,
          analyzerVersion: null,
          extractionId: null,
        },
      });
      expect(
        db.prepare('SELECT result_processing_mode AS mode, result_schema_version AS version FROM knowledge_jobs WHERE id = ?').get(job.id),
      ).toEqual({ mode: 'deterministic', version: 1 });
      expect(coverageRow(ruby.sourceVersionId)).toMatchObject({
        status: 'unsupported',
        unsupported_reason: 'no_analyzer',
        analyzer_id: null,
        analyzer_version: null,
      });
      expect(countsForProject(PROJECT_A)).toEqual({
        extractions: { count: 0 },
        nodes: { count: 0 },
        edges: { count: 0 },
        pages: { count: 0 },
        pageVersions: { count: 0 },
        reviews: { count: 0 },
        insights: { count: 0 },
      });
      expect(queue.listProgressEvents(job.id).map((event) => event.stage)).toEqual(['loading', 'coverage', 'completed']);
    });

    it('writes a metadata_only search index row so unsupported files stay findable by path', async () => {
      const ruby = registerSource(PROJECT_A, 'scripts/deploy.rb', 'puts "deploy"\n', 'application/x-ruby');
      enqueueAnalyze(ruby.sourceVersionId);
      await new KnowledgeWorker(db, { workerId: 'worker-metadata', now: () => CREATED_AT }).runOnce(PROJECT_A);

      expect(
        db
          .prepare('SELECT coverage, status, extraction_id FROM knowledge_search_indexes WHERE project_id = ? AND source_version_id = ?')
          .get(PROJECT_A, ruby.sourceVersionId),
      ).toEqual({ coverage: 'metadata_only', status: 'active', extraction_id: null });
      expect(searchKnowledge('deploy.rb', { db, projectId: PROJECT_A, mode: 'sources' })[0]).toMatchObject({
        kind: 'source',
        title: 'scripts/deploy.rb',
      });
    });

    it('records non-UTF-8 content as binary_or_non_text coverage instead of failing the job', async () => {
      const blob = registerBinarySource('assets/blob.bin', Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]));
      const job = enqueueAnalyze(blob.sourceVersionId);
      const result = await new KnowledgeWorker(db, { workerId: 'worker-binary', now: () => CREATED_AT }).runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 1, failed: 0, unsupportedCoverageCount: 1 });
      expect(queue.get(job.id)?.result).toMatchObject({ resultKind: 'coverage_only', unsupportedReason: 'binary_or_non_text' });
      expect(coverageRow(blob.sourceVersionId)).toMatchObject({ status: 'unsupported', unsupported_reason: 'binary_or_non_text' });
      expect(db.prepare('SELECT coverage FROM knowledge_search_indexes WHERE source_version_id = ?').get(blob.sourceVersionId)).toEqual({
        coverage: 'metadata_only',
      });
    });

    it('completes oversized unsupported sources as size_limit_exceeded coverage instead of failing', async () => {
      const ruby = registerSource(PROJECT_A, 'scripts/huge.rb', `puts "${'x'.repeat(200)}"\n`, 'application/x-ruby');
      const job = enqueueAnalyze(ruby.sourceVersionId);
      const result = await new KnowledgeWorker(
        db,
        { workerId: 'worker-oversized', now: () => CREATED_AT, maxSourceBytes: 64 },
      ).runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 1, failed: 0, unsupportedCoverageCount: 1 });
      expect(result.warnings).toEqual([expect.objectContaining({ jobId: job.id, code: 'coverage_size_limit_exceeded' })]);
      expect(queue.get(job.id)).toMatchObject({
        status: 'completed',
        failureCode: null,
        result: {
          resultKind: 'coverage_only',
          coverageStatus: 'unsupported',
          unsupportedReason: 'size_limit_exceeded',
          warnings: [expect.objectContaining({ code: 'coverage_size_limit_exceeded' })],
        },
      });
      expect(coverageRow(ruby.sourceVersionId)).toMatchObject({ status: 'unsupported', unsupported_reason: 'size_limit_exceeded' });
      expect(db.prepare('SELECT coverage FROM knowledge_search_indexes WHERE source_version_id = ?').get(ruby.sourceVersionId)).toEqual({
        coverage: 'metadata_only',
      });
    });

    it('still fails oversized sources that have a supported analyzer with source_too_large', async () => {
      const python = registerSource(PROJECT_A, 'src/huge.py', `x = "${'y'.repeat(200)}"\n`);
      const job = enqueueAnalyze(python.sourceVersionId);
      const result = await new KnowledgeWorker(
        db,
        { workerId: 'worker-oversized-supported', now: () => CREATED_AT, maxSourceBytes: 64 },
      ).runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 0, failed: 1, unsupportedCoverageCount: 0 });
      expect(queue.get(job.id)).toMatchObject({ status: 'failed', failureCode: 'source_too_large' });
      expect(coverageRow(python.sourceVersionId)).toBeUndefined();
    });

    it('does not put source content or the private path in coverage rows or job results', async () => {
      const ruby = registerSource(PROJECT_A, 'scripts/secret-deploy.rb', 'API_TOKEN = "sk-abcdefghijklmnopqrstuvwxyz0123456789"\n', 'application/x-ruby');
      const job = enqueueAnalyze(ruby.sourceVersionId);
      await new KnowledgeWorker(db, { workerId: 'worker-privacy', now: () => CREATED_AT }).runOnce(PROJECT_A);

      const serialized = JSON.stringify([coverageRow(ruby.sourceVersionId), queue.get(job.id)?.result]);
      expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
      expect(serialized).not.toContain(workspaceRootFor(PROJECT_A));
      expect(serialized).not.toContain('secret-deploy');
    });

    it('still fails unsupported job kinds with unsupported_source and writes no coverage', async () => {
      const python = registerSource(PROJECT_A, 'src/kind.py', 'print("hi")\n');
      const job = queue.enqueue({
        projectId: PROJECT_A,
        jobKind: 'summarize',
        sourceVersionId: python.sourceVersionId,
        payload: { sourceVersionId: python.sourceVersionId },
      });
      const result = await new KnowledgeWorker(db, { workerId: 'worker-kind', now: () => CREATED_AT }).runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 0, failed: 1, unsupportedCoverageCount: 0 });
      expect(queue.get(job.id)).toMatchObject({ status: 'failed', failureCode: 'unsupported_source' });
      expect(coverageRow(python.sourceVersionId)).toBeUndefined();
    });

    it('records supported coverage for a normal analysis without changing warnings or graph output', async () => {
      const python = registerSource(PROJECT_A, 'src/plain.py', 'class Plain:\n    def run(self):\n        return 1\n');
      const job = enqueueAnalyze(python.sourceVersionId);
      const result = await new KnowledgeWorker(db, { workerId: 'worker-supported', now: () => CREATED_AT }).runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 1, failed: 0, unsupportedCoverageCount: 0, warnings: [] });
      expect(queue.get(job.id)?.result).toMatchObject({ resultKind: 'analyzed', coverageStatus: 'supported', warnings: [] });
      expect(coverageRow(python.sourceVersionId)).toMatchObject({
        status: 'supported',
        analyzer_id: 'python-lezer',
        generated_code: 0,
        unsupported_reason: null,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 3 });
    });

    it('keeps generated-code detection advisory: extraction, pages, and graph still complete', async () => {
      const python = registerSource(PROJECT_A, 'src/gen.py', '# @generated by codegen\nclass Generated:\n    pass\n');
      const job = enqueueAnalyze(python.sourceVersionId);
      const result = await new KnowledgeWorker(db, { workerId: 'worker-generated', now: () => CREATED_AT }).runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 1, failed: 0 });
      expect(queue.get(job.id)?.result).toMatchObject({ resultKind: 'analyzed', coverageStatus: 'supported' });
      expect(coverageRow(python.sourceVersionId)).toMatchObject({
        status: 'supported',
        generated_code: 1,
        generated_reason: 'generated_marker',
      });
      expect(String(coverageRow(python.sourceVersionId)?.diagnostics_json)).toContain('coverage_generated_code_detected');
      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_extractions WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 1 });
      expect(pageStore.listPages(PROJECT_A, 'source')).toHaveLength(1);
    });

    it('persists partial coverage and deferred relationships without adding graph nodes or edges', async () => {
      const baseline = registerSource(PROJECT_A, 'src/base.txt', 'baseline text');
      const dynamic = registerSource(PROJECT_A, 'src/dynamic.txt', 'dynamic text');
      const analyzer = new StubAnalyzer('dynamic-analyzer', '1.0.0', true, async (input) => {
        const extraction = createExtraction(input);
        if (input.sourceVersionId !== dynamic.sourceVersionId) return extraction;
        return {
          ...extraction,
          coverage: {
            status: 'partial',
            analyzerId: 'dynamic-analyzer',
            analyzerVersion: '1.0.0',
            generatedCode: false,
            generatedReason: null,
            supportedFeatures: ['static_calls'],
            missingFeatures: ['dynamic_dispatch'],
            warnings: [],
          },
          deferredRelationships: [
            {
              id: 'deferred_1',
              type: 'calls',
              sourceSymbolId: 'module_1',
              targetReference: 'getattr(obj, name)',
              resolutionKind: 'dynamic_runtime',
              evidenceKind: 'syntax',
              confidence: 0.3,
              span: SPAN,
            },
          ],
        } satisfies DeterministicExtraction;
      });
      const worker = new KnowledgeWorker(db, { workerId: 'worker-partial', now: () => CREATED_AT }, { analyzers: { require: () => analyzer } });
      const baseJob = enqueueAnalyze(baseline.sourceVersionId);
      await worker.runOnce(PROJECT_A);
      expect(queue.get(baseJob.id)?.result).toMatchObject({ coverageStatus: 'supported' });

      const job = enqueueAnalyze(dynamic.sourceVersionId);
      const result = await worker.runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 1, failed: 0, unsupportedCoverageCount: 0 });
      expect(result.warnings.map((warning) => warning.code)).toContain('coverage_partial_dynamic_relationships');
      expect(queue.get(job.id)?.result).toMatchObject({
        resultKind: 'analyzed',
        coverageStatus: 'partial',
        warnings: expect.arrayContaining([expect.objectContaining({ code: 'coverage_partial_dynamic_relationships' })]),
      });
      expect(coverageRow(dynamic.sourceVersionId)).toMatchObject({ status: 'partial', analyzer_id: 'dynamic-analyzer' });
      expect(JSON.parse(String(coverageRow(dynamic.sourceVersionId)?.missing_features_json))).toEqual(['dynamic_dispatch']);
      expect(
        db.prepare('SELECT resolution_kind, relationship_type, target_reference FROM knowledge_deferred_relationships WHERE source_version_id = ?').all(dynamic.sourceVersionId),
      ).toEqual([{ resolution_kind: 'dynamic_runtime', relationship_type: 'calls', target_reference: 'getattr(obj, name)' }]);
      const nodesForDynamic = db
        .prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes WHERE project_id = ? AND source_id = ?')
        .get(PROJECT_A, dynamic.sourceId) as { count: number };
      const nodesForBaseline = db
        .prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes WHERE project_id = ? AND source_id = ?')
        .get(PROJECT_A, baseline.sourceId) as { count: number };
      expect(nodesForDynamic).toEqual(nodesForBaseline);
      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_edges WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 0 });
    });

    it('treats an analyzer exception as failed coverage and still fails the job', async () => {
      const python = registerSource(PROJECT_A, 'src/boom.py', 'print("boom secret-content")\n');
      const job = enqueueAnalyze(python.sourceVersionId);
      const boom = new StubAnalyzer('boom-analyzer', '2.0.0', true, async () => {
        throw new Error('parse blew up near secret-content');
      });
      const result = await new KnowledgeWorker(db, { workerId: 'worker-failed', now: () => CREATED_AT }, { analyzers: { require: () => boom } }).runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 0, failed: 1, unsupportedCoverageCount: 0 });
      expect(queue.get(job.id)).toMatchObject({ status: 'failed', failureCode: 'analyzer_failed', result: null });
      expect(coverageRow(python.sourceVersionId)).toMatchObject({
        status: 'failed',
        analyzer_id: 'boom-analyzer',
        unsupported_reason: 'parser_failed',
      });
      expect(JSON.stringify(coverageRow(python.sourceVersionId))).not.toContain('secret-content');
      expect(countsForProject(PROJECT_A).extractions).toEqual({ count: 0 });
    });

    it('upserts a single coverage row when the same source version is reanalyzed', async () => {
      const python = registerSource(PROJECT_A, 'src/again.py', 'x = 1\n');
      const job = enqueueAnalyze(python.sourceVersionId);
      const worker = new KnowledgeWorker(db, { workerId: 'worker-again', now: () => CREATED_AT });
      await worker.runOnce(PROJECT_A);
      const firstId = coverageRow(python.sourceVersionId)?.id;

      db.prepare(
        `UPDATE knowledge_jobs
         SET status = 'queued', completed_at = NULL, result_json = NULL, result_processing_mode = NULL,
             result_schema_version = NULL, worker_id = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      ).run(job.id);
      await worker.runOnce(PROJECT_A);

      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_analysis_coverage').get()).toEqual({ count: 1 });
      expect(coverageRow(python.sourceVersionId)?.id).toBe(firstId);
    });

    it('resolves through an injected registry that only implements resolve()', async () => {
      const ruby = registerSource(PROJECT_A, 'scripts/x.rb', 'puts 1\n', 'application/x-ruby');
      const job = enqueueAnalyze(ruby.sourceVersionId);
      const registry = {
        resolve: () => ({
          kind: 'unsupported' as const,
          coverage: {
            status: 'unsupported' as const,
            analyzerId: null,
            analyzerVersion: null,
            generatedCode: false,
            generatedReason: null,
            supportedFeatures: [],
            missingFeatures: [],
            warnings: [],
            unsupportedReason: 'policy_rejected' as const,
          },
        }),
        require: () => {
          throw new Error('require must not be used when resolve exists');
        },
      };
      await new KnowledgeWorker(db, { workerId: 'worker-resolve', now: () => CREATED_AT }, { analyzers: registry }).runOnce(PROJECT_A);
      expect(queue.get(job.id)?.result).toMatchObject({ resultKind: 'coverage_only', unsupportedReason: 'policy_rejected' });
    });
  });

  describe('graph completeness reports', () => {
    function enqueueAnalyze(sourceVersionId: string) {
      return queue.enqueue({
        projectId: PROJECT_A,
        jobKind: 'analyze',
        sourceVersionId,
        payload: { sourceVersionId },
      });
    }

    it('recomputes the project graph report after a run completes jobs, without touching other projects', async () => {
      const python = registerSource(PROJECT_A, 'src/report.py', 'class Reported:\n    def go(self):\n        return 1\n');
      const ruby = registerSource(PROJECT_A, 'scripts/report.rb', 'puts "x"\n', 'application/x-ruby');
      enqueueAnalyze(python.sourceVersionId);
      enqueueAnalyze(ruby.sourceVersionId);
      registerSource(PROJECT_B, 'src/other.py', 'x = 1\n');

      const result = await new KnowledgeWorker(db, { workerId: 'worker-report', now: () => CREATED_AT }).runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 2, failed: 0 });
      expect(result.warnings.map((warning) => warning.code)).toEqual(['coverage_no_analyzer']);
      const report = new KnowledgeGraphReporter(db).getCompletenessReport(PROJECT_A);
      expect(report).toMatchObject({
        sources: { activeCount: 2, coveredCount: 1, unsupportedCount: 1, legacyUnknownCount: 0 },
        relationships: { materializedCount: 2 },
      });
      expect(report?.warnings.map((warning) => warning.code)).toEqual(['partial_source_coverage']);
      expect(new KnowledgeGraphReporter(db).getCompletenessReport(PROJECT_B)).toBeNull();
    });

    it('preserves alias-ambiguous relationships as deferred evidence and reports them for review', async () => {
      const source = registerSource(PROJECT_A, 'src/alias.txt', 'alias text');
      const span = { startOffset: 0, endOffset: 4, startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 };
      const analyzer = new StubAnalyzer('alias-analyzer', '1.0.0', true, async (input) => ({
        ...createExtraction(input),
        symbols: [
          { id: 'module_1', kind: 'module', name: 'alias', qualifiedName: 'alias', confidence: 1, span },
          { id: 'fn_a', kind: 'function', name: 'dup', qualifiedName: 'alias.a.dup', confidence: 1, span: { ...span, startOffset: 5, endOffset: 9 } },
          { id: 'fn_b', kind: 'function', name: 'dup', qualifiedName: 'alias.b.dup', confidence: 1, span: { ...span, startOffset: 10, endOffset: 14 } },
        ],
        relationships: [
          { id: 'rel_1', type: 'calls', sourceSymbolId: 'module_1', targetReference: 'dup', confidence: 0.7, span },
        ],
      }));
      enqueueAnalyze(source.sourceVersionId);
      const worker = new KnowledgeWorker(db, { workerId: 'worker-alias', now: () => CREATED_AT }, { analyzers: { require: () => analyzer } });

      await worker.runOnce(PROJECT_A);

      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_edges WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 0 });
      expect(
        db
          .prepare('SELECT relationship_type, resolution_kind, evidence_kind FROM knowledge_deferred_relationships WHERE project_id = ?')
          .all(PROJECT_A),
      ).toEqual([{ relationship_type: 'calls', resolution_kind: 'ambiguous_alias', evidence_kind: 'naming' }]);
      const reporter = new KnowledgeGraphReporter(db);
      expect(reporter.getCompletenessReport(PROJECT_A)?.relationships).toMatchObject({ deferredCount: 1, ambiguousCount: 1 });
      expect(reporter.listAmbiguities(PROJECT_A)).toEqual([
        expect.objectContaining({ ambiguityKind: 'multiple_candidate_targets', severity: 'review', candidateNodeIds: expect.any(Array) }),
      ]);
      expect(reporter.listAmbiguities(PROJECT_A)[0]?.candidateNodeIds).toHaveLength(2);

      await worker.runOnce(PROJECT_A);
      enqueueAnalyze(source.sourceVersionId);
      await worker.runOnce(PROJECT_A);
      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_deferred_relationships WHERE project_id = ?').get(PROJECT_A)).toEqual({ count: 1 });
    });

    it('does not compute a report when no job completed', async () => {
      registerSource(PROJECT_A, 'src/idle.py', 'x = 1\n');
      await new KnowledgeWorker(db, { workerId: 'worker-idle', now: () => CREATED_AT }).runOnce(PROJECT_A);
      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_reports').get()).toEqual({ count: 0 });
    });

    it('keeps the job completed and surfaces a warning when report generation fails', async () => {
      const python = registerSource(PROJECT_A, 'src/failing-report.py', 'x = 1\n');
      const job = enqueueAnalyze(python.sourceVersionId);
      const graphReporter = {
        buildCompletenessReport: () => {
          throw new Error('report store unavailable');
        },
      };

      const result = await new KnowledgeWorker(
        db,
        { workerId: 'worker-report-failure', now: () => CREATED_AT },
        { graphReporter },
      ).runOnce(PROJECT_A);

      expect(result).toMatchObject({ completed: 1, failed: 0 });
      expect(queue.get(job.id)?.status).toBe('completed');
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ jobId: job.id, code: 'graph_report_failed', message: expect.stringContaining('report store unavailable') }),
      );
    });
  });

  function createWorkspaceRoot(projectId: string): string {
    const workspaceRoot = mkdtempSync(join(process.cwd(), `.knowledge-worker-${projectId}-`));
    workspaceRoots.push(workspaceRoot);
    return workspaceRoot;
  }

  function insertProject(projectId: string, workspaceRoot: string): void {
    db.prepare(
      `INSERT INTO knowledge_projects
       (id, workspace_root, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run(projectId, workspaceRoot, projectId, CREATED_AT, CREATED_AT);
  }

  function workspaceRootFor(projectId: string): string {
    const row = db.prepare('SELECT workspace_root FROM knowledge_projects WHERE id = ?').get(projectId) as { workspace_root: string };
    return row.workspace_root;
  }

  function writeStoredContent(projectId: string, contentPath: string, content: string): void {
    const absolutePath = join(workspaceRootFor(projectId), '.ariadne', 'knowledge', contentPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  }

  function registerSource(projectId: string, sourcePath: string, content: string, mimeType?: string): TestSource {
    const slug = sourcePath.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const contentPath = `sources/files/${slug}.txt`;
    writeStoredContent(projectId, contentPath, content);
    const source = sourceStore.register({
      projectId,
      kind: 'file',
      path: sourcePath,
      content,
      contentPath,
      mimeType: mimeType ?? (sourcePath.endsWith('.py') ? 'text/x-python' : 'text/plain'),
    });
    const version = sourceStore.listVersions(projectId, source.id)[0]!;
    return {
      sourceId: source.id,
      sourceVersionId: version.id,
      contentPath,
    };
  }

  function countsForProject(projectId: string) {
    return {
      extractions: db.prepare('SELECT COUNT(*) AS count FROM knowledge_extractions WHERE project_id = ?').get(projectId),
      nodes: db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes WHERE project_id = ?').get(projectId),
      edges: db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_edges WHERE project_id = ?').get(projectId),
      pages: db.prepare('SELECT COUNT(*) AS count FROM knowledge_pages WHERE project_id = ?').get(projectId),
      pageVersions: db.prepare('SELECT COUNT(*) AS count FROM knowledge_page_versions WHERE project_id = ?').get(projectId),
      reviews: db.prepare('SELECT COUNT(*) AS count FROM knowledge_reviews WHERE project_id = ?').get(projectId),
      insights: db.prepare('SELECT COUNT(*) AS count FROM knowledge_insights WHERE project_id = ?').get(projectId),
    };
  }
});
