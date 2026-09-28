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
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import { KnowledgeWorker, type KnowledgeEnrichmentService } from '../../src/knowledge/KnowledgeWorker.js';
import { KnowledgeGraph } from '../../src/knowledge/graph/KnowledgeGraph.js';
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

  function registerSource(projectId: string, sourcePath: string, content: string): TestSource {
    const slug = sourcePath.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const contentPath = `sources/files/${slug}.txt`;
    writeStoredContent(projectId, contentPath, content);
    const source = sourceStore.register({
      projectId,
      kind: 'file',
      path: sourcePath,
      content,
      contentPath,
      mimeType: sourcePath.endsWith('.py') ? 'text/x-python' : 'text/plain',
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
