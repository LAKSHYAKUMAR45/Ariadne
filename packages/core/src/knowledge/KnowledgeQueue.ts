import type Database from 'better-sqlite3';
import { createKnowledgeId } from './KnowledgeIds.js';
import type { KnowledgeJobId, KnowledgeJobStatus } from './KnowledgeTypes.js';

export interface EnqueueKnowledgeJobInput {
  projectId: string;
  jobKind: string;
  payload: Record<string, unknown>;
  sourceVersionId?: string;
  maxRetries?: number;
}

export interface KnowledgeJobRecord {
  id: KnowledgeJobId;
  projectId: string;
  jobKind: string;
  sourceVersionId: string | null;
  status: KnowledgeJobStatus;
  payload: Record<string, unknown>;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  retryCount: number;
  maxRetries: number;
  workerId: string | null;
  leaseExpiresAt: string | null;
}

export interface KnowledgeProgressEvent {
  id: string;
  projectId: string;
  jobId: KnowledgeJobId;
  stage: string;
  completedUnits: number;
  totalUnits: number;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface KnowledgeQueueOptions {
  leaseDurationMs?: number;
  now?: () => string;
}

interface JobRow {
  id: string;
  project_id: string;
  job_kind: string;
  source_version_id: string | null;
  status: KnowledgeJobStatus;
  payload_json: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  retry_count: number;
  max_retries: number;
  worker_id: string | null;
  lease_expires_at: string | null;
}

interface ProgressRow {
  id: string;
  project_id: string;
  job_id: string;
  event_kind: string;
  detail_json: string;
  created_at: string;
}

const DEFAULT_LEASE_DURATION_MS = 60_000;

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Knowledge queue payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function rowToJob(row: JobRow): KnowledgeJobRecord {
  return {
    id: row.id as KnowledgeJobId,
    projectId: row.project_id,
    jobKind: row.job_kind,
    sourceVersionId: row.source_version_id,
    status: row.status,
    payload: parseObject(row.payload_json),
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function getErrorMessage(code: string, id: string): Error {
  return new Error(`${code}: ${id}`);
}

export class KnowledgeQueue {
  private readonly leaseDurationMs: number;
  private now: () => string;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeQueueOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public setNow(now: () => string): void {
    this.now = now;
  }

  public enqueue(input: EnqueueKnowledgeJobInput): KnowledgeJobRecord {
    if (!input.jobKind.trim()) throw new Error('Knowledge job kind must not be empty');
    if (input.maxRetries !== undefined && (!Number.isInteger(input.maxRetries) || input.maxRetries < 0)) {
      throw new Error('Knowledge job maxRetries must be a non-negative integer');
    }
    return this.db.transaction(() => {
      const existing = input.sourceVersionId
        ? (this.db
            .prepare(
              `SELECT * FROM knowledge_jobs
               WHERE project_id = ? AND job_kind = ? AND source_version_id = ?`,
            )
            .get(input.projectId, input.jobKind, input.sourceVersionId) as JobRow | undefined)
        : undefined;
      if (existing) return rowToJob(existing);

      const now = this.now();
      const id = createKnowledgeId('job');
      this.db
        .prepare(
          `INSERT INTO knowledge_jobs
           (id, project_id, job_kind, source_version_id, status, payload_json, requested_at, retry_count, max_retries)
           VALUES (@id, @projectId, @jobKind, @sourceVersionId, 'queued', @payload, @now, 0, @maxRetries)`,
        )
        .run({
          id,
          projectId: input.projectId,
          jobKind: input.jobKind,
          sourceVersionId: input.sourceVersionId ?? null,
          payload: JSON.stringify(input.payload),
          now,
          maxRetries: input.maxRetries ?? 3,
        });
      return this.get(id) as KnowledgeJobRecord;
    })();
  }

  public get(jobId: string): KnowledgeJobRecord | null {
    const row = this.db.prepare('SELECT * FROM knowledge_jobs WHERE id = ?').get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  public list(projectId: string): KnowledgeJobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM knowledge_jobs WHERE project_id = ? ORDER BY requested_at, id')
      .all(projectId) as JobRow[];
    return rows.map(rowToJob);
  }

  public claim(workerId: string): KnowledgeJobRecord | null {
    if (!workerId.trim()) throw new Error('Knowledge queue worker ID must not be empty');
    const now = this.now();
    const leaseExpiresAt = new Date(Date.parse(now) + this.leaseDurationMs).toISOString();
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM knowledge_jobs
           WHERE status = 'queued'
           ORDER BY requested_at, id
           LIMIT 1`,
        )
        .get() as JobRow | undefined;
      if (!row) return null;
      const result = this.db
        .prepare(
          `UPDATE knowledge_jobs
           SET status = 'running', worker_id = @workerId, lease_expires_at = @leaseExpiresAt,
               started_at = COALESCE(started_at, @now)
           WHERE id = @id AND status = 'queued'`,
        )
        .run({ id: row.id, workerId, leaseExpiresAt, now });
      return result.changes === 1 ? this.get(row.id) : null;
    })();
  }

  public complete(jobId: string, workerId?: string): KnowledgeJobRecord {
    const job = this.require(jobId);
    this.assertRunning(job, workerId);
    this.db
      .prepare(
        `UPDATE knowledge_jobs
         SET status = 'completed', completed_at = @now, worker_id = NULL, lease_expires_at = NULL
         WHERE id = @id`,
      )
      .run({ id: jobId, now: this.now() });
    return this.require(jobId);
  }

  public fail(
    jobId: string,
    failureCode: string,
    failureMessage: string,
    workerId?: string,
  ): KnowledgeJobRecord {
    const job = this.require(jobId);
    this.assertRunning(job, workerId);
    const retryCount = job.retryCount + 1;
    this.db
      .prepare(
        `UPDATE knowledge_jobs
         SET status = 'failed', completed_at = @now, failure_code = @failureCode,
             failure_message = @failureMessage, retry_count = @retryCount,
             worker_id = NULL, lease_expires_at = NULL
         WHERE id = @id`,
      )
      .run({
        id: jobId,
        now: this.now(),
        failureCode,
        failureMessage,
        retryCount,
      });
    return this.require(jobId);
  }

  public cancel(jobId: string): KnowledgeJobRecord {
    const job = this.require(jobId);
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new Error(`Cannot cancel job ${jobId} from ${job.status} state`);
    }
    this.db
      .prepare(
        `UPDATE knowledge_jobs
         SET status = 'cancelled', completed_at = @now, worker_id = NULL, lease_expires_at = NULL
         WHERE id = @id`,
      )
      .run({ id: jobId, now: this.now() });
    return this.require(jobId);
  }

  public retry(jobId: string): KnowledgeJobRecord {
    const job = this.require(jobId);
    if (job.status !== 'failed') throw new Error(`Cannot retry job ${jobId} from ${job.status} state`);
    if (job.retryCount > job.maxRetries) throw new Error(`Knowledge job retry limit reached: ${jobId}`);
    this.db
      .prepare(
        `UPDATE knowledge_jobs
         SET status = 'queued', completed_at = NULL, failure_code = NULL, failure_message = NULL
         WHERE id = @id`,
      )
      .run({ id: jobId });
    return this.require(jobId);
  }

  public recoverExpiredKnowledgeJobs(): string[] {
    const now = this.now();
    const expired = this.db
      .prepare(
        `SELECT * FROM knowledge_jobs
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
         ORDER BY requested_at, id`,
      )
      .all(now) as JobRow[];
    const recovered: string[] = [];
    this.db.transaction(() => {
      for (const job of expired) {
        const retryCount = job.retry_count + 1;
        const status = retryCount > job.max_retries ? 'failed' : 'queued';
        this.db
          .prepare(
            `UPDATE knowledge_jobs
             SET status = @status, completed_at = CASE WHEN @status = 'failed' THEN @now ELSE NULL END,
                 failure_code = CASE WHEN @status = 'failed' THEN 'lease_expired' ELSE NULL END,
                 failure_message = CASE WHEN @status = 'failed' THEN 'Worker lease expired' ELSE NULL END,
                 retry_count = @retryCount, worker_id = NULL, lease_expires_at = NULL
             WHERE id = @id AND status = 'running'`,
          )
          .run({ id: job.id, status, now, retryCount });
        if (status === 'queued') recovered.push(job.id);
      }
    })();
    return recovered;
  }

  public recordProgress(
    jobId: string,
    stage: string,
    completedUnits: number,
    totalUnits: number,
    detail: Record<string, unknown> = {},
  ): KnowledgeProgressEvent {
    const job = this.require(jobId);
    if (job.status !== 'running') throw new Error(`Cannot report progress for ${job.status} job`);
    if (!Number.isInteger(completedUnits) || completedUnits < 0 || !Number.isInteger(totalUnits) || totalUnits < 0) {
      throw new Error('Knowledge progress units must be non-negative integers');
    }
    const event = {
      id: createKnowledgeId('job-event'),
      projectId: job.projectId,
      jobId,
      eventKind: 'progress',
      detailJson: JSON.stringify({ stage, completedUnits, totalUnits, detail }),
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO knowledge_job_events
         (id, project_id, job_id, event_kind, detail_json, created_at)
         VALUES (@id, @projectId, @jobId, @eventKind, @detailJson, @createdAt)`,
      )
      .run(event);
    return this.progressFromEvent(event);
  }

  public listProgress(jobId: string): KnowledgeProgressEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_job_events
         WHERE job_id = ? AND event_kind = 'progress' ORDER BY created_at, id`,
      )
      .all(jobId) as ProgressRow[];
    return rows.map((row) => this.progressFromEvent({
      id: row.id,
      projectId: row.project_id,
      jobId: row.job_id,
      detailJson: row.detail_json,
      createdAt: row.created_at,
    }));
  }

  public listProgressEvents(jobId: string): KnowledgeProgressEvent[] {
    return this.listProgress(jobId);
  }

  public recordProgressEvent(
    jobId: string,
    stage: string,
    completedUnits: number,
    totalUnits: number,
    detail: Record<string, unknown> = {},
  ): KnowledgeProgressEvent {
    return this.recordProgress(jobId, stage, completedUnits, totalUnits, detail);
  }

  private progressFromEvent(event: {
    id: string;
    projectId: string;
    jobId: string;
    detailJson: string;
    createdAt: string;
  }): KnowledgeProgressEvent {
    const detail = JSON.parse(event.detailJson) as {
      stage: string;
      completedUnits: number;
      totalUnits: number;
      detail: Record<string, unknown>;
    };
    return {
      id: event.id,
      projectId: event.projectId,
      jobId: event.jobId as KnowledgeJobId,
      stage: detail.stage,
      completedUnits: detail.completedUnits,
      totalUnits: detail.totalUnits,
      detail: detail.detail,
      createdAt: event.createdAt,
    };
  }

  private require(jobId: string): KnowledgeJobRecord {
    const job = this.get(jobId);
    if (!job) throw getErrorMessage('Knowledge job not found', jobId);
    return job;
  }

  private assertRunning(job: KnowledgeJobRecord, workerId?: string): void {
    if (job.status !== 'running') throw new Error(`Knowledge job ${job.id} is not running`);
    if (workerId !== undefined && job.workerId !== workerId) {
      throw new Error(`Knowledge job ${job.id} is owned by another worker`);
    }
  }
}

export function enqueueKnowledgeJob(
  db: Database.Database,
  input: EnqueueKnowledgeJobInput,
): KnowledgeJobRecord {
  return new KnowledgeQueue(db).enqueue(input);
}

export function claimKnowledgeJob(
  db: Database.Database,
  workerId: string,
): KnowledgeJobRecord | null {
  return new KnowledgeQueue(db).claim(workerId);
}
