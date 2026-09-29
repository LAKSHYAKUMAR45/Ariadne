import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeFreshnessService } from '../../src/knowledge/KnowledgeFreshness.js';
import { KnowledgeQueue } from '../../src/knowledge/KnowledgeQueue.js';
import { KnowledgeSearchIndex } from '../../src/knowledge/KnowledgeSearchIndex.js';
import { KnowledgeWorker } from '../../src/knowledge/KnowledgeWorker.js';
import { AnalyzerRegistry, type DeterministicAnalyzer } from '../../src/knowledge/analyzers/index.js';
import { createFreshnessHarness, type FreshnessHarness } from './freshnessTestHarness.js';

interface FreshnessRow {
  source_id: string;
  freshness_state: string;
  current_source_version_id: string | null;
  last_observed_hash: string | null;
  last_event_kind: string | null;
  last_enqueued_job_id: string | null;
  last_error_code: string | null;
}

const ANALYZED = {
  processingMode: 'deterministic' as const,
  analyzerId: 'markdown',
  analyzerVersion: '1.0.0',
  extractionId: 'extraction_1',
  pageVersionIds: [] as string[],
  graphNodeCount: 1,
  graphEdgeCount: 0,
  warnings: [],
};

function analyzerStub(id: string, version: string): DeterministicAnalyzer {
  return {
    id,
    version,
    supports: () => true,
    analyze: () => Promise.reject(new Error('not used')),
  };
}

function registryOf(analyzer: DeterministicAnalyzer | null) {
  const registry = new AnalyzerRegistry();
  if (analyzer) registry.register(analyzer);
  return registry;
}

describe('KnowledgeFreshnessService.refreshProject', () => {
  let harness: FreshnessHarness;
  let clock: string;
  let service: KnowledgeFreshnessService;
  let project: { id: string; workspaceRoot: string };

  const freshnessRows = (projectId = project.id): FreshnessRow[] =>
    harness.db
      .prepare(
        `SELECT f.source_id, f.freshness_state, f.current_source_version_id, f.last_observed_hash, f.last_event_kind,
                f.last_enqueued_job_id, f.last_error_code
         FROM knowledge_source_freshness f
         JOIN knowledge_sources s ON s.project_id = f.project_id AND s.id = f.source_id
         WHERE f.project_id = ? ORDER BY s.source_path`,
      )
      .all(projectId) as FreshnessRow[];
  const count = (table: string, projectId = project.id): number =>
    (harness.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(projectId) as { count: number }).count;
  const stateOf = (sourcePath: string, projectId = project.id): string | undefined =>
    (harness.db
      .prepare(
        `SELECT f.freshness_state FROM knowledge_source_freshness f
         JOIN knowledge_sources s ON s.project_id = f.project_id AND s.id = f.source_id
         WHERE f.project_id = ? AND s.source_path = ?`,
      )
      .get(projectId, sourcePath) as { freshness_state: string } | undefined)?.freshness_state;
  const analyzeJobs = (projectId = project.id) =>
    harness.queue.list(projectId).filter((job) => job.jobKind === 'analyze');
  const jobFor = (sourcePath: string, projectId = project.id) => {
    const row = harness.db
      .prepare(
        `SELECT j.id FROM knowledge_jobs j
         JOIN knowledge_source_versions v ON v.project_id = j.project_id AND v.id = j.source_version_id
         JOIN knowledge_sources s ON s.project_id = v.project_id AND s.id = v.source_id
         WHERE j.project_id = ? AND s.source_path = ? ORDER BY v.version_number DESC LIMIT 1`,
      )
      .get(projectId, sourcePath) as { id: string };
    return harness.queue.get(row.id)!;
  };
  const completeJob = (jobId: string, overrides: Record<string, unknown> = {}) => {
    const job = harness.queue.claim(project.id, 'worker-test');
    expect(job?.id).toBe(jobId);
    return harness.queue.complete(jobId, 'worker-test', { ...ANALYZED, ...overrides });
  };
  const failJob = (jobId: string, code = 'analyzer_failed') => {
    expect(harness.queue.claim(project.id, 'worker-test')?.id).toBe(jobId);
    return harness.queue.fail(jobId, code, 'boom', 'worker-test');
  };

  beforeEach(() => {
    clock = '2026-02-01T00:00:00.000Z';
    harness = createFreshnessHarness(() => clock);
    project = harness.createProject('project_a');
    service = new KnowledgeFreshnessService(harness.db, {
      now: () => clock,
      queue: harness.queue,
      analyzers: registryOf(analyzerStub('markdown', '1.0.0')),
    });
  });

  afterEach(() => harness.cleanup());

  it('registers new sources, enqueues one analyze job each, and marks them pending', async () => {
    harness.writeFile(project.workspaceRoot, 'docs/a.md', '# A\n');
    harness.writeFile(project.workspaceRoot, 'docs/b.md', '# B\n');

    const result = await service.refreshProject(project.id, 'startup');

    expect(result).toMatchObject({
      projectId: project.id,
      reason: 'startup',
      registeredSources: 2,
      newVersions: 2,
      enqueuedJobs: 2,
      requeuedJobs: 0,
      unchangedSources: 0,
      missingSources: 0,
      failedSources: 0,
    });
    expect(freshnessRows().map((row) => [row.freshness_state, row.last_event_kind])).toEqual([
      ['pending', 'created'],
      ['pending', 'created'],
    ]);
    expect(analyzeJobs()).toHaveLength(2);
    expect(analyzeJobs().every((job) => job.status === 'queued')).toBe(true);
    expect(freshnessRows().every((row) => row.last_enqueued_job_id !== null && row.current_source_version_id !== null)).toBe(true);
    expect(service.getStatus(project.id)).toMatchObject({ pendingCount: 2, failedCount: 0, missingCount: 0, watcherStatus: 'idle' });
  });

  it('never registers sensitive, ignored, or out-of-root files and stays workspace confined', async () => {
    const scoped = harness.createProject('project_scoped', { roots: ['docs'] });
    harness.writeFile(scoped.workspaceRoot, 'docs/ok.md', 'ok');
    harness.writeFile(scoped.workspaceRoot, 'docs/.env', 'SECRET=1');
    harness.writeFile(scoped.workspaceRoot, 'docs/api-token.txt', 'secret');
    harness.writeFile(scoped.workspaceRoot, 'src/outside.md', 'outside');

    const result = await service.refreshProject(scoped.id, 'manual');

    expect(result.registeredSources).toBe(1);
    const paths = (harness.db.prepare('SELECT source_path FROM knowledge_sources WHERE project_id = ?').all(scoped.id) as Array<{ source_path: string }>).map((row) => row.source_path);
    expect(paths).toEqual(['docs/ok.md']);
  });

  it('is a no-op for unchanged content', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'one');
    await service.refreshProject(project.id, 'startup');
    const versions = count('knowledge_source_versions');
    const jobs = count('knowledge_jobs');

    clock = '2026-02-01T00:05:00.000Z';
    const result = await service.refreshProject(project.id, 'periodic-rescan');

    expect(result).toMatchObject({ registeredSources: 0, newVersions: 0, enqueuedJobs: 0, requeuedJobs: 0, unchangedSources: 1, missingSources: 0 });
    expect(count('knowledge_source_versions')).toBe(versions);
    expect(count('knowledge_jobs')).toBe(jobs);
    expect(freshnessRows()).toHaveLength(1);
  });

  it('turns a completed job fresh and a changed file into a new version with exactly one new analyze job', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'one');
    await service.refreshProject(project.id, 'startup');
    const firstJob = jobFor('a.md');
    completeJob(firstJob.id);
    await service.refreshProject(project.id, 'periodic-rescan');
    expect(stateOf('a.md')).toBe('fresh');

    harness.writeFile(project.workspaceRoot, 'a.md', 'two');
    const result = await service.refreshProject(project.id, 'watch-event');

    expect(result).toMatchObject({ registeredSources: 0, newVersions: 1, enqueuedJobs: 1, requeuedJobs: 0, unchangedSources: 0 });
    expect(analyzeJobs()).toHaveLength(2);
    expect(harness.queue.get(firstJob.id)?.status).toBe('completed');
    const [row] = freshnessRows();
    expect(row).toMatchObject({ freshness_state: 'pending', last_event_kind: 'changed' });
    expect(row.last_enqueued_job_id).not.toBe(firstJob.id);
    const versions = harness.db.prepare('SELECT COUNT(*) AS count FROM knowledge_source_versions').get() as { count: number };
    expect(versions.count).toBe(2);
  });

  it('marks the search index of a superseded source version stale when the file changes', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'one');
    await service.refreshProject(project.id, 'startup');
    const version = harness.db.prepare('SELECT id FROM knowledge_source_versions WHERE project_id = ?').get(project.id) as { id: string };
    new KnowledgeSearchIndex(harness.db).replaceForSourceVersion({ projectId: project.id, sourceVersionId: version.id, coverage: 'metadata_only' });

    harness.writeFile(project.workspaceRoot, 'a.md', 'two');
    await service.refreshProject(project.id, 'watch-event');

    expect(harness.db.prepare('SELECT status FROM knowledge_search_indexes WHERE source_version_id = ?').get(version.id)).toEqual({ status: 'stale' });
  });

  it('reconciles deleted files as missing, marks the index stale, keeps history, and is idempotent', async () => {
    harness.writeFile(project.workspaceRoot, 'gone.md', 'bye');
    harness.writeFile(project.workspaceRoot, 'kept.md', 'stay');
    await service.refreshProject(project.id, 'startup');
    const version = harness.db.prepare(`SELECT v.id FROM knowledge_source_versions v JOIN knowledge_sources s ON s.id = v.source_id WHERE s.source_path = 'gone.md'`).get() as { id: string };
    new KnowledgeSearchIndex(harness.db).replaceForSourceVersion({ projectId: project.id, sourceVersionId: version.id, coverage: 'metadata_only' });

    rmSync(join(project.workspaceRoot, 'gone.md'));
    const result = await service.refreshProject(project.id, 'watch-event');

    expect(result).toMatchObject({ missingSources: 1, unchangedSources: 1, newVersions: 0 });
    expect(stateOf('gone.md')).toBe('missing');
    expect(stateOf('kept.md')).toBe('pending');
    expect(harness.db.prepare(`SELECT status FROM knowledge_sources WHERE source_path = 'gone.md'`).get()).toEqual({ status: 'stale' });
    expect(harness.db.prepare('SELECT status FROM knowledge_search_indexes WHERE source_version_id = ?').get(version.id)).toEqual({ status: 'stale' });
    expect(count('knowledge_source_versions')).toBe(2);
    expect(service.getStatus(project.id)).toMatchObject({ missingCount: 1, pendingCount: 1 });

    const again = await service.refreshProject(project.id, 'periodic-rescan');
    expect(again).toMatchObject({ missingSources: 1, newVersions: 0, enqueuedJobs: 0, requeuedJobs: 0 });
  });

  it('restores a deleted file with identical content by reactivating the source and requeueing its completed job', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'same');
    await service.refreshProject(project.id, 'startup');
    const job = jobFor('a.md');
    completeJob(job.id);
    rmSync(join(project.workspaceRoot, 'a.md'));
    await service.refreshProject(project.id, 'watch-event');
    expect(stateOf('a.md')).toBe('missing');

    harness.writeFile(project.workspaceRoot, 'a.md', 'same');
    const result = await service.refreshProject(project.id, 'watch-event');

    expect(result).toMatchObject({ newVersions: 0, enqueuedJobs: 0, requeuedJobs: 1, missingSources: 0 });
    expect(harness.db.prepare(`SELECT status FROM knowledge_sources WHERE source_path = 'a.md'`).get()).toEqual({ status: 'active' });
    expect(harness.queue.get(job.id)?.status).toBe('queued');
    expect(stateOf('a.md')).toBe('pending');
    expect(count('knowledge_source_versions')).toBe(1);
  });

  it('treats a file that becomes ineligible (policy or size) as missing without bypassing policy', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'small');
    const limited = new KnowledgeFreshnessService(harness.db, { now: () => clock, queue: harness.queue, maxBytes: 10 });
    await limited.refreshProject(project.id, 'startup');
    harness.writeFile(project.workspaceRoot, 'a.md', 'this file is now far too large');

    const result = await limited.refreshProject(project.id, 'watch-event');

    expect(result.missingSources).toBe(1);
    expect(stateOf('a.md')).toBe('missing');
  });

  describe('analyze job uniqueness and requeue rules', () => {
    beforeEach(async () => {
      harness.writeFile(project.workspaceRoot, 'a.md', 'one');
      await service.refreshProject(project.id, 'startup');
    });

    it('leaves queued and running jobs untouched and never disturbs a leased job', async () => {
      const job = jobFor('a.md');
      const claimed = harness.queue.claim(project.id, 'worker-live');
      expect(claimed?.leaseExpiresAt).not.toBeNull();

      for (const reason of ['manual', 'startup', 'watch-recovery'] as const) {
        const result = await service.refreshProject(project.id, reason);
        expect(result).toMatchObject({ enqueuedJobs: 0, requeuedJobs: 0, unchangedSources: 1 });
      }

      expect(harness.queue.get(job.id)).toMatchObject({ status: 'running', workerId: 'worker-live', leaseExpiresAt: claimed?.leaseExpiresAt });
      expect(stateOf('a.md')).toBe('pending');
      expect(analyzeJobs()).toHaveLength(1);
    });

    it('recovers expired leases on startup and watch-recovery refreshes only', async () => {
      const job = jobFor('a.md');
      harness.queue.claim(project.id, 'worker-dead');
      clock = '2026-02-01T00:10:00.000Z';

      const periodic = await service.refreshProject(project.id, 'periodic-rescan');
      expect(periodic.recoveredLeases).toBe(0);
      expect(harness.queue.get(job.id)?.status).toBe('running');

      const startup = await service.refreshProject(project.id, 'startup');
      expect(startup.recoveredLeases).toBe(1);
      expect(harness.queue.get(job.id)).toMatchObject({ status: 'queued', workerId: null, leaseExpiresAt: null });
      expect(stateOf('a.md')).toBe('pending');
    });

    it('records failed freshness and only requeues failed jobs on a manual refresh', async () => {
      const job = jobFor('a.md');
      failJob(job.id, 'analyzer_failed');

      for (const reason of ['periodic-rescan', 'watch-event', 'startup', 'watch-recovery'] as const) {
        const result = await service.refreshProject(project.id, reason);
        expect(result).toMatchObject({ requeuedJobs: 0, failedSources: 1 });
        expect(harness.queue.get(job.id)?.status).toBe('failed');
      }
      const [failed] = freshnessRows();
      expect(failed).toMatchObject({ freshness_state: 'failed', last_error_code: 'analyzer_failed' });
      expect(service.getStatus(project.id).failedCount).toBe(1);

      const manual = await service.refreshProject(project.id, 'manual');
      expect(manual).toMatchObject({ requeuedJobs: 1, enqueuedJobs: 0, failedSources: 0 });
      expect(harness.queue.get(job.id)).toMatchObject({ status: 'queued', retryCount: 0 });
      expect(stateOf('a.md')).toBe('pending');
      expect(analyzeJobs()).toHaveLength(1);
    });

    it('requeues cancelled jobs on manual, startup, and watch-recovery refreshes but not on periodic or event refreshes', async () => {
      const job = jobFor('a.md');
      harness.queue.cancel(job.id);

      for (const reason of ['periodic-rescan', 'watch-event'] as const) {
        expect(await service.refreshProject(project.id, reason)).toMatchObject({ requeuedJobs: 0 });
        expect(harness.queue.get(job.id)?.status).toBe('cancelled');
        expect(stateOf('a.md')).toBe('pending');
      }
      for (const reason of ['startup', 'manual', 'watch-recovery'] as const) {
        if (harness.queue.get(job.id)?.status !== 'cancelled') harness.queue.cancel(job.id);
        const result = await service.refreshProject(project.id, reason);
        expect(result.requeuedJobs).toBe(1);
        expect(harness.queue.listRequeueEvents(job.id).at(-1)?.reason).toBe('cancelled_recovery');
      }
    });

    it('requeues once when the resolved analyzer version differs from the completed analysis', async () => {
      const job = jobFor('a.md');
      completeJob(job.id);
      const upgraded = new KnowledgeFreshnessService(harness.db, {
        now: () => clock,
        queue: harness.queue,
        analyzers: registryOf(analyzerStub('markdown', '2.0.0')),
      });

      const first = await upgraded.refreshProject(project.id, 'periodic-rescan');
      expect(first).toMatchObject({ requeuedJobs: 1, enqueuedJobs: 0 });
      expect(harness.queue.get(job.id)).toMatchObject({ status: 'queued', result: null });
      expect(harness.queue.listRequeueEvents(job.id)).toEqual([
        expect.objectContaining({ reason: 'analyzer_upgraded', previousStatus: 'completed', targetAnalyzer: 'markdown@2.0.0' }),
      ]);

      // A worker that still resolves the old analyzer completes again; the trigger must not loop.
      completeJob(job.id);
      const second = await upgraded.refreshProject(project.id, 'periodic-rescan');
      expect(second).toMatchObject({ requeuedJobs: 0, unchangedSources: 1 });
      expect(harness.queue.get(job.id)?.status).toBe('completed');
      expect(stateOf('a.md')).toBe('fresh');

      const next = new KnowledgeFreshnessService(harness.db, {
        now: () => clock,
        queue: harness.queue,
        analyzers: registryOf(analyzerStub('markdown', '3.0.0')),
      });
      expect((await next.refreshProject(project.id, 'periodic-rescan')).requeuedJobs).toBe(1);
    });

    it('treats a completed coverage_only job as fresh and requeues it once when an analyzer becomes available', async () => {
      const job = jobFor('a.md');
      harness.queue.claim(project.id, 'worker-test');
      harness.queue.complete(job.id, 'worker-test', {
        resultKind: 'coverage_only',
        processingMode: 'deterministic',
        coverageStatus: 'unsupported',
        unsupportedReason: 'no_analyzer',
        analyzerId: null,
        analyzerVersion: null,
        extractionId: null,
        warnings: [],
      });
      const unsupported = new KnowledgeFreshnessService(harness.db, { now: () => clock, queue: harness.queue, analyzers: registryOf(null) });
      expect(await unsupported.refreshProject(project.id, 'periodic-rescan')).toMatchObject({ requeuedJobs: 0 });
      expect(stateOf('a.md')).toBe('fresh');

      const first = await service.refreshProject(project.id, 'periodic-rescan');
      expect(first.requeuedJobs).toBe(1);
      expect(harness.queue.listRequeueEvents(job.id).map((event) => event.reason)).toEqual(['coverage_adapter_available']);

      harness.queue.claim(project.id, 'worker-test');
      harness.queue.complete(job.id, 'worker-test', {
        resultKind: 'coverage_only',
        processingMode: 'deterministic',
        coverageStatus: 'unsupported',
        unsupportedReason: 'no_analyzer',
        analyzerId: null,
        analyzerVersion: null,
        extractionId: null,
        warnings: [],
      });
      expect((await service.refreshProject(project.id, 'periodic-rescan')).requeuedJobs).toBe(0);
    });

    it('requeues a legacy failed unsupported_source job on manual refresh and the worker completes it as coverage_only', async () => {
      harness.writeFile(project.workspaceRoot, 'data.xyz', 'opaque');
      await service.refreshProject(project.id, 'startup');
      const job = jobFor('data.xyz');
      harness.queue.claim(project.id, 'worker-legacy');
      harness.queue.claim(project.id, 'worker-legacy');
      harness.queue.fail(job.id, 'unsupported_source', 'legacy failure', 'worker-legacy');
      harness.queue.cancel(jobFor('a.md').id);
      expect(harness.queue.get(job.id)).toMatchObject({ status: 'failed', failureCode: 'unsupported_source' });

      const manual = await new KnowledgeFreshnessService(harness.db, { now: () => clock, queue: harness.queue, analyzers: registryOf(null) }).refreshProject(project.id, 'manual');
      expect(manual.requeuedJobs).toBe(2);

      const worker = new KnowledgeWorker(harness.db, { workerId: 'worker-new', now: () => clock }, { analyzers: registryOf(null) });
      const run = await worker.runOnce(project.id);
      expect(run).toMatchObject({ completed: 2, failed: 0 });
      expect(harness.queue.get(job.id)?.result).toMatchObject({ resultKind: 'coverage_only' });
      expect(harness.queue.listRequeueEvents(job.id)[0]).toMatchObject({ previousStatus: 'failed', previousFailureCode: 'unsupported_source' });
      expect(analyzeJobs()).toHaveLength(2);
    });

    it('records a content revert to an older version as a failed source instead of rewriting history', async () => {
      harness.writeFile(project.workspaceRoot, 'a.md', 'two');
      await service.refreshProject(project.id, 'watch-event');
      harness.writeFile(project.workspaceRoot, 'a.md', 'one');

      const result = await service.refreshProject(project.id, 'watch-event');

      expect(result).toMatchObject({ failedSources: 1, newVersions: 0 });
      expect(freshnessRows()[0]).toMatchObject({ freshness_state: 'failed', last_error_code: 'source_version_reverted' });
      expect(count('knowledge_source_versions')).toBe(2);
    });
  });

  describe('failure handling', () => {
    class ThrowingQueue extends KnowledgeQueue {
      public failAfter = 1;
      public override enqueue(input: Parameters<KnowledgeQueue['enqueue']>[0]) {
        if (this.failAfter-- <= 0) throw new Error('enqueue exploded');
        return super.enqueue(input);
      }
    }

    it('rolls the whole refresh back when a job cannot be enqueued and records a bounded watcher error', async () => {
      harness.writeFile(project.workspaceRoot, 'a.md', 'one');
      harness.writeFile(project.workspaceRoot, 'b.md', 'two');
      const failing = new KnowledgeFreshnessService(harness.db, {
        now: () => clock,
        queue: new ThrowingQueue(harness.db, { now: () => clock }),
        analyzers: registryOf(analyzerStub('markdown', '1.0.0')),
      });

      await expect(failing.refreshProject(project.id, 'startup')).rejects.toThrow(/enqueue exploded/);

      expect(count('knowledge_sources')).toBe(0);
      expect(count('knowledge_jobs')).toBe(0);
      expect(count('knowledge_source_freshness')).toBe(0);
      expect(failing.getStatus(project.id)).toMatchObject({ lastErrorCode: 'refresh_failed', lastErrorMessage: expect.stringContaining('enqueue exploded') });
    });

    it('preserves prior freshness and records a scan error when a root disappears', async () => {
      const scoped = harness.createProject('project_roots', { roots: ['docs'] });
      harness.writeFile(scoped.workspaceRoot, 'docs/a.md', 'one');
      await service.refreshProject(scoped.id, 'startup');
      rmSync(join(scoped.workspaceRoot, 'docs'), { recursive: true });

      await expect(service.refreshProject(scoped.id, 'watch-event')).rejects.toThrow();

      expect(stateOf('docs/a.md', scoped.id)).toBe('pending');
      const status = service.getStatus(scoped.id);
      expect(status.lastErrorCode).toBe('scan_failed');
      expect(status.lastErrorMessage).not.toContain(scoped.workspaceRoot);
    });

    it('rejects an unknown project', async () => {
      await expect(service.refreshProject('project_unknown', 'manual')).rejects.toThrow(/not found/i);
    });
  });

  describe('project isolation', () => {
    it('never mutates another project’s sources, jobs, freshness, or watcher rows', async () => {
      const other = harness.createProject('project_b');
      harness.writeFile(project.workspaceRoot, 'a.md', 'one');
      harness.writeFile(other.workspaceRoot, 'a.md', 'one');
      await service.refreshProject(other.id, 'startup');
      const otherJob = jobFor('a.md', other.id);
      harness.queue.claim(other.id, 'worker-b');
      harness.queue.fail(otherJob.id, 'analyzer_failed', 'boom', 'worker-b');
      const snapshot = JSON.stringify([
        harness.db.prepare('SELECT * FROM knowledge_sources WHERE project_id = ?').all(other.id),
        harness.db.prepare('SELECT * FROM knowledge_jobs WHERE project_id = ?').all(other.id),
        harness.db.prepare('SELECT * FROM knowledge_source_freshness WHERE project_id = ?').all(other.id),
        harness.db.prepare('SELECT * FROM knowledge_project_watchers WHERE project_id = ?').all(other.id),
      ]);

      await service.refreshProject(project.id, 'manual');
      harness.writeFile(project.workspaceRoot, 'a.md', 'changed');
      rmSync(join(other.workspaceRoot, 'a.md'));
      await service.refreshProject(project.id, 'manual');

      expect(JSON.stringify([
        harness.db.prepare('SELECT * FROM knowledge_sources WHERE project_id = ?').all(other.id),
        harness.db.prepare('SELECT * FROM knowledge_jobs WHERE project_id = ?').all(other.id),
        harness.db.prepare('SELECT * FROM knowledge_source_freshness WHERE project_id = ?').all(other.id),
        harness.db.prepare('SELECT * FROM knowledge_project_watchers WHERE project_id = ?').all(other.id),
      ])).toBe(snapshot);
      expect(harness.queue.get(otherJob.id)?.status).toBe('failed');
      expect(stateOf('a.md', other.id)).toBe('pending');
    });
  });

  it('records watcher scan timestamps for a successful refresh', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'one');
    await service.refreshProject(project.id, 'manual');
    expect(service.getStatus(project.id)).toMatchObject({
      lastScanAt: clock,
      lastSuccessfulScanAt: clock,
      lastErrorCode: null,
      generation: 0,
    });
  });
});
