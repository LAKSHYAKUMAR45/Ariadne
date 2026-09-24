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
    db.prepare(
      `INSERT INTO knowledge_projects
       (id, workspace_root, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run('project_1', '/workspace', 'Test', new Date().toISOString(), new Date().toISOString());
    queue = new KnowledgeQueue(db, { leaseDurationMs: 1_000, now: () => '2026-01-01T00:00:00.000Z' });
  });

  it('persists enqueue, claim, completion, and progress events', () => {
    const job = queue.enqueue({
      projectId: 'project_1',
      jobKind: 'extract',
      payload: { source: 'source_1' },
    });

    expect(job.status).toBe('queued');
    expect(queue.claim('worker-a')).toMatchObject({
      id: job.id,
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

    expect(queue.complete(job.id, 'worker-a').status).toBe('completed');
  });

  it('rejects invalid transitions and enforces worker ownership', () => {
    const job = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });

    expect(() => queue.complete(job.id, 'worker-a')).toThrow(/running/i);
    queue.claim('worker-a');
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
    queue.claim('worker-a');
    expect(queue.fail(job.id, 'provider_error', 'temporary failure', 'worker-a').status).toBe('failed');
    expect(queue.retry(job.id).status).toBe('queued');
    queue.claim('worker-b');
    expect(queue.fail(job.id, 'provider_error', 'permanent failure', 'worker-b').status).toBe('failed');
    expect(() => queue.retry(job.id)).toThrow(/retry/i);
  });

  it('recovers expired leases and does not allow a second worker to claim a running job', () => {
    const job = queue.enqueue({ projectId: 'project_1', jobKind: 'build', payload: {} });
    expect(queue.claim('worker-a')?.workerId).toBe('worker-a');
    expect(queue.claim('worker-b')).toBeNull();

    queue.setNow(() => '2026-01-01T00:00:02.000Z');
    expect(queue.recoverExpiredKnowledgeJobs()).toEqual([job.id]);
    expect(queue.claim('worker-b')?.workerId).toBe('worker-b');
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
    queue.claim('worker-a');
    queue.setNow(() => '2026-01-01T00:00:02.000Z');
    expect(queue.recoverExpiredKnowledgeJobs()).toEqual([]);
    expect(queue.get(leased.id)).toMatchObject({
      status: 'failed',
      failureCode: 'lease_expired',
    });
  });
});
