import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { KnowledgeQueue, type KnowledgeJobRecord } from '../../src/knowledge/KnowledgeQueue.js';

const ANALYZED = {
  processingMode: 'deterministic' as const,
  analyzerId: 'python-detector',
  analyzerVersion: '1.0.0',
  extractionId: 'extraction_1',
  pageVersionIds: ['page-version_1'],
  graphNodeCount: 2,
  graphEdgeCount: 1,
  warnings: [],
};

describe('KnowledgeQueue.requeueAnalyze', () => {
  let db: Database.Database;
  let queue: KnowledgeQueue;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const insertProject = db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'now', 'now')`,
    );
    insertProject.run('project_1', '/workspace/a', 'A');
    insertProject.run('project_2', '/workspace/b', 'B');
    queue = new KnowledgeQueue(db, { leaseDurationMs: 1_000, now: () => '2026-01-01T00:00:00.000Z' });
  });

  afterEach(() => db.close());

  function analyzeJob(projectId = 'project_1', sourceVersionId = 'version_1'): KnowledgeJobRecord {
    return queue.enqueue({ projectId, jobKind: 'analyze', sourceVersionId, payload: { sourceVersionId } });
  }

  function complete(job: KnowledgeJobRecord): KnowledgeJobRecord {
    queue.claim(job.projectId, 'worker-a');
    return queue.complete(job.id, 'worker-a', ANALYZED);
  }

  function fail(job: KnowledgeJobRecord, code = 'analyzer_failed'): KnowledgeJobRecord {
    queue.claim(job.projectId, 'worker-a');
    return queue.fail(job.id, code, 'boom', 'worker-a');
  }

  it('requeues a completed job on the same row, clears the outcome, and audits the previous result', () => {
    const completed = complete(analyzeJob());
    expect(completed.status).toBe('completed');

    const requeued = queue.requeueAnalyze(completed.id, 'analyzer_upgraded');

    expect(requeued).toMatchObject({
      id: completed.id,
      status: 'queued',
      startedAt: null,
      completedAt: null,
      failureCode: null,
      failureMessage: null,
      result: null,
      resultSchemaVersion: null,
      retryCount: 0,
      workerId: null,
      leaseExpiresAt: null,
    });
    expect(db.prepare('SELECT result_json, result_processing_mode FROM knowledge_jobs WHERE id = ?').get(completed.id)).toEqual({
      result_json: null,
      result_processing_mode: null,
    });
    const events = db.prepare(`SELECT event_kind, detail_json FROM knowledge_job_events WHERE job_id = ? AND event_kind = 'requeued'`).all(completed.id) as Array<{ event_kind: string; detail_json: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].detail_json)).toMatchObject({
      reason: 'analyzer_upgraded',
      previousStatus: 'completed',
      previousResultSchemaVersion: 1,
    });
    expect(queue.listProgress(completed.id)).toEqual([]);
  });

  it('keeps the unique job identity: enqueue after requeue returns the same queued row', () => {
    const completed = complete(analyzeJob());
    queue.requeueAnalyze(completed.id, 'manual');

    const again = analyzeJob();

    expect(again.id).toBe(completed.id);
    expect(again.status).toBe('queued');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_jobs WHERE job_kind = 'analyze'`).get()).toEqual({ count: 1 });
  });

  it('requeues a failed job past its retry limit and resets retry_count so it is claimable again', () => {
    const job = queue.enqueue({ projectId: 'project_1', jobKind: 'analyze', sourceVersionId: 'version_1', payload: {}, maxRetries: 0 });
    const failed = fail(job, 'unsupported_source');
    expect(failed.retryCount).toBe(1);
    expect(() => queue.retry(failed.id)).toThrow(/retry limit/i);

    const requeued = queue.requeueAnalyze(failed.id, 'manual');

    expect(requeued).toMatchObject({ status: 'queued', retryCount: 0, failureCode: null });
    expect(queue.claim('project_1', 'worker-b')).toMatchObject({ id: failed.id, status: 'running' });
    const event = db.prepare(`SELECT detail_json FROM knowledge_job_events WHERE job_id = ? AND event_kind = 'requeued'`).get(failed.id) as { detail_json: string };
    expect(JSON.parse(event.detail_json)).toMatchObject({ previousStatus: 'failed', previousFailureCode: 'unsupported_source', previousRetryCount: 1 });
  });

  it('requeues cancelled jobs', () => {
    const job = analyzeJob();
    queue.cancel(job.id);
    expect(queue.requeueAnalyze(job.id, 'cancelled_recovery')).toMatchObject({ status: 'queued', completedAt: null });
  });

  it('returns null and changes nothing for queued, running, leased, unknown, and non-analyze jobs', () => {
    const first = analyzeJob('project_1', 'version_q');
    const second = analyzeJob('project_1', 'version_r');
    expect(queue.requeueAnalyze(first.id, 'manual')).toBeNull();
    expect(queue.requeueAnalyze(second.id, 'manual')).toBeNull();

    const claimed = queue.claim('project_1', 'worker-a');
    const running = claimed as NonNullable<typeof claimed>;
    const queued = running.id === first.id ? second : first;
    expect(queue.requeueAnalyze(queued.id, 'manual')).toBeNull();
    expect(queue.requeueAnalyze(running.id, 'analyzer_upgraded')).toBeNull();
    expect(queue.get(running.id)).toMatchObject({ status: 'running', workerId: 'worker-a' });

    expect(queue.requeueAnalyze('job_missing', 'manual')).toBeNull();

    const other = queue.enqueue({ projectId: 'project_1', jobKind: 'summarize', sourceVersionId: 'version_s', payload: {} });
    queue.cancel(other.id);
    expect(queue.requeueAnalyze(other.id, 'cancelled_recovery')).toBeNull();

    expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_job_events WHERE event_kind = 'requeued'`).get()).toEqual({ count: 0 });
  });

  it('refuses a terminal row that still carries a worker or lease', () => {
    const completed = complete(analyzeJob());
    db.prepare(`UPDATE knowledge_jobs SET lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(completed.id);
    expect(queue.requeueAnalyze(completed.id, 'manual')).toBeNull();
    db.prepare(`UPDATE knowledge_jobs SET lease_expires_at = NULL, worker_id = 'ghost' WHERE id = ?`).run(completed.id);
    expect(queue.requeueAnalyze(completed.id, 'manual')).toBeNull();
    expect(queue.get(completed.id)?.status).toBe('completed');
  });

  it('never lets a slot from the earlier run complete, fail, cancel, or renew the requeued row', () => {
    const job = analyzeJob();
    queue.claim('project_1', 'worker-a');
    queue.complete(job.id, 'worker-a', ANALYZED);
    queue.requeueAnalyze(job.id, 'manual');

    expect(() => queue.complete(job.id, 'worker-a', ANALYZED)).toThrow(/lease/i);
    expect(() => queue.fail(job.id, 'x', 'y', 'worker-a')).toThrow(/lease/i);
    expect(() => queue.cancelOwned(job.id, 'worker-a')).toThrow(/lease/i);
    expect(() => queue.renewLease(job.id, 'worker-a')).toThrow(/lease/i);
    expect(queue.get(job.id)?.status).toBe('queued');
  });

  it('only requeues within the job project and rejects unknown reasons', () => {
    const other = complete(analyzeJob('project_2', 'version_2'));
    expect(queue.requeueAnalyze(other.id, 'manual')).toMatchObject({ projectId: 'project_2', status: 'queued' });
    const completed = complete(analyzeJob());
    expect(() => queue.requeueAnalyze(completed.id, 'because' as never)).toThrow(/requeue reason/i);
    expect(queue.get(completed.id)?.status).toBe('completed');
  });

  it('lists requeue audit events with bounded target analyzer context', () => {
    const completed = complete(analyzeJob());
    queue.requeueAnalyze(completed.id, 'analyzer_upgraded', { analyzerId: 'python-detector', analyzerVersion: '2.0.0' });

    expect(queue.listRequeueEvents(completed.id)).toEqual([
      expect.objectContaining({
        jobId: completed.id,
        reason: 'analyzer_upgraded',
        previousStatus: 'completed',
        targetAnalyzer: 'python-detector@2.0.0',
      }),
    ]);
  });
});
