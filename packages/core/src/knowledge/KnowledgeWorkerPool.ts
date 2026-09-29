import type Database from 'better-sqlite3';
import { createKnowledgeId } from './KnowledgeIds.js';
import {
  KnowledgeHostSettingsStore,
  KnowledgeWorkerSettingsStore,
  resolveKnowledgeWorkerConcurrency,
  type KnowledgeWorkerSettingsStoreLike,
  type ResolvedKnowledgeWorkerConcurrency,
} from './KnowledgeHostSettingsStore.js';
import { KnowledgeQueue } from './KnowledgeQueue.js';
import {
  KnowledgeWorker,
  type KnowledgeWorkerDependencies,
  type KnowledgeWorkerOptions,
  type KnowledgeWorkerRunResult,
  type KnowledgeWorkerWarning,
} from './KnowledgeWorker.js';

export type { ResolvedKnowledgeWorkerConcurrency } from './KnowledgeHostSettingsStore.js';

const DEFAULT_WATCH_POLL_MS = 1_000;
const MIN_WATCH_POLL_MS = 50;
const MAX_WATCH_POLL_MS = 60_000;
const BASE_WORKER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,64}$/;

export interface KnowledgeWorkerSlotResult {
  workerId: string;
  claimed: number;
  completed: number;
  failed: number;
  cancelled: number;
  leaseLosses: number;
  warnings: KnowledgeWorkerWarning[];
}

export interface KnowledgeWorkerPoolRunResult extends KnowledgeWorkerRunResult {
  concurrency: number;
  resolvedConcurrency: ResolvedKnowledgeWorkerConcurrency;
  /** Expired leases recovered by this pass, whether they were requeued or exhausted their retries. */
  recoveredExpired: number;
  slots: KnowledgeWorkerSlotResult[];
}

export interface KnowledgeWorkerSlotFactoryInput {
  workerId: string;
  signal?: AbortSignal;
}

export interface KnowledgeWorkerPoolOptions {
  baseWorkerId: string;
  concurrency?: number;
  now?: () => string;
  signal?: AbortSignal;
  /** Extra options for the default slot workers; identity, clock, and signal always come from the pool. */
  workerOptions?: Partial<Omit<KnowledgeWorkerOptions, 'workerId' | 'now' | 'signal'>>;
  workerDependencies?: KnowledgeWorkerDependencies;
  /** Replaces slot construction, for example to attach provider enrichment. */
  createWorker?: (input: KnowledgeWorkerSlotFactoryInput) => KnowledgeWorker;
  queue?: KnowledgeQueue;
  settings?: Pick<KnowledgeWorkerSettingsStoreLike, 'getConcurrency'>;
}

/**
 * Coordinates independent single-job worker slots over the queue's transactional claims. It holds no durable state:
 * every slot has its own worker ID, so lease renewal and fencing stay per job and per owner.
 */
export class KnowledgeWorkerPool {
  private readonly baseWorkerId: string;
  private readonly now: () => string;
  private readonly queue: KnowledgeQueue;
  private readonly settings: Pick<KnowledgeWorkerSettingsStoreLike, 'getConcurrency'>;

  public constructor(
    private readonly db: Database.Database,
    private readonly options: KnowledgeWorkerPoolOptions,
  ) {
    this.baseWorkerId = requireBaseWorkerId(options.baseWorkerId);
    this.now = options.now ?? (() => new Date().toISOString());
    this.queue = options.queue ?? new KnowledgeQueue(db, { now: this.now });
    this.settings =
      options.settings ?? new KnowledgeWorkerSettingsStore(new KnowledgeHostSettingsStore(db, { now: this.now }));
  }

  public async runOnce(projectId: string, runOptions: { concurrency?: number } = {}): Promise<KnowledgeWorkerPoolRunResult> {
    const scopedProjectId = requireProjectId(projectId);
    const resolved = resolveKnowledgeWorkerConcurrency(
      this.settings,
      scopedProjectId,
      runOptions.concurrency ?? this.options.concurrency,
    );

    const recovered = this.queue.recoverExpiredKnowledgeJobsSummary(scopedProjectId);
    const runId = createKnowledgeId('run').slice('run_'.length);
    const slotOutcomes = await Promise.all(
      Array.from({ length: resolved.value }, (_, index) =>
        this.runSlot(scopedProjectId, `${this.baseWorkerId}/run_${runId}/slot_${index + 1}`),
      ),
    );

    const slots = slotOutcomes.map((outcome) => outcome.result);
    const crash = slotOutcomes.find((outcome) => outcome.crash !== undefined);
    if (crash) {
      throw crash.crash;
    }

    const warnings = slots.flatMap((slot) => slot.warnings);
    const lastCompletedJobId = slotOutcomes.reduce<string | null>((last, outcome) => outcome.lastCompletedJobId ?? last, null);
    if (lastCompletedJobId !== null) {
      warnings.push(...slotOutcomes[0]!.worker.refreshProjectGraphReport(scopedProjectId, lastCompletedJobId));
    }

    return {
      projectId: scopedProjectId,
      claimed: sum(slots, (slot) => slot.claimed),
      completed: sum(slots, (slot) => slot.completed),
      failed: recovered.failedIds.length + sum(slots, (slot) => slot.failed),
      cancelled: sum(slots, (slot) => slot.cancelled),
      unsupportedCoverageCount: sum(slotOutcomes, (outcome) => outcome.unsupportedCoverage),
      warnings,
      concurrency: resolved.value,
      resolvedConcurrency: resolved,
      recoveredExpired: recovered.requeuedIds.length + recovered.failedIds.length,
      slots,
    };
  }

  /** Repeats pool drains, sleeping only after every slot has gone idle. Concurrency is re-resolved on each pass. */
  public async runWatch(projectId: string, watchOptions: { concurrency?: number; pollMs?: number } = {}): Promise<void> {
    const scopedProjectId = requireProjectId(projectId);
    const pollMs = clampPollMs(watchOptions.pollMs);
    while (!this.options.signal?.aborted) {
      await this.runOnce(scopedProjectId, { concurrency: watchOptions.concurrency });
      if (this.options.signal?.aborted) {
        return;
      }
      await delay(pollMs, this.options.signal);
    }
  }

  private async runSlot(projectId: string, workerId: string): Promise<SlotOutcome> {
    const worker = this.createWorker(workerId);
    const result: KnowledgeWorkerSlotResult = {
      workerId,
      claimed: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      leaseLosses: 0,
      warnings: [],
    };
    const outcome: SlotOutcome = { worker, result, unsupportedCoverage: 0, lastCompletedJobId: null };
    try {
      while (!this.options.signal?.aborted) {
        const step = await worker.runOne(projectId);
        if (step.claimedJobId === null) {
          break;
        }
        result.claimed += 1;
        result.warnings.push(...step.warnings);
        if (step.status === 'completed') {
          result.completed += 1;
          outcome.lastCompletedJobId = step.claimedJobId;
          outcome.unsupportedCoverage += step.unsupportedCoverage ? 1 : 0;
        } else if (step.status === 'failed') {
          result.failed += 1;
        } else if (step.status === 'cancelled') {
          result.cancelled += 1;
        } else if (step.status === 'lease_lost') {
          result.leaseLosses += 1;
        }
      }
    } catch (error) {
      // A crashed slot leaves any leased job to expiry recovery; sibling slots keep draining.
      outcome.crash = error;
    }
    return outcome;
  }

  private createWorker(workerId: string): KnowledgeWorker {
    if (this.options.createWorker) {
      return this.options.createWorker({ workerId, signal: this.options.signal });
    }
    return new KnowledgeWorker(
      this.db,
      { ...this.options.workerOptions, workerId, now: this.now, signal: this.options.signal },
      { queue: this.queue, ...this.options.workerDependencies },
    );
  }
}

interface SlotOutcome {
  worker: KnowledgeWorker;
  result: KnowledgeWorkerSlotResult;
  unsupportedCoverage: number;
  lastCompletedJobId: string | null;
  crash?: unknown;
}

function sum<T>(items: readonly T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function requireBaseWorkerId(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!BASE_WORKER_ID_PATTERN.test(trimmed)) {
    throw new Error('Knowledge worker ID must be 1-64 characters of letters, digits, ".", "_", ":", "@", or "-"');
  }
  return trimmed;
}

function requireProjectId(projectId: string): string {
  const trimmed = typeof projectId === 'string' ? projectId.trim() : '';
  if (trimmed.length === 0) {
    throw new Error('Knowledge worker project ID must not be empty');
  }
  return trimmed;
}

function clampPollMs(pollMs: number | undefined): number {
  if (pollMs === undefined || !Number.isFinite(pollMs)) {
    return DEFAULT_WATCH_POLL_MS;
  }
  return Math.max(MIN_WATCH_POLL_MS, Math.min(MAX_WATCH_POLL_MS, Math.trunc(pollMs)));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
