import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { KnowledgeQueue, KnowledgeQueueTransitionError } from '../../src/knowledge/KnowledgeQueue.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';

describe('KnowledgeQueue', () => {
  let db: Database.Database;
  let queue: KnowledgeQueue;
  const temporaryDirectories: string[] = [];

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

  afterEach(() => {
    db.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
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
    const persisted = db.prepare(
      'SELECT result_json, result_processing_mode FROM knowledge_jobs WHERE id = ?',
    ).get(job.id) as { result_json: string; result_processing_mode: string };
    expect(persisted.result_json).toContain('"processingMode":"deterministic"');
    expect(persisted.result_processing_mode).toBe('deterministic');
    expect(persisted.result_json).not.toContain('secret-value');
  });

  it('persists unknown completion mode when a job completes without result metadata', () => {
    const job = queue.enqueue({
      projectId: 'project_1',
      jobKind: 'extract',
      payload: { source: 'source_2' },
    });

    expect(queue.claim('project_1', 'worker-a')).toMatchObject({
      id: job.id,
      status: 'running',
      workerId: 'worker-a',
    });

    const completed = queue.complete(job.id, 'worker-a');
    expect(completed).toMatchObject({
      id: job.id,
      status: 'completed',
      result: null,
    });

    const persisted = db.prepare(
      'SELECT result_json, result_processing_mode FROM knowledge_jobs WHERE id = ?',
    ).get(job.id) as { result_json: string | null; result_processing_mode: string | null };
    expect(persisted.result_json).toBeNull();
    expect(persisted.result_processing_mode).toBe('unknown');
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

  it('rejects lease renewal after expiry and when another connection changes ownership first', () => {
    const expiredJob = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    expect(queue.claim('project_1', 'worker-a')?.id).toBe(expiredJob.id);

    queue.setNow(() => '2026-01-01T00:00:02.000Z');
    expect(() => queue.renewLease(expiredJob.id, 'worker-a')).toThrow(KnowledgeQueueTransitionError);
    expect(queue.get(expiredJob.id)).toMatchObject({
      id: expiredJob.id,
      status: 'running',
      workerId: 'worker-a',
      leaseExpiresAt: '2026-01-01T00:00:01.000Z',
    });

    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-queue-renew-'));
    temporaryDirectories.push(workspaceRoot);
    const databasePath = join(workspaceRoot, '.ariadne', 'queue.db');
    const primary = openDatabase(databasePath);
    const secondary = openDatabase(databasePath);
    const createdAt = '2026-01-01T00:00:00.000Z';
    primary.prepare(
      `INSERT INTO knowledge_projects
       (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_1', ?, 'Test A', 'active', ?, ?)`,
    ).run(workspaceRoot, createdAt, createdAt);
    const job = new KnowledgeQueue(primary, { leaseDurationMs: 1_000, now: () => createdAt }).enqueue({
      projectId: 'project_1',
      jobKind: 'build',
      payload: {},
    });
    expect(new KnowledgeQueue(primary, { leaseDurationMs: 1_000, now: () => createdAt }).claim('project_1', 'worker-a')?.id).toBe(
      job.id,
    );

    secondary
      .prepare(
        `UPDATE knowledge_jobs
         SET worker_id = 'worker-b', lease_expires_at = ?
         WHERE id = ?`,
      )
      .run('2026-01-01T00:00:01.500Z', job.id);
    const racingQueue = new KnowledgeQueue(primary, { leaseDurationMs: 1_000, now: () => '2026-01-01T00:00:00.500Z' });

    expect(() => racingQueue.renewLease(job.id, 'worker-a')).toThrow(KnowledgeQueueTransitionError);
    expect(new KnowledgeQueue(secondary, { leaseDurationMs: 1_000, now: () => createdAt }).get(job.id)).toMatchObject({
      id: job.id,
      status: 'running',
      workerId: 'worker-b',
      leaseExpiresAt: '2026-01-01T00:00:01.500Z',
    });

    primary.close();
    secondary.close();
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

  it('does not modify or report a recovered job when its lease is renewed after selection', () => {
    const job = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    expect(queue.claim('project_1', 'worker-a')?.workerId).toBe('worker-a');

    queue = new KnowledgeQueue(db, {
      leaseDurationMs: 1_000,
      now: () => '2026-01-01T00:00:02.000Z',
      onRecoverExpiredCandidate: (candidate) => {
        if (candidate.id === job.id) {
          db.prepare(
            `UPDATE knowledge_jobs
             SET lease_expires_at = ?
             WHERE id = ?`,
          ).run('2026-01-01T00:00:03.000Z', job.id);
        }
      },
    });

    expect(queue.recoverExpiredKnowledgeJobs('project_1')).toEqual([]);
    expect(queue.get(job.id)).toMatchObject({
      id: job.id,
      projectId: 'project_1',
      status: 'running',
      workerId: 'worker-a',
      retryCount: 0,
      failureCode: null,
      failureMessage: null,
      leaseExpiresAt: '2026-01-01T00:00:03.000Z',
    });
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

  it('rejects manual cancellation for expired running leases until recovery accounts for lease expiry', () => {
    const job = queue.enqueue({
      projectId: 'project_1',
      jobKind: 'leased',
      payload: {},
      maxRetries: 2,
    });
    expect(queue.claim('project_1', 'worker-a')?.id).toBe(job.id);

    queue.setNow(() => '2026-01-01T00:00:02.000Z');

    expect(() => queue.cancel(job.id)).toThrow(/lease/i);
    expect(queue.get(job.id)).toMatchObject({
      id: job.id,
      status: 'running',
      retryCount: 0,
      failureCode: null,
      workerId: 'worker-a',
      leaseExpiresAt: '2026-01-01T00:00:01.000Z',
    });

    expect(queue.recoverExpiredKnowledgeJobs('project_1')).toEqual([job.id]);
    expect(queue.get(job.id)).toMatchObject({
      id: job.id,
      status: 'queued',
      retryCount: 1,
      failureCode: null,
      failureMessage: null,
      workerId: null,
      leaseExpiresAt: null,
    });
  });

  it('rejects cancel and retry races instead of overwriting concurrent owner or claim changes', () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-queue-race-'));
    temporaryDirectories.push(workspaceRoot);
    const databasePath = join(workspaceRoot, '.ariadne', 'queue.db');
    const primary = openDatabase(databasePath);
    const secondary = openDatabase(databasePath);
    const createdAt = '2026-01-01T00:00:00.000Z';
    primary.prepare(
      `INSERT INTO knowledge_projects
       (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_1', ?, 'Test A', 'active', ?, ?)`,
    ).run(workspaceRoot, createdAt, createdAt);

    const setupQueue = new KnowledgeQueue(primary, { leaseDurationMs: 1_000, now: () => createdAt });
    const runningJob = setupQueue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    expect(setupQueue.claim('project_1', 'worker-a')?.id).toBe(runningJob.id);

    let cancelRaced = false;
    const cancelQueue = new (class extends KnowledgeQueue {
      public override get(jobId: string) {
        const current = super.get(jobId);
        if (!cancelRaced && current?.id === runningJob.id) {
          cancelRaced = true;
          secondary
            .prepare(
              `UPDATE knowledge_jobs
               SET worker_id = 'worker-b', lease_expires_at = ?
               WHERE id = ?`,
            )
            .run('2026-01-01T00:00:01.500Z', runningJob.id);
        }
        return current;
      }
    })(primary, { leaseDurationMs: 1_000, now: () => '2026-01-01T00:00:00.500Z' });

    expect(() => cancelQueue.cancel(runningJob.id)).toThrow(KnowledgeQueueTransitionError);
    expect(new KnowledgeQueue(secondary, { leaseDurationMs: 1_000, now: () => createdAt }).get(runningJob.id)).toMatchObject({
      id: runningJob.id,
      status: 'running',
      workerId: 'worker-b',
      leaseExpiresAt: '2026-01-01T00:00:01.500Z',
    });

    const recoveryJob = setupQueue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    expect(setupQueue.claim('project_1', 'worker-e')?.id).toBe(recoveryJob.id);

    let recoveryRaced = false;
    const recoveryCancelQueue = new (class extends KnowledgeQueue {
      public override get(jobId: string) {
        const current = super.get(jobId);
        if (!recoveryRaced && current?.id === recoveryJob.id) {
          recoveryRaced = true;
          secondary
            .prepare(
              `UPDATE knowledge_jobs
               SET status = 'queued', worker_id = NULL, lease_expires_at = NULL
               WHERE id = ?`,
            )
            .run(recoveryJob.id);
        }
        return current;
      }
    })(primary, { leaseDurationMs: 1_000, now: () => '2026-01-01T00:00:00.625Z' });

    expect(() => recoveryCancelQueue.cancel(recoveryJob.id)).toThrow(KnowledgeQueueTransitionError);
    expect(new KnowledgeQueue(secondary, { leaseDurationMs: 1_000, now: () => createdAt }).get(recoveryJob.id)).toMatchObject({
      id: recoveryJob.id,
      status: 'queued',
      workerId: null,
      leaseExpiresAt: null,
    });
    expect(setupQueue.cancel(recoveryJob.id).status).toBe('cancelled');

    const failedJob = setupQueue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {}, maxRetries: 2 });
    expect(setupQueue.claim('project_1', 'worker-c')?.id).toBe(failedJob.id);
    expect(setupQueue.fail(failedJob.id, 'provider_error', 'temporary failure', 'worker-c').status).toBe('failed');

    let retryRaced = false;
    const retryQueue = new (class extends KnowledgeQueue {
      public override get(jobId: string) {
        const current = super.get(jobId);
        if (!retryRaced && current?.id === failedJob.id) {
          retryRaced = true;
          secondary
            .prepare(
              `UPDATE knowledge_jobs
               SET status = 'running', completed_at = NULL, failure_code = NULL, failure_message = NULL,
                   worker_id = 'worker-d', lease_expires_at = ?
               WHERE id = ?`,
            )
            .run('2026-01-01T00:00:01.750Z', failedJob.id);
        }
        return current;
      }
    })(primary, { leaseDurationMs: 1_000, now: () => '2026-01-01T00:00:00.750Z' });

    expect(() => retryQueue.retry(failedJob.id)).toThrow(KnowledgeQueueTransitionError);
    expect(new KnowledgeQueue(secondary, { leaseDurationMs: 1_000, now: () => createdAt }).get(failedJob.id)).toMatchObject({
      id: failedJob.id,
      status: 'running',
      workerId: 'worker-d',
      leaseExpiresAt: '2026-01-01T00:00:01.750Z',
    });

    primary.close();
    secondary.close();
  });

  it('rejects worker terminal transitions once the running lease has expired', () => {
    const completionJob = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    const failureJob = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    const cancellationJob = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    const claimedIds = new Set([
      queue.claim('project_1', 'worker-a')?.id,
      queue.claim('project_1', 'worker-a')?.id,
      queue.claim('project_1', 'worker-a')?.id,
    ]);
    expect(claimedIds).toEqual(new Set([completionJob.id, failureJob.id, cancellationJob.id]));

    queue.setNow(() => '2026-01-01T00:00:02.000Z');

    expect(() =>
      queue.complete(completionJob.id, 'worker-a', {
        processingMode: 'deterministic',
        analyzerId: 'python-detector',
        analyzerVersion: '1.0.0',
        extractionId: 'extraction_1',
        pageVersionIds: ['page-version_1'],
        graphNodeCount: 1,
        graphEdgeCount: 0,
        warnings: [],
      }),
    ).toThrow(/lease/i);
    expect(() => queue.fail(failureJob.id, 'provider_error', 'temporary failure', 'worker-a')).toThrow(/lease/i);
    expect(() => queue.cancelOwned(cancellationJob.id, 'worker-a')).toThrow(/lease/i);

    expect(queue.get(completionJob.id)?.status).toBe('running');
    expect(queue.get(failureJob.id)?.status).toBe('running');
    expect(queue.get(cancellationJob.id)?.status).toBe('running');
  });
});
