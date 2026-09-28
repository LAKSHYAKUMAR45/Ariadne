import type Database from 'better-sqlite3';
import { redact } from '../Redactor.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import { ensurePendingKnowledgeReview } from './KnowledgeReview.js';
import {
  KnowledgeGeneratorService,
  type KnowledgeGenerationPayload,
  type KnowledgeGenerationResult,
} from './KnowledgeGeneratorService.js';
import {
  KnowledgeQueue,
  type KnowledgeJobRecord,
  type KnowledgeJobResult,
  type KnowledgeJobResultWarning,
  type KnowledgeTerminalProgressInput,
  KnowledgeQueueTransitionError,
} from './KnowledgeQueue.js';
import {
  KnowledgeSourceVersionLoadError,
  loadKnowledgeSourceVersion,
  type LoadedKnowledgeSourceVersion,
} from './KnowledgeSourceVersionLoader.js';
import {
  KnowledgeExtractionStore,
  type DeterministicExtraction,
} from './KnowledgeExtractionStore.js';
import { KnowledgeGraphMaterializer } from './KnowledgeGraphMaterializer.js';
import { buildDeterministicPagePayload, type DeterministicPageBuildInput } from './DeterministicPageBuilder.js';
import { KnowledgeGraph } from './graph/KnowledgeGraph.js';
import { AnalyzerRegistry, createDefaultAnalyzerRegistry, type DeterministicAnalyzer } from './analyzers/index.js';

const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_WATCH_POLL_MS = 1_000;
const MIN_WATCH_POLL_MS = 50;
const MAX_WATCH_POLL_MS = 60_000;
const MAX_WARNING_MESSAGE_LENGTH = 280;
const MAX_FAILURE_MESSAGE_LENGTH = 500;
const MAX_WARNING_COUNT = 8;
const MAX_PAGE_VERSION_IDS = 8;
const MAX_ENRICHMENT_ITEMS = 8;
const MAX_ENRICHMENT_TYPE_LENGTH = 64;
const TRUNCATION_SUFFIX = ' …[truncated]';

export type KnowledgeWorkerFailureCode =
  | 'source_version_missing'
  | 'source_content_missing'
  | 'source_hash_mismatch'
  | 'source_path_rejected'
  | 'source_too_large'
  | 'unsupported_source'
  | 'analyzer_failed'
  | 'extraction_persist_failed'
  | 'graph_persist_failed'
  | 'generation_failed'
  | 'lease_lost'
  | 'cancelled'
  | 'internal_error';

export interface KnowledgeWorkerOptions {
  workerId: string;
  leaseRenewIntervalMs?: number;
  maxSourceBytes?: number;
  now?: () => string;
  signal?: AbortSignal;
  enrich?: KnowledgeEnrichmentService;
}

export interface KnowledgeWorkerWarning {
  jobId: string;
  code: string;
  message: string;
}

export interface KnowledgeWorkerRunResult {
  projectId: string;
  claimed: number;
  completed: number;
  failed: number;
  cancelled: number;
  warnings: KnowledgeWorkerWarning[];
}

export interface KnowledgeEnrichmentReviewInput {
  pageVersionId?: string | null;
  summary: string;
}

export interface KnowledgeEnrichmentInsightInput {
  type: string;
  contentPath: string;
  confidence: number;
}

export interface KnowledgeEnrichmentResult {
  warnings?: KnowledgeJobResultWarning[];
  reviews?: KnowledgeEnrichmentReviewInput[];
  insights?: KnowledgeEnrichmentInsightInput[];
}

interface KnowledgeEnrichmentOutcome {
  enriched: boolean;
  warnings: KnowledgeJobResultWarning[];
  reviews: KnowledgeEnrichmentReviewInput[];
  insights: KnowledgeEnrichmentInsightInput[];
}

interface KnowledgeEnrichmentScope {
  pageVersionIds: Set<string>;
  contentPaths: Set<string>;
}

interface NormalizedEnrichmentItems<T> {
  items: T[];
  warnings: KnowledgeJobResultWarning[];
}

export interface KnowledgeEnrichmentInput {
  projectId: string;
  jobId: string;
  sourceId: string;
  sourceVersionId: string;
  sourcePath: string | null;
  extraction: DeterministicExtraction;
  pageVersionIds: string[];
  signal?: AbortSignal;
}

export interface KnowledgeEnrichmentService {
  enrich(input: KnowledgeEnrichmentInput): Promise<KnowledgeEnrichmentResult | void>;
}

export interface KnowledgeWorkerDependencies {
  queue?: KnowledgeQueue;
  sourceLoader?: {
    load(input: { projectId: string; sourceVersionId: string; maxBytes?: number }): LoadedKnowledgeSourceVersion;
  };
  analyzers?: Pick<AnalyzerRegistry, 'require'>;
  extractionStore?: Pick<KnowledgeExtractionStore, 'save'>;
  graphMaterializer?: Pick<KnowledgeGraphMaterializer, 'materialize'>;
  generator?: Pick<KnowledgeGeneratorService, 'runKnowledgeGeneration'>;
  pageBuilder?: (input: DeterministicPageBuildInput) => KnowledgeGenerationPayload;
}

type KnowledgeSourceLoader = NonNullable<KnowledgeWorkerDependencies['sourceLoader']>;

class KnowledgeWorkerUnsupportedJobError extends Error {
  public constructor(jobKind: string) {
    super(`Unsupported knowledge job kind: ${jobKind}`);
    this.name = 'KnowledgeWorkerUnsupportedJobError';
  }
}

class KnowledgeWorkerLeaseLostError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'KnowledgeWorkerLeaseLostError';
  }
}

class KnowledgeWorkerCancelledError extends Error {
  public constructor() {
    super('Knowledge worker cancelled');
    this.name = 'KnowledgeWorkerCancelledError';
  }
}

class KnowledgeWorkerStageError extends Error {
  public constructor(
    public readonly code:
      | 'analyzer_failed'
      | 'extraction_persist_failed'
      | 'graph_persist_failed'
      | 'generation_failed',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'KnowledgeWorkerStageError';
  }
}

interface LeaseMonitor {
  stop(): void;
  check(): void;
}

function boundRedactedMessage(value: string, maxLength: number): string {
  const redacted = redact(value).replace(/\s+/g, ' ').trim();
  if (redacted.length <= maxLength) {
    return redacted;
  }
  const budget = Math.max(0, maxLength - TRUNCATION_SUFFIX.length);
  return `${redacted.slice(0, budget)}${TRUNCATION_SUFFIX}`;
}

function clampPollMs(pollMs: number | undefined): number {
  if (pollMs === undefined) {
    return DEFAULT_WATCH_POLL_MS;
  }
  if (!Number.isFinite(pollMs)) {
    return DEFAULT_WATCH_POLL_MS;
  }
  return Math.max(MIN_WATCH_POLL_MS, Math.min(MAX_WATCH_POLL_MS, Math.trunc(pollMs)));
}

function requireNonEmptyString(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Knowledge worker ${label} must not be empty`);
  }
  return trimmed;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function summarizeDiagnostics(extraction: DeterministicExtraction): KnowledgeJobResultWarning[] {
  const warningCount = extraction.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const errorCount = extraction.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  if (warningCount === 0 && errorCount === 0) {
    return [];
  }
  const parts = [
    warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : null,
    errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : null,
  ].filter((part): part is string => part !== null);
  return [
    {
      code: 'analyzer_diagnostics',
      message: `Analyzer reported ${parts.join(' and ')}.`,
    },
  ];
}

function uniqueWarnings(warnings: readonly KnowledgeJobResultWarning[]): KnowledgeJobResultWarning[] {
  const deduped = new Map<string, KnowledgeJobResultWarning>();
  for (const warning of warnings) {
    const code = boundRedactedMessage(requireNonEmptyString(warning.code, 'warning code'), MAX_ENRICHMENT_TYPE_LENGTH);
    const message = boundRedactedMessage(warning.message, MAX_WARNING_MESSAGE_LENGTH);
    const key = `${code}\0${message}`;
    if (!deduped.has(key)) {
      deduped.set(key, { code, message });
    }
  }
  return [...deduped.values()].slice(0, MAX_WARNING_COUNT);
}

function enrichmentItemWarning(
  code: 'enrichment_invalid_review' | 'enrichment_invalid_insight' | 'enrichment_review_failed' | 'enrichment_insight_failed',
  index: number,
  reason: string,
): KnowledgeJobResultWarning {
  return {
    code,
    message: boundRedactedMessage(`Skipped enrichment item ${index + 1}: ${reason}`, MAX_WARNING_MESSAGE_LENGTH),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof KnowledgeWorkerCancelledError || (error instanceof Error && error.name === 'AbortError');
}

function isLeaseLost(error: unknown): error is KnowledgeWorkerLeaseLostError {
  return error instanceof KnowledgeWorkerLeaseLostError;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function knowledgeWorkerFailure(error: unknown): {
  code: KnowledgeWorkerFailureCode;
  message: string;
  retryable: boolean;
} {
  if (error instanceof KnowledgeSourceVersionLoadError) {
    return {
      code: error.code,
      message: boundRedactedMessage(error.message, MAX_FAILURE_MESSAGE_LENGTH),
      retryable: false,
    };
  }
  if (error instanceof KnowledgeWorkerUnsupportedJobError) {
    return {
      code: 'unsupported_source',
      message: boundRedactedMessage(error.message, MAX_FAILURE_MESSAGE_LENGTH),
      retryable: false,
    };
  }
  if (error instanceof KnowledgeWorkerLeaseLostError) {
    return {
      code: 'lease_lost',
      message: boundRedactedMessage(error.message, MAX_FAILURE_MESSAGE_LENGTH),
      retryable: true,
    };
  }
  if (isAbortError(error)) {
    return {
      code: 'cancelled',
      message: 'Knowledge worker cancelled',
      retryable: false,
    };
  }
  if (error instanceof KnowledgeWorkerStageError) {
    return {
      code: error.code,
      message: boundRedactedMessage(error.message, MAX_FAILURE_MESSAGE_LENGTH),
      retryable: error.code !== 'analyzer_failed',
    };
  }
  return {
    code: 'internal_error',
    message: boundRedactedMessage(asErrorMessage(error), MAX_FAILURE_MESSAGE_LENGTH),
    retryable: true,
  };
}

export class KnowledgeWorker {
  private readonly queue: KnowledgeQueue;
  private readonly sourceLoader: KnowledgeSourceLoader;
  private readonly analyzers: Pick<AnalyzerRegistry, 'require'>;
  private readonly extractionStore: Pick<KnowledgeExtractionStore, 'save'>;
  private readonly graphMaterializer: Pick<KnowledgeGraphMaterializer, 'materialize'>;
  private readonly generator: Pick<KnowledgeGeneratorService, 'runKnowledgeGeneration'>;
  private readonly pageBuilder: (input: DeterministicPageBuildInput) => KnowledgeGenerationPayload;
  private readonly maxSourceBytes: number;
  private readonly leaseRenewIntervalMs?: number;
  private readonly now: () => string;
  private readonly workerId: string;
  private readonly signal?: AbortSignal;
  private readonly enrich?: KnowledgeEnrichmentService;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeWorkerOptions,
    dependencies: KnowledgeWorkerDependencies = {},
  ) {
    this.workerId = requireNonEmptyString(options.workerId, 'worker ID');
    this.now = options.now ?? (() => new Date().toISOString());
    this.signal = options.signal;
    this.enrich = options.enrich;
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs;
    this.queue = dependencies.queue ?? new KnowledgeQueue(db, { now: this.now });
    this.sourceLoader =
      dependencies.sourceLoader ?? {
        load: (input) => loadKnowledgeSourceVersion(this.db, input),
      };
    this.analyzers = dependencies.analyzers ?? createDefaultAnalyzerRegistry();
    this.extractionStore = dependencies.extractionStore ?? new KnowledgeExtractionStore(db);
    this.graphMaterializer =
      dependencies.graphMaterializer ?? new KnowledgeGraphMaterializer(new KnowledgeGraph(db));
    this.generator =
      dependencies.generator ??
      new KnowledgeGeneratorService(db, {
        workerId: this.workerId,
        now: this.now,
        leaseDurationMs: this.queue.getLeaseDurationMs(),
      });
    this.pageBuilder = dependencies.pageBuilder ?? buildDeterministicPagePayload;
  }

  public async runOnce(projectId: string): Promise<KnowledgeWorkerRunResult> {
    const scopedProjectId = requireNonEmptyString(projectId, 'project ID');
    const warnings: KnowledgeWorkerWarning[] = [];
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;

    while (!this.signal?.aborted) {
      const recovered = this.queue.recoverExpiredKnowledgeJobsSummary(scopedProjectId);
      failed += recovered.failedIds.length;
      const claimedJob = this.queue.claim(scopedProjectId, this.workerId);
      if (!claimedJob) {
        break;
      }
      claimed += 1;
      try {
        const result = await this.processOwnedJob(claimedJob, scopedProjectId);
        warnings.push(...this.runWarnings(result));
        if (result.status === 'completed') {
          completed += 1;
        } else if (result.status === 'failed') {
          failed += 1;
        } else if (result.status === 'cancelled') {
          cancelled += 1;
        }
      } catch (error) {
        const current = this.queue.get(claimedJob.id);
        if (current?.status === 'failed') {
          failed += 1;
        } else if (current?.status === 'cancelled') {
          cancelled += 1;
        }
        if (isLeaseLost(error)) {
          continue;
        }
        throw error;
      }
    }

    return {
      projectId: scopedProjectId,
      claimed,
      completed,
      failed,
      cancelled,
      warnings,
    };
  }

  public async runWatch(projectId: string, options: { pollMs?: number } = {}): Promise<void> {
    const scopedProjectId = requireNonEmptyString(projectId, 'project ID');
    const pollMs = clampPollMs(options.pollMs);
    while (!this.signal?.aborted) {
      await this.runOnce(scopedProjectId);
      if (this.signal?.aborted) {
        return;
      }
      await delay(pollMs, this.signal);
    }
  }

  public async processJob(projectId: string, jobId: string): Promise<KnowledgeJobRecord> {
    const scopedProjectId = requireNonEmptyString(projectId, 'project ID');
    const job = this.requireOwnedRunningJob(scopedProjectId, jobId);
    return this.processOwnedJob(job, scopedProjectId);
  }

  private async processOwnedJob(job: KnowledgeJobRecord, projectId: string): Promise<KnowledgeJobRecord> {
    const leaseMonitor = this.startLeaseMonitor(job.id);
    try {
      const result = await this.runAnalyzeJob(job, projectId, leaseMonitor);
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        const cancelled = this.cancelIfOwned(job.id, projectId);
        if (cancelled) {
          return cancelled;
        }
        throw error;
      }
      if (isLeaseLost(error)) {
        throw error;
      }
      const failure = knowledgeWorkerFailure(error);
      const failed = this.failIfOwned(job.id, projectId, failure.code, failure.message);
      if (failed) {
        return failed;
      }
      throw new KnowledgeWorkerLeaseLostError(
        `Knowledge job ${job.id} is no longer owned by worker ${this.workerId}`,
      );
    } finally {
      leaseMonitor.stop();
    }
  }

  private async runAnalyzeJob(
    job: KnowledgeJobRecord,
    projectId: string,
    leaseMonitor: LeaseMonitor,
  ): Promise<KnowledgeJobRecord> {
    if (job.projectId !== projectId) {
      throw new KnowledgeWorkerLeaseLostError(
        `Knowledge job ${job.id} does not belong to project ${projectId}`,
      );
    }
    if (job.jobKind !== 'analyze') {
      throw new KnowledgeWorkerUnsupportedJobError(job.jobKind);
    }

    const sourceVersionId = this.resolveSourceVersionId(job);
    const loaded = this.sourceLoader.load({
      projectId,
      sourceVersionId,
      maxBytes: this.maxSourceBytes,
    });
    this.guardDurableStage(job.id, projectId, leaseMonitor);
    this.queue.recordProgress(job.id, 'loading', 1, 6, {
      sourceVersionId: loaded.sourceVersionId,
      sourcePath: loaded.sourcePath ?? loaded.contentPath,
    });
    this.guardDurableStage(job.id, projectId, leaseMonitor);

    const analyzer = this.requireAnalyzer(loaded);
    const extraction = await this.analyzeSource(analyzer, loaded);
    this.guardDurableStage(job.id, projectId, leaseMonitor);
    this.queue.recordProgress(job.id, 'analyzing', 2, 6, {
      analyzerId: extraction.analyzerId,
      analyzerVersion: extraction.analyzerVersion,
      diagnostics: extraction.diagnostics.length,
    });
    this.guardDurableStage(job.id, projectId, leaseMonitor);

    const savedExtraction = this.persistExtraction(projectId, extraction);
    this.guardDurableStage(job.id, projectId, leaseMonitor);
    this.queue.recordProgress(job.id, 'persisting', 3, 6, {
      extractionId: savedExtraction.id,
      sectionCount: savedExtraction.sections.length,
    });
    this.guardDurableStage(job.id, projectId, leaseMonitor);

    const graphResult = this.materializeGraph(loaded, extraction);
    this.guardDurableStage(job.id, projectId, leaseMonitor);
    this.queue.recordProgress(job.id, 'graph', 4, 6, {
      nodeCount: graphResult.nodeIds.length,
      edgeCount: graphResult.edgeIds.length,
    });
    this.guardDurableStage(job.id, projectId, leaseMonitor);

    const payload = this.pageBuilder({
      projectId,
      sourceId: loaded.sourceId,
      sourceVersionId: loaded.sourceVersionId,
      sourcePath: loaded.sourcePath,
      extraction,
    });
    const generation = await this.generatePages(job.id, payload);
    this.guardDurableStage(job.id, projectId, leaseMonitor);
    this.queue.recordProgress(job.id, 'generating', 5, 6, {
      pageCount: generation.pages.length,
      pageVersionIds: generation.pages.map((page) => page.id).slice(0, MAX_PAGE_VERSION_IDS),
    });
    this.guardDurableStage(job.id, projectId, leaseMonitor);

    const enrichment = await this.runOptionalEnrichment({
      projectId,
      jobId: job.id,
      sourceId: loaded.sourceId,
      sourceVersionId: loaded.sourceVersionId,
      sourcePath: loaded.sourcePath,
      extraction,
      pageVersionIds: generation.pages.map((page) => page.id),
    });
    this.guardDurableStage(job.id, projectId, leaseMonitor);
    const groundedEnrichment = this.groundEnrichment(
      projectId,
      loaded.sourcePath,
      generation.pages.map((page) => page.id),
      enrichment,
    );
    const enrichmentWarnings = this.applyOptionalEnrichment(projectId, groundedEnrichment);
    this.guardDurableStage(job.id, projectId, leaseMonitor);
    const warnings = uniqueWarnings([
      ...summarizeDiagnostics(extraction),
      ...enrichmentWarnings,
    ]);
    const processingMode: KnowledgeJobResult['processingMode'] =
      enrichment.enriched && enrichmentWarnings.every((warning) => warning.code !== 'enrichment_failed')
        ? 'enriched'
        : 'deterministic';
    const result: KnowledgeJobResult = {
      processingMode,
      analyzerId: extraction.analyzerId,
      analyzerVersion: extraction.analyzerVersion,
      extractionId: savedExtraction.id,
      pageVersionIds: generation.pages.map((page) => page.id).slice(0, MAX_PAGE_VERSION_IDS),
      graphNodeCount: graphResult.nodeIds.length,
      graphEdgeCount: graphResult.edgeIds.length,
      warnings,
    };
    const completionProgress: KnowledgeTerminalProgressInput = {
      stage: 'completed',
      completedUnits: 6,
      totalUnits: 6,
      detail: {
        pageCount: generation.pages.length,
        warningCount: warnings.length,
        processingMode,
      },
    };
    return this.completeOwnedJob(job.id, projectId, leaseMonitor, result, completionProgress);
  }

  private completeOwnedJob(
    jobId: string,
    projectId: string,
    leaseMonitor: LeaseMonitor,
    result: KnowledgeJobResult,
    progress: KnowledgeTerminalProgressInput,
  ): KnowledgeJobRecord {
    this.guardDurableStage(jobId, projectId, leaseMonitor);
    try {
      return this.queue.complete(jobId, this.workerId, result, { progress });
    } catch (error) {
      if (error instanceof KnowledgeQueueTransitionError) {
        throw new KnowledgeWorkerLeaseLostError(error.message);
      }
      throw error;
    }
  }

  private groundEnrichment(
    projectId: string,
    sourcePath: string | null,
    pageVersionIds: readonly string[],
    outcome: KnowledgeEnrichmentOutcome,
  ): KnowledgeEnrichmentOutcome {
    const scope = this.loadEnrichmentScope(projectId, sourcePath, pageVersionIds);
    const warnings = [...outcome.warnings];
    const reviews: KnowledgeEnrichmentReviewInput[] = [];
    for (const review of outcome.reviews) {
      if (review.pageVersionId != null && !scope.pageVersionIds.has(review.pageVersionId)) {
        warnings.push({
          code: 'enrichment_ungrounded',
          message: 'Skipped enrichment output outside the current run scope.',
        });
        continue;
      }
      reviews.push(review);
    }

    const insights: KnowledgeEnrichmentInsightInput[] = [];
    for (const insight of outcome.insights) {
      if (!scope.contentPaths.has(insight.contentPath.trim())) {
        warnings.push({
          code: 'enrichment_ungrounded',
          message: 'Skipped enrichment output outside the current run scope.',
        });
        continue;
      }
      insights.push(insight);
    }

    return {
      ...outcome,
      warnings: uniqueWarnings(warnings),
      reviews,
      insights,
    };
  }

  private loadEnrichmentScope(
    projectId: string,
    sourcePath: string | null,
    pageVersionIds: readonly string[],
  ): KnowledgeEnrichmentScope {
    const contentPaths = new Set<string>();
    if (sourcePath !== null && sourcePath.trim().length > 0) {
      contentPaths.add(sourcePath.trim());
    }
    const scopedPageVersionIds = new Set<string>();
    if (pageVersionIds.length > 0) {
      const placeholders = pageVersionIds.map(() => '?').join(', ');
      const rows = this.db.prepare(
        `SELECT id, content_path
         FROM knowledge_page_versions
         WHERE project_id = ? AND id IN (${placeholders})`,
      ).all(projectId, ...pageVersionIds) as Array<{ id: string; content_path: string }>;
      for (const row of rows) {
        scopedPageVersionIds.add(row.id);
        contentPaths.add(row.content_path);
      }
    }
    return {
      pageVersionIds: scopedPageVersionIds,
      contentPaths,
    };
  }

  private resolveSourceVersionId(job: KnowledgeJobRecord): string {
    if (job.sourceVersionId) {
      return job.sourceVersionId;
    }
    const payloadValue = job.payload.sourceVersionId;
    if (typeof payloadValue === 'string' && payloadValue.trim().length > 0) {
      return payloadValue;
    }
    throw new KnowledgeSourceVersionLoadError('source_version_missing', `Knowledge source version missing for job ${job.id}`);
  }

  private requireAnalyzer(loaded: LoadedKnowledgeSourceVersion): DeterministicAnalyzer {
    try {
      return this.analyzers.require({
        sourceKind: loaded.sourceKind,
        sourcePath: loaded.sourcePath,
        mimeType: loaded.mimeType,
      });
    } catch (error) {
      throw new KnowledgeWorkerUnsupportedJobError(loaded.mimeType ?? loaded.sourcePath ?? loaded.sourceKind);
    }
  }

  private async analyzeSource(
    analyzer: DeterministicAnalyzer,
    loaded: LoadedKnowledgeSourceVersion,
  ): Promise<DeterministicExtraction> {
    try {
      return await analyzer.analyze({
        sourceVersionId: loaded.sourceVersionId,
        sourceKind: loaded.sourceKind,
        sourcePath: loaded.sourcePath,
        mimeType: loaded.mimeType,
        content: loaded.content,
      });
    } catch (error) {
      throw new KnowledgeWorkerStageError('analyzer_failed', asErrorMessage(error), { cause: error });
    }
  }

  private persistExtraction(projectId: string, extraction: DeterministicExtraction) {
    try {
      return this.extractionStore.save({ projectId, extraction, extractorKind: 'deterministic', completedAt: this.now() });
    } catch (error) {
      throw new KnowledgeWorkerStageError('extraction_persist_failed', asErrorMessage(error), { cause: error });
    }
  }

  private materializeGraph(loaded: LoadedKnowledgeSourceVersion, extraction: DeterministicExtraction) {
    try {
      return this.graphMaterializer.materialize({
        projectId: loaded.projectId,
        sourceId: loaded.sourceId,
        sourceVersionId: loaded.sourceVersionId,
        extraction,
      });
    } catch (error) {
      throw new KnowledgeWorkerStageError('graph_persist_failed', asErrorMessage(error), { cause: error });
    }
  }

  private async generatePages(jobId: string, payload: KnowledgeGenerationPayload): Promise<KnowledgeGenerationResult> {
    try {
      return await this.generator.runKnowledgeGeneration(jobId, payload, { completeJob: false });
    } catch (error) {
      throw new KnowledgeWorkerStageError('generation_failed', asErrorMessage(error), { cause: error });
    }
  }

  private async runOptionalEnrichment(
    input: KnowledgeEnrichmentInput,
  ): Promise<KnowledgeEnrichmentOutcome> {
    if (!this.enrich) {
      return { enriched: false, warnings: [], reviews: [], insights: [] };
    }
    try {
      const result = await this.enrich.enrich({ ...input, signal: this.signal });
      if (this.signal?.aborted) {
        throw new KnowledgeWorkerCancelledError();
      }
      if (!result) {
        return { enriched: false, warnings: [], reviews: [], insights: [] };
      }
      const normalizedReviews = this.normalizeEnrichmentReviews(result.reviews ?? []);
      const normalizedInsights = this.normalizeEnrichmentInsights(result.insights ?? []);
      const combinedWarnings = uniqueWarnings([
        ...(result.warnings ?? []),
        ...normalizedReviews.warnings,
        ...normalizedInsights.warnings,
      ]);
      const producedDurableEnrichment =
        normalizedReviews.items.length > 0 ||
        normalizedInsights.items.length > 0 ||
        combinedWarnings.length === 0;
      return {
        enriched: producedDurableEnrichment,
        warnings: combinedWarnings,
        reviews: normalizedReviews.items,
        insights: normalizedInsights.items,
      };
    } catch (error) {
      if (isAbortError(error) || this.signal?.aborted) {
        throw new KnowledgeWorkerCancelledError();
      }
      return {
        enriched: false,
        warnings: [
          {
            code: 'enrichment_failed',
            message: boundRedactedMessage(asErrorMessage(error), MAX_WARNING_MESSAGE_LENGTH),
          },
        ],
        reviews: [],
        insights: [],
      };
    }
  }

  private applyOptionalEnrichment(
    projectId: string,
    outcome: KnowledgeEnrichmentOutcome,
  ): KnowledgeJobResultWarning[] {
    const warnings = [...outcome.warnings];
    for (const [index, review] of outcome.reviews.entries()) {
      try {
        this.ensureReview(projectId, review.pageVersionId ?? null, review.summary);
      } catch (error) {
        warnings.push(enrichmentItemWarning('enrichment_review_failed', index, asErrorMessage(error)));
      }
    }
    for (const [index, insight] of outcome.insights.entries()) {
      try {
        this.ensureInsight(projectId, insight);
      } catch (error) {
        warnings.push(enrichmentItemWarning('enrichment_insight_failed', index, asErrorMessage(error)));
      }
    }
    return uniqueWarnings(warnings);
  }

  private ensureReview(projectId: string, pageVersionId: string | null, summary: string): string {
    return ensurePendingKnowledgeReview(this.db, {
      projectId,
      ...(pageVersionId === null ? {} : { pageVersionId }),
      summary: boundRedactedMessage(summary, MAX_WARNING_MESSAGE_LENGTH),
      requestedAt: this.now(),
    }).id;
  }

  private ensureInsight(projectId: string, insight: KnowledgeEnrichmentInsightInput): string {
    const type = boundRedactedMessage(requireNonEmptyString(insight.type, 'insight type'), MAX_ENRICHMENT_TYPE_LENGTH);
    const contentPath = boundRedactedMessage(insight.contentPath, MAX_WARNING_MESSAGE_LENGTH);
    const confidence = Math.max(0, Math.min(1, insight.confidence));
    const id = createKnowledgeId('insight', `${projectId}:${type}:${contentPath}`);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO knowledge_insights
         (id, project_id, graph_snapshot_id, insight_type, content_path, confidence, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(id, projectId, type, contentPath, confidence, this.now());
    return id;
  }

  private normalizeEnrichmentReviews(
    reviews: readonly KnowledgeEnrichmentReviewInput[],
  ): NormalizedEnrichmentItems<KnowledgeEnrichmentReviewInput> {
    const deduped = new Map<string, KnowledgeEnrichmentReviewInput>();
    const warnings: KnowledgeJobResultWarning[] = [];
    for (const [index, review] of reviews.slice(0, MAX_ENRICHMENT_ITEMS).entries()) {
      let summary: string;
      try {
        summary = boundRedactedMessage(requireNonEmptyString(review.summary, 'review summary'), MAX_WARNING_MESSAGE_LENGTH);
      } catch (error) {
        warnings.push(enrichmentItemWarning('enrichment_invalid_review', index, asErrorMessage(error)));
        continue;
      }
      let pageVersionId: string | null = null;
      try {
        pageVersionId = review.pageVersionId == null
          ? null
          : boundRedactedMessage(requireNonEmptyString(review.pageVersionId, 'review pageVersionId'), MAX_WARNING_MESSAGE_LENGTH);
      } catch (error) {
        warnings.push(enrichmentItemWarning('enrichment_invalid_review', index, asErrorMessage(error)));
        continue;
      }
      const key = `${pageVersionId ?? 'project'}\0${summary}`;
      if (!deduped.has(key)) {
        deduped.set(key, { pageVersionId, summary });
      }
    }
    return {
      items: [...deduped.values()],
      warnings: uniqueWarnings(warnings),
    };
  }

  private normalizeEnrichmentInsights(
    insights: readonly KnowledgeEnrichmentInsightInput[],
  ): NormalizedEnrichmentItems<KnowledgeEnrichmentInsightInput> {
    const deduped = new Map<string, KnowledgeEnrichmentInsightInput>();
    const warnings: KnowledgeJobResultWarning[] = [];
    for (const [index, insight] of insights.slice(0, MAX_ENRICHMENT_ITEMS).entries()) {
      let type: string;
      let contentPath: string;
      try {
        type = boundRedactedMessage(
          requireNonEmptyString(insight.type, 'insight type'),
          MAX_ENRICHMENT_TYPE_LENGTH,
        );
        contentPath = boundRedactedMessage(
          requireNonEmptyString(insight.contentPath, 'insight contentPath'),
          MAX_WARNING_MESSAGE_LENGTH,
        );
      } catch (error) {
        warnings.push(enrichmentItemWarning('enrichment_invalid_insight', index, asErrorMessage(error)));
        continue;
      }
      if (!Number.isFinite(insight.confidence)) {
        warnings.push(enrichmentItemWarning('enrichment_invalid_insight', index, 'Knowledge worker insight confidence must be finite'));
        continue;
      }
      const confidence = Math.max(0, Math.min(1, insight.confidence));
      const key = `${type}\0${contentPath}`;
      if (!deduped.has(key)) {
        deduped.set(key, { type, contentPath, confidence });
      }
    }
    return {
      items: [...deduped.values()],
      warnings: uniqueWarnings(warnings),
    };
  }

  private startLeaseMonitor(jobId: string): LeaseMonitor {
    const leaseDurationMs = this.queue.getLeaseDurationMs();
    const configuredInterval = this.leaseRenewIntervalMs ?? Number.POSITIVE_INFINITY;
    const intervalMs = Math.max(10, Math.min(leaseDurationMs / 3, configuredInterval));
    let stopped = false;
    let capturedError: KnowledgeWorkerLeaseLostError | null = null;
    const timer = setInterval(() => {
      if (stopped || capturedError !== null || this.signal?.aborted) {
        return;
      }
      try {
        this.queue.renewLease(jobId, this.workerId);
      } catch (error) {
        capturedError = new KnowledgeWorkerLeaseLostError(
          `Knowledge job lease lost for ${jobId}: ${asErrorMessage(error)}`,
        );
      }
    }, Math.max(10, Math.trunc(intervalMs)));

    return {
      stop: () => {
        if (stopped) {
          return;
        }
        stopped = true;
        clearInterval(timer);
      },
      check: () => {
        if (capturedError) {
          throw capturedError;
        }
      },
    };
  }

  private guardDurableStage(jobId: string, projectId: string, leaseMonitor: LeaseMonitor): KnowledgeJobRecord {
    if (this.signal?.aborted) {
      throw new KnowledgeWorkerCancelledError();
    }
    leaseMonitor.check();
    const current = this.queue.get(jobId);
    if (!current) {
      throw new KnowledgeWorkerLeaseLostError(`Knowledge job not found: ${jobId}`);
    }
    if (current.projectId !== projectId) {
      throw new KnowledgeWorkerLeaseLostError(`Knowledge job ${jobId} no longer belongs to project ${projectId}`);
    }
    if (current.status !== 'running' || current.workerId !== this.workerId) {
      throw new KnowledgeWorkerLeaseLostError(`Knowledge job ${jobId} is no longer owned by worker ${this.workerId}`);
    }
    if (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) <= Date.parse(this.now())) {
      throw new KnowledgeWorkerLeaseLostError(`Knowledge job lease expired for ${jobId}`);
    }
    return current;
  }

  private requireOwnedRunningJob(projectId: string, jobId: string): KnowledgeJobRecord {
    const scopedJobId = requireNonEmptyString(jobId, 'job ID');
    const job = this.queue.get(scopedJobId);
    if (!job) {
      throw new Error(`Knowledge job not found: ${scopedJobId}`);
    }
    if (job.projectId !== projectId) {
      throw new Error(`Knowledge job ${scopedJobId} does not belong to project ${projectId}`);
    }
    if (job.status !== 'running' || job.workerId !== this.workerId) {
      throw new Error(`Knowledge job ${scopedJobId} is not owned by ${this.workerId}`);
    }
    return job;
  }

  private failIfOwned(
    jobId: string,
    projectId: string,
    code: KnowledgeWorkerFailureCode,
    message: string,
  ): KnowledgeJobRecord | null {
    const current = this.queue.get(jobId);
    if (
      !current ||
      current.projectId !== projectId ||
      current.status !== 'running' ||
      current.workerId !== this.workerId ||
      current.leaseExpiresAt === null ||
      Date.parse(current.leaseExpiresAt) <= Date.parse(this.now())
    ) {
      return null;
    }
    try {
      return this.queue.fail(jobId, code, message, this.workerId);
    } catch (error) {
      if (error instanceof KnowledgeQueueTransitionError) {
        return null;
      }
      throw error;
    }
  }

  private cancelIfOwned(jobId: string, projectId: string): KnowledgeJobRecord | null {
    const current = this.queue.get(jobId);
    if (
      !current ||
      current.projectId !== projectId ||
      current.status !== 'running' ||
      current.workerId !== this.workerId ||
      current.leaseExpiresAt === null ||
      Date.parse(current.leaseExpiresAt) <= Date.parse(this.now())
    ) {
      return null;
    }
    try {
      return this.queue.cancelOwned(jobId, this.workerId);
    } catch (error) {
      if (error instanceof KnowledgeQueueTransitionError) {
        return null;
      }
      throw error;
    }
  }

  private runWarnings(job: KnowledgeJobRecord): KnowledgeWorkerWarning[] {
    return (job.result?.warnings ?? []).map((warning) => ({
      jobId: job.id,
      code: warning.code,
      message: warning.message,
    }));
  }
}
