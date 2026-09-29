import type Database from 'better-sqlite3';
import { redact, redactLines } from '../Redactor.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import {
  KNOWLEDGE_JOB_RESULT_SCHEMA_VERSION,
  parseStoredKnowledgeJobResult,
  validateAnalyzedJobResult,
  validateCoverageOnlyJobResult,
  type KnowledgeJobProcessingMode,
  type KnowledgeJobResult,
  type KnowledgeJobResultInput,
  type KnowledgeJobResultLegacyState,
} from './KnowledgeJobResult.js';
import type { KnowledgeJobId, KnowledgeJobStatus } from './KnowledgeTypes.js';

export type {
  KnowledgeAnalyzedJobResult,
  KnowledgeCoverageOnlyJobResult,
  KnowledgeJobProcessingMode,
  KnowledgeJobResult,
  KnowledgeJobResultBase,
  KnowledgeJobResultInput,
  KnowledgeJobResultLegacyState,
  KnowledgeJobResultWarning,
} from './KnowledgeJobResult.js';

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
  result: KnowledgeJobResult | null;
  /** `knowledge_jobs.result_schema_version`: null for legacy rows, 1 for the versioned envelope. */
  resultSchemaVersion: number | null;
  /** Explicit compatibility state; null when the job has no completed result to interpret. */
  resultState: KnowledgeJobResultLegacyState | null;
}

export interface KnowledgeQueueStatus {
  projectId: string;
  queuedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  oldestQueuedAgeMs: number | null;
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

export interface KnowledgeTerminalProgressInput {
  stage: string;
  completedUnits: number;
  totalUnits: number;
  detail?: Record<string, unknown>;
}

export interface KnowledgeRecoverySummary {
  requeuedIds: string[];
  failedIds: string[];
}

export type KnowledgeRequeueReason =
  | 'manual'
  | 'analyzer_upgraded'
  | 'coverage_adapter_available'
  | 'cancelled_recovery';

export const KNOWLEDGE_REQUEUE_REASONS: readonly KnowledgeRequeueReason[] = [
  'manual',
  'analyzer_upgraded',
  'coverage_adapter_available',
  'cancelled_recovery',
];

export interface KnowledgeRequeueContext {
  /** Analyzer the requeue targets; recorded so a trigger can be limited to once per analyzer version. */
  analyzerId?: string;
  analyzerVersion?: string;
}

export interface KnowledgeRequeueEvent {
  id: string;
  projectId: string;
  jobId: string;
  reason: KnowledgeRequeueReason;
  previousStatus: KnowledgeJobStatus;
  previousResultSchemaVersion: number | null;
  previousFailureCode: string | null;
  previousRetryCount: number;
  targetAnalyzer: string | null;
  createdAt: string;
}

export interface KnowledgeQueueOptions {
  leaseDurationMs?: number;
  now?: () => string;
  onRecoverExpiredCandidate?: (job: KnowledgeJobRecord) => void;
}

interface JobRow {
  id: string;
  project_id: string;
  job_kind: string;
  source_version_id: string | null;
  status: KnowledgeJobStatus;
  payload_json: string;
  result_json: string | null;
  result_processing_mode: KnowledgeJobProcessingMode | null;
  result_schema_version?: number | null;
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
const MAX_RESULT_WARNINGS = 8;
const MAX_WARNING_MESSAGE_LENGTH = 280;
const MAX_WARNING_CODE_LENGTH = 64;
const MAX_FAILURE_MESSAGE_LENGTH = 500;
const MAX_PROGRESS_DETAIL_ENTRIES = 12;
const MAX_PROGRESS_DETAIL_DEPTH = 3;
const MAX_PROGRESS_ARRAY_ITEMS = 12;
const MAX_PROGRESS_STRING_LENGTH = 240;
const MAX_PROGRESS_KEY_LENGTH = 80;
const MAX_PROGRESS_STAGE_LENGTH = 64;

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Knowledge queue payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizePersistedResult(result: KnowledgeJobResultInput): KnowledgeJobResult {
  const boundWarnings = (warnings: KnowledgeJobResult['warnings']): KnowledgeJobResult['warnings'] =>
    warnings.slice(0, MAX_RESULT_WARNINGS).map((warning) => ({
      code: boundedRedactedCode(warning.code),
      message: boundedRedactedLine(warning.message, MAX_WARNING_MESSAGE_LENGTH),
    }));
  if (result.resultKind === 'coverage_only') {
    const validated = validateCoverageOnlyJobResult(result);
    return { ...validated, warnings: boundWarnings(validated.warnings) };
  }
  const validated = validateAnalyzedJobResult({ resultKind: 'analyzed', ...result });
  return {
    ...validated,
    pageVersionIds: validated.pageVersionIds.slice(0, MAX_PROGRESS_ARRAY_ITEMS),
    warnings: boundWarnings(validated.warnings),
  };
}

function boundedRedactedLine(value: string, maxLength: number): string {
  const redactedValue = redact(value);
  if (redactedValue.length <= maxLength) {
    return redactedValue;
  }
  const suffix = ' …[truncated]';
  const budget = Math.max(0, maxLength - suffix.length);
  return `${redactedValue.slice(0, budget)}${suffix}`;
}

function boundedRedactedKey(value: string): string {
  return boundedRedactedLine(value, MAX_PROGRESS_KEY_LENGTH);
}

function boundedRedactedCode(value: string): string {
  return boundedRedactedLine(value, MAX_WARNING_CODE_LENGTH);
}

function boundedRedactedStage(value: string): string {
  return boundedRedactedLine(value, MAX_PROGRESS_STAGE_LENGTH);
}

function sanitizeProgressValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return boundedRedactedLine(value, MAX_PROGRESS_STRING_LENGTH);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_PROGRESS_DETAIL_DEPTH) {
      return value.length;
    }
    return value.slice(0, MAX_PROGRESS_ARRAY_ITEMS).map((entry) => sanitizeProgressValue(entry, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    if (depth >= MAX_PROGRESS_DETAIL_DEPTH) {
      return '[object]';
    }
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_PROGRESS_DETAIL_ENTRIES)
        .map(([key, entry]) => [boundedRedactedKey(key), sanitizeProgressValue(entry, depth + 1)]),
    );
  }
  return boundedRedactedLine(String(value), MAX_PROGRESS_STRING_LENGTH);
}

function sanitizeProgressDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(detail)
      .slice(0, MAX_PROGRESS_DETAIL_ENTRIES)
      .map(([key, value]) => [boundedRedactedKey(key), sanitizeProgressValue(value)]),
  );
}

function rowToJob(row: JobRow): KnowledgeJobRecord {
  const parsed = parseStoredKnowledgeJobResult(
    row.result_json,
    row.result_schema_version ?? null,
    row.result_processing_mode,
    row.status,
  );
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
    result: parsed.result,
    resultSchemaVersion: row.result_schema_version ?? null,
    resultState: parsed.legacyState,
  };
}

function getErrorMessage(code: string, id: string): Error {
  return new Error(`${code}: ${id}`);
}

function leaseLostTransitionError(jobId: string, workerId: string): KnowledgeQueueTransitionError {
  return new KnowledgeQueueTransitionError(`Knowledge job lease lost for ${jobId} and worker ${workerId}`);
}

function hasActiveLease(leaseExpiresAt: string | null, now: string): boolean {
  return leaseExpiresAt !== null && leaseExpiresAt > now;
}

export class KnowledgeQueueTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'KnowledgeQueueTransitionError';
  }
}

export class KnowledgeQueue {
  private readonly leaseDurationMs: number;
  private now: () => string;
  private readonly onRecoverExpiredCandidate?: (job: KnowledgeJobRecord) => void;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeQueueOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onRecoverExpiredCandidate = options.onRecoverExpiredCandidate;
  }

  public setNow(now: () => string): void {
    this.now = now;
  }

  public getLeaseDurationMs(): number {
    return this.leaseDurationMs;
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

  public claim(projectId: string, workerId: string): KnowledgeJobRecord | null {
    if (!projectId.trim()) throw new Error('Knowledge queue project ID must not be empty');
    if (!workerId.trim()) throw new Error('Knowledge queue worker ID must not be empty');
    const now = this.now();
    const leaseExpiresAt = new Date(Date.parse(now) + this.leaseDurationMs).toISOString();
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM knowledge_jobs
           WHERE project_id = @projectId
             AND status = 'queued'
             AND worker_id IS NULL
             AND lease_expires_at IS NULL
             AND completed_at IS NULL
             AND failure_code IS NULL
             AND failure_message IS NULL
             AND result_json IS NULL
           ORDER BY requested_at, id
           LIMIT 1`,
        )
        .get({ projectId }) as JobRow | undefined;
      if (!row) return null;
      const result = this.db
        .prepare(
          `UPDATE knowledge_jobs
           SET status = 'running', worker_id = @workerId, lease_expires_at = @leaseExpiresAt,
               started_at = COALESCE(started_at, @now)
           WHERE id = @id
             AND project_id = @projectId
             AND status = 'queued'
             AND worker_id IS NULL
             AND lease_expires_at IS NULL
             AND completed_at IS NULL
             AND failure_code IS NULL
             AND failure_message IS NULL
             AND result_json IS NULL`,
        )
        .run({ id: row.id, projectId, workerId, leaseExpiresAt, now });
      return result.changes === 1 ? this.get(row.id) : null;
    })();
  }

  public complete(
    jobId: string,
    workerId: string,
    result?: KnowledgeJobResultInput,
    options: { progress?: KnowledgeTerminalProgressInput } = {},
  ): KnowledgeJobRecord {
    const persistedResult = result === undefined ? null : sanitizePersistedResult(result);
    return this.db.transaction(() => {
      const now = this.now();
      const completion = this.db
        .prepare(
          `UPDATE knowledge_jobs
           SET status = 'completed', completed_at = @now, worker_id = NULL, lease_expires_at = NULL,
               result_json = @resultJson, result_processing_mode = @resultProcessingMode,
               result_schema_version = @resultSchemaVersion
           WHERE id = @id
             AND status = 'running'
             AND worker_id = @workerId
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at > @now
             AND completed_at IS NULL
             AND failure_code IS NULL
             AND failure_message IS NULL
             AND result_json IS NULL`,
        )
        .run({
          id: jobId,
          workerId,
          now,
          resultJson: persistedResult === null ? null : JSON.stringify(persistedResult),
          resultProcessingMode: persistedResult?.processingMode ?? 'unknown',
          resultSchemaVersion: persistedResult === null ? null : KNOWLEDGE_JOB_RESULT_SCHEMA_VERSION,
        });
      if (completion.changes !== 1) {
        throw new KnowledgeQueueTransitionError(
          `Knowledge job ${jobId} is not running with an active lease for worker ${workerId}`,
        );
      }
      const completedJob = this.require(jobId);
      if (options.progress) {
        this.insertProgressEvent(completedJob.projectId, jobId, options.progress, now);
      }
      return completedJob;
    })();
  }

  public fail(
    jobId: string,
    failureCode: string,
    failureMessage: string,
    workerId: string,
  ): KnowledgeJobRecord {
    return this.db.transaction(() => {
      const now = this.now();
      const failure = this.db
        .prepare(
          `UPDATE knowledge_jobs
           SET status = 'failed', completed_at = @now, failure_code = @failureCode,
               failure_message = @failureMessage, retry_count = retry_count + 1,
               worker_id = NULL, lease_expires_at = NULL
           WHERE id = @id
             AND status = 'running'
             AND worker_id = @workerId
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at > @now
             AND completed_at IS NULL
             AND failure_code IS NULL
             AND failure_message IS NULL
             AND result_json IS NULL`,
        )
        .run({
          id: jobId,
          workerId,
          now,
          failureCode,
          failureMessage: boundedRedactedLine(failureMessage, MAX_FAILURE_MESSAGE_LENGTH),
        });
      if (failure.changes !== 1) {
        throw new KnowledgeQueueTransitionError(
          `Knowledge job ${jobId} is not running with an active lease for worker ${workerId}`,
        );
      }
      return this.require(jobId);
    })();
  }

  public cancel(jobId: string): KnowledgeJobRecord {
    const job = this.require(jobId);
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new Error(`Cannot cancel job ${jobId} from ${job.status} state`);
    }
    const now = this.now();
    const statement = job.status === 'queued'
      ? this.db.prepare(
          `UPDATE knowledge_jobs
           SET status = 'cancelled', completed_at = @now, worker_id = NULL, lease_expires_at = NULL
           WHERE id = @id
             AND status = 'queued'
             AND worker_id IS NULL
             AND lease_expires_at IS NULL
             AND completed_at IS NULL
             AND failure_code IS NULL
             AND failure_message IS NULL
             AND result_json IS NULL`,
        )
      : this.db.prepare(
          `UPDATE knowledge_jobs
           SET status = 'cancelled', completed_at = @now, worker_id = NULL, lease_expires_at = NULL
           WHERE id = @id
             AND status = 'running'
             AND worker_id = @workerId
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at > @now
             AND completed_at IS NULL
             AND failure_code IS NULL
             AND failure_message IS NULL
             AND result_json IS NULL`,
        );
    const cancellation = statement.run({ id: jobId, now, workerId: job.workerId });
    if (cancellation.changes !== 1) {
      const latest = this.get(jobId);
      if (
        job.status === 'running' &&
        latest?.status === 'running' &&
        latest.workerId === job.workerId &&
        !hasActiveLease(latest.leaseExpiresAt, now)
      ) {
        throw new KnowledgeQueueTransitionError(
          `Knowledge job ${jobId} is not running with an active lease for worker ${job.workerId}`,
        );
      }
      throw new KnowledgeQueueTransitionError(`Knowledge job ${jobId} changed before cancellation could be applied`);
    }
    return this.require(jobId);
  }

  public cancelOwned(jobId: string, workerId: string): KnowledgeJobRecord {
    this.require(jobId);
    const now = this.now();
    const cancellation = this.db
      .prepare(
        `UPDATE knowledge_jobs
         SET status = 'cancelled', completed_at = @now, worker_id = NULL, lease_expires_at = NULL
         WHERE id = @id
           AND status = 'running'
           AND worker_id = @workerId
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at > @now
           AND completed_at IS NULL
           AND failure_code IS NULL
           AND failure_message IS NULL
           AND result_json IS NULL`,
      )
      .run({ id: jobId, workerId, now });
    if (cancellation.changes !== 1) {
      throw new KnowledgeQueueTransitionError(
        `Knowledge job ${jobId} is not running with an active lease for worker ${workerId}`,
      );
    }
    return this.require(jobId);
  }

  public retry(jobId: string): KnowledgeJobRecord {
    const job = this.require(jobId);
    if (job.status !== 'failed') throw new Error(`Cannot retry job ${jobId} from ${job.status} state`);
    if (job.retryCount > job.maxRetries) throw new Error(`Knowledge job retry limit reached: ${jobId}`);
    const retried = this.db
      .prepare(
        `UPDATE knowledge_jobs
         SET status = 'queued', completed_at = NULL, failure_code = NULL, failure_message = NULL
         WHERE id = @id
           AND status = 'failed'
           AND retry_count = @retryCount
           AND max_retries = @maxRetries
           AND worker_id IS NULL
           AND lease_expires_at IS NULL
           AND result_json IS NULL
           AND completed_at = @completedAt
           AND failure_code IS @failureCode
           AND failure_message IS @failureMessage`,
      )
      .run({
        id: jobId,
        retryCount: job.retryCount,
        maxRetries: job.maxRetries,
        completedAt: job.completedAt,
        failureCode: job.failureCode,
        failureMessage: job.failureMessage,
      });
    if (retried.changes !== 1) {
      throw new KnowledgeQueueTransitionError(`Knowledge job ${jobId} changed before retry could be applied`);
    }
    return this.require(jobId);
  }

  /**
   * Explicit terminal-to-queued transition for the one analyze job a source version can ever have. Reuses the row
   * (the `(project_id, job_kind, source_version_id)` identity is unique), so it only acts on a completed, failed, or
   * cancelled row that holds no worker or lease. Returns null when nothing changed.
   */
  public requeueAnalyze(
    jobId: string,
    reason: KnowledgeRequeueReason,
    context: KnowledgeRequeueContext = {},
  ): KnowledgeJobRecord | null {
    if (!KNOWLEDGE_REQUEUE_REASONS.includes(reason)) {
      throw new Error(`Unsupported knowledge requeue reason: ${String(reason)}`);
    }
    return this.db.transaction(() => {
      const previous = this.db
        .prepare(`SELECT * FROM knowledge_jobs WHERE id = ? AND job_kind = 'analyze'`)
        .get(jobId) as JobRow | undefined;
      if (!previous) return null;
      const now = this.now();
      const requeued = this.db
        .prepare(
          `UPDATE knowledge_jobs
           SET status = 'queued', started_at = NULL, completed_at = NULL,
               failure_code = NULL, failure_message = NULL,
               result_json = NULL, result_processing_mode = NULL, result_schema_version = NULL,
               retry_count = 0
           WHERE id = @id
             AND project_id = @projectId
             AND job_kind = 'analyze'
             AND status IN ('completed', 'failed', 'cancelled')
             AND worker_id IS NULL
             AND lease_expires_at IS NULL`,
        )
        .run({ id: previous.id, projectId: previous.project_id });
      if (requeued.changes !== 1) return null;
      const targetAnalyzer =
        context.analyzerId && context.analyzerVersion
          ? `${boundedRedactedLine(context.analyzerId, MAX_PROGRESS_KEY_LENGTH)}@${boundedRedactedLine(context.analyzerVersion, MAX_PROGRESS_KEY_LENGTH)}`
          : null;
      this.db
        .prepare(
          `INSERT INTO knowledge_job_events (id, project_id, job_id, event_kind, detail_json, created_at)
           VALUES (@id, @projectId, @jobId, 'requeued', @detailJson, @createdAt)`,
        )
        .run({
          id: createKnowledgeId('job-event'),
          projectId: previous.project_id,
          jobId: previous.id,
          createdAt: now,
          detailJson: JSON.stringify({
            reason,
            previousStatus: previous.status,
            previousResultSchemaVersion: previous.result_schema_version ?? null,
            previousFailureCode:
              previous.failure_code === null ? null : boundedRedactedLine(previous.failure_code, MAX_WARNING_CODE_LENGTH),
            previousRetryCount: previous.retry_count,
            targetAnalyzer,
          }),
        });
      return this.require(jobId);
    })();
  }

  public listRequeueEvents(jobId: string): KnowledgeRequeueEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_job_events
         WHERE job_id = ? AND event_kind = 'requeued' ORDER BY created_at, rowid`,
      )
      .all(jobId) as ProgressRow[];
    return rows.map((row) => {
      const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
      return {
        id: row.id,
        projectId: row.project_id,
        jobId: row.job_id,
        reason: detail.reason as KnowledgeRequeueReason,
        previousStatus: detail.previousStatus as KnowledgeJobStatus,
        previousResultSchemaVersion: (detail.previousResultSchemaVersion as number | null) ?? null,
        previousFailureCode: (detail.previousFailureCode as string | null) ?? null,
        previousRetryCount: (detail.previousRetryCount as number | undefined) ?? 0,
        targetAnalyzer: (detail.targetAnalyzer as string | null) ?? null,
        createdAt: row.created_at,
      };
    });
  }

  public renewLease(jobId: string, workerId: string): KnowledgeJobRecord {
    if (!workerId.trim()) throw new Error('Knowledge queue worker ID must not be empty');
    const now = this.now();
    const leaseExpiresAt = new Date(Date.parse(now) + this.leaseDurationMs).toISOString();
    const renewal = this.db
      .prepare(
        `UPDATE knowledge_jobs
         SET lease_expires_at = @leaseExpiresAt
         WHERE id = @id
           AND status = 'running'
           AND worker_id = @workerId
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at > @now
           AND completed_at IS NULL
           AND failure_code IS NULL
           AND failure_message IS NULL
           AND result_json IS NULL`,
      )
      .run({ id: jobId, workerId, leaseExpiresAt, now });
    if (renewal.changes !== 1) {
      throw leaseLostTransitionError(jobId, workerId);
    }
    return this.require(jobId);
  }

  public recoverExpiredKnowledgeJobs(projectId?: string): string[] {
    return this.recoverExpiredKnowledgeJobsSummary(projectId).requeuedIds;
  }

  public recoverExpiredKnowledgeJobsSummary(projectId?: string): KnowledgeRecoverySummary {
    return this.db.transaction(() => {
      const now = this.now();
      const expired = this.db
        .prepare(
          `SELECT * FROM knowledge_jobs
           WHERE status = 'running'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= @now
             AND (@projectId IS NULL OR project_id = @projectId)
           ORDER BY requested_at, id`,
        )
        .all({ now, projectId: projectId ?? null }) as JobRow[];
      const recovered: KnowledgeRecoverySummary = {
        requeuedIds: [],
        failedIds: [],
      };
      for (const job of expired) {
        this.onRecoverExpiredCandidate?.(rowToJob(job));
        const retryCount = job.retry_count + 1;
        const status = retryCount > job.max_retries ? 'failed' : 'queued';
        const result = this.db
          .prepare(
            `UPDATE knowledge_jobs
             SET status = @status, completed_at = CASE WHEN @status = 'failed' THEN @now ELSE NULL END,
                 failure_code = CASE WHEN @status = 'failed' THEN 'lease_expired' ELSE NULL END,
                 failure_message = CASE WHEN @status = 'failed' THEN 'Worker lease expired' ELSE NULL END,
                 retry_count = @retryCount, worker_id = NULL, lease_expires_at = NULL
             WHERE id = @id
               AND project_id = @projectId
               AND status = 'running'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= @now`,
          )
          .run({ id: job.id, projectId: job.project_id, status, now, retryCount });
        if (result.changes === 1) {
          if (status === 'queued') {
            recovered.requeuedIds.push(job.id);
          } else {
            recovered.failedIds.push(job.id);
          }
        }
      }
      return recovered;
    })();
  }

  public getQueueStatus(projectId: string): KnowledgeQueueStatus {
    if (!projectId.trim()) throw new Error('Knowledge queue project ID must not be empty');
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
           MIN(CASE WHEN status = 'queued' THEN requested_at END) AS oldest_queued_requested_at
         FROM knowledge_jobs
         WHERE project_id = ?`,
      )
      .get(projectId) as {
        queued_count: number | null;
        running_count: number | null;
        completed_count: number | null;
        failed_count: number | null;
        cancelled_count: number | null;
        oldest_queued_requested_at: string | null;
      };
    const oldestQueuedAgeMs = row.oldest_queued_requested_at === null
      ? null
      : Math.max(0, Date.parse(this.now()) - Date.parse(row.oldest_queued_requested_at));
    return {
      projectId,
      queuedCount: row.queued_count ?? 0,
      runningCount: row.running_count ?? 0,
      completedCount: row.completed_count ?? 0,
      failedCount: row.failed_count ?? 0,
      cancelledCount: row.cancelled_count ?? 0,
      oldestQueuedAgeMs,
    };
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
    return this.insertProgressEvent(job.projectId, jobId, { stage, completedUnits, totalUnits, detail }, this.now());
  }

  public listProgress(jobId: string): KnowledgeProgressEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_job_events
         WHERE job_id = ? AND event_kind = 'progress' ORDER BY created_at, rowid`,
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

  private insertProgressEvent(
    projectId: string,
    jobId: string,
    input: KnowledgeTerminalProgressInput,
    createdAt: string,
  ): KnowledgeProgressEvent {
    const safeDetail = sanitizeProgressDetail(input.detail ?? {});
    const event = {
      id: createKnowledgeId('job-event'),
      projectId,
      jobId,
      eventKind: 'progress',
      detailJson: JSON.stringify({
        stage: boundedRedactedStage(input.stage),
        completedUnits: input.completedUnits,
        totalUnits: input.totalUnits,
        detail: safeDetail,
      }),
      createdAt,
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

}

export function enqueueKnowledgeJob(
  db: Database.Database,
  input: EnqueueKnowledgeJobInput,
): KnowledgeJobRecord {
  return new KnowledgeQueue(db).enqueue(input);
}

export function claimKnowledgeJob(
  db: Database.Database,
  projectId: string,
  workerId: string,
): KnowledgeJobRecord | null {
  return new KnowledgeQueue(db).claim(projectId, workerId);
}
