import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { KnowledgeQueue } from '../../src/knowledge/KnowledgeQueue.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';

describe('KnowledgeQueue', () => {
  let db: Database.Database;
  let queue: KnowledgeQueue;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    const insertProject = db.prepare(
      `INSERT INTO knowledge_projects
       (id, workspace_root, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    );
    const createdAt = new Date().toISOString();
    insertProject.run('project_1', '/workspace/a', 'Test A', createdAt, createdAt);
    insertProject.run('project_2', '/workspace/b', 'Test B', createdAt, createdAt);
    queue = new KnowledgeQueue(db, { leaseDurationMs: 1_000, now: () => '2026-01-01T00:00:00.000Z' });
  });

  it('persists enqueue, claim, completion, and progress events', () => {
    const job = queue.enqueue({
      projectId: 'project_1',
      jobKind: 'extract',
      payload: { source: 'source_1' },
    });

    expect(job.status).toBe('queued');
    expect(queue.claim('project_1', 'worker-a')).toMatchObject({
      id: job.id,
      projectId: 'project_1',
      status: 'running',
      workerId: 'worker-a',
      leaseExpiresAt: '2026-01-01T00:00:01.000Z',
    });

    queue.recordProgress(job.id, 'extracting', 2, 5, { file: 'readme.md' });
    expect(queue.listProgress(job.id)).toMatchObject([
      expect.objectContaining({
        jobId: job.id,
        stage: 'extracting',
        completedUnits: 2,
        totalUnits: 5,
        detail: { file: 'readme.md' },
      }),
    ]);

    const completed = queue.complete(job.id, 'worker-a', {
      processingMode: 'deterministic',
      analyzerId: 'python-detector',
      analyzerVersion: '1.0.0',
      extractionId: 'extraction_1',
      pageVersionIds: ['page-version_1'],
      graphNodeCount: 4,
      graphEdgeCount: 2,
      warnings: [{ code: 'provider_warning', message: 'token=secret-value should be redacted' }],
    });

    expect(completed).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({
        processingMode: 'deterministic',
        warnings: [{ code: 'provider_warning', message: expect.stringContaining('***') }],
      }),
    });
    const persisted = db.prepare('SELECT result_json FROM knowledge_jobs WHERE id = ?').get(job.id) as { result_json: string };
    expect(persisted.result_json).toContain('"processingMode":"deterministic"');
    expect(persisted.result_json).not.toContain('secret-value');
  });

  it('rejects invalid transitions and enforces worker ownership', () => {
    const job = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });

    expect(() => queue.complete(job.id, 'worker-a')).toThrow(/running/i);
    queue.claim('project_1', 'worker-a');
    expect(() => queue.complete(job.id, 'worker-b')).toThrow(/worker/i);
    expect(() => queue.cancel(job.id)).not.toThrow();
    expect(queue.get(job.id)?.status).toBe('cancelled');
    expect(() => queue.retry(job.id)).toThrow(/cancelled/i);
  });

  it('retries failed jobs up to the configured limit', () => {
    const job = queue.enqueue({
      projectId: 'project_1',
      jobKind: 'build',
      payload: {},
      maxRetries: 1,
    });
    queue.claim('project_1', 'worker-a');
    expect(queue.fail(job.id, 'provider_error', 'temporary failure', 'worker-a').status).toBe('failed');
    expect(queue.retry(job.id).status).toBe('queued');
    queue.claim('project_1', 'worker-b');
    expect(queue.fail(job.id, 'provider_error', 'permanent failure', 'worker-b').status).toBe('failed');
    expect(() => queue.retry(job.id)).toThrow(/retry/i);
  });

  it('claims jobs within a project, renews leases for the owning worker, and reports project-scoped status', () => {
    const projectAJob = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    queue.setNow(() => '2026-01-01T00:00:01.000Z');
    const projectBRunningJob = queue.enqueue({ projectId: 'project_2', jobKind: 'analyze', payload: { file: 'b.md' } });
    queue.setNow(() => '2026-01-01T00:00:01.500Z');
    const projectBFailedJob = queue.enqueue({ projectId: 'project_2', jobKind: 'extract', payload: { file: 'c.md' } });

    expect(queue.claim('project_2', 'worker-b')).toMatchObject({
      id: projectBRunningJob.id,
      projectId: 'project_2',
      workerId: 'worker-b',
    });
    expect(queue.list('project_1')[0].status).toBe('queued');

    expect(queue.claim('project_2', 'worker-c')?.id).toBe(projectBFailedJob.id);
    expect(queue.fail(projectBFailedJob.id, 'provider_error', 'temporary failure', 'worker-c').status).toBe('failed');

    expect(queue.getQueueStatus('project_2')).toMatchObject({
      projectId: 'project_2',
      queuedCount: 0,
      runningCount: 1,
      failedCount: 1,
      completedCount: 0,
      cancelledCount: 0,
      oldestQueuedAgeMs: null,
    });

    queue.setNow(() => '2026-01-01T00:00:02.000Z');
    const renewed = queue.renewLease(projectBRunningJob.id, 'worker-b');
    expect(renewed.leaseExpiresAt).toBe('2026-01-01T00:00:03.000Z');
    expect(() => queue.renewLease(projectBRunningJob.id, 'worker-c')).toThrow(/worker/i);

    expect(queue.getQueueStatus('project_1')).toMatchObject({
      projectId: 'project_1',
      queuedCount: 1,
      runningCount: 0,
      failedCount: 0,
      completedCount: 0,
      cancelledCount: 0,
      oldestQueuedAgeMs: 2_000,
    });
    expect(projectAJob.status).toBe('queued');
  });

  it('recovers expired leases within the requested project and does not allow a second worker to claim a running job', () => {
    const project1Job = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    queue.setNow(() => '2026-01-01T00:00:00.500Z');
    const project2Job = queue.enqueue({ projectId: 'project_2', jobKind: 'build', payload: {} });

    expect(queue.claim('project_1', 'worker-a')?.workerId).toBe('worker-a');
    expect(queue.claim('project_1', 'worker-b')).toBeNull();

    queue.setNow(() => '2026-01-01T00:00:02.000Z');
    expect(queue.recoverExpiredKnowledgeJobs('project_2')).toEqual([]);
    expect(queue.get(project2Job.id)?.status).toBe('queued');
    expect(queue.recoverExpiredKnowledgeJobs('project_1')).toEqual([project1Job.id]);
    expect(queue.claim('project_1', 'worker-b')?.workerId).toBe('worker-b');
  });

  it('suppresses duplicate jobs for the same source version', () => {
    const input = {
      projectId: 'project_1',
      jobKind: 'extract',
      sourceVersionId: 'source-version_1',
      payload: { sourceVersionId: 'source-version_1' },
    };
    const first = queue.enqueue(input);
    const second = queue.enqueue(input);

    expect(second.id).toBe(first.id);
    expect(queue.list('project_1')).toHaveLength(1);
  });

  it('supports cancellation of queued jobs and reports recovery failures at the retry limit', () => {
    const queued = queue.enqueue({ projectId: 'project_1', jobKind: 'queued', payload: {} });
    expect(queue.cancel(queued.id).status).toBe('cancelled');

    const leased = queue.enqueue({
      projectId: 'project_1',
      jobKind: 'leased',
      payload: {},
      maxRetries: 0,
    });
    queue.claim('project_1', 'worker-a');
    queue.setNow(() => '2026-01-01T00:00:02.000Z');
    expect(queue.recoverExpiredKnowledgeJobs('project_1')).toEqual([]);
    expect(queue.get(leased.id)).toMatchObject({
      status: 'failed',
      failureCode: 'lease_expired',
    });
  });
});
