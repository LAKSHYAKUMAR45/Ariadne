import type Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDefaultAnalyzerRegistry, type AnalyzerRegistry } from './analyzers/AnalyzerRegistry.js';
import { createKnowledgeId, normalizeKnowledgePath } from './KnowledgeIds.js';
import { KnowledgeGraphReporter, type KnowledgeGraphReportingService } from './KnowledgeGraphReporting.js';
import {
  KnowledgeFreshnessStore,
  boundedFreshnessMessage,
  type KnowledgeFreshnessState,
  type KnowledgeWatcherStatus,
} from './KnowledgeFreshnessStore.js';
import { KnowledgeProjectStore, type KnowledgeProject } from './KnowledgeProjectStore.js';
import {
  KnowledgeQueue,
  type KnowledgeJobRecord,
  type KnowledgeRequeueContext,
  type KnowledgeRequeueReason,
} from './KnowledgeQueue.js';
import { KnowledgeReconciliation } from './KnowledgeReconciliation.js';
import { KnowledgeSearchIndex } from './KnowledgeSearchIndex.js';
import { scanKnowledgeSources } from './KnowledgeSourceScanner.js';
import { storeImmutableKnowledgeSourceContent } from './KnowledgeSourceContentStore.js';
import {
  KnowledgeSourceStore,
  KnowledgeSourceVersionRevertError,
  computeSourceVersion,
  type KnowledgeSourceVersionRecord,
} from './KnowledgeSourceStore.js';
import type { KnowledgeSourceId } from './KnowledgeTypes.js';
import { sourceIdentitySeed } from './SourceIdentity.js';
import type { SourcePolicy } from './SourcePolicy.js';
import {
  KnowledgeFreshnessWatchLoop,
  type KnowledgeFreshnessWatcherFactory,
  type KnowledgeFreshnessWatchOptions,
} from './KnowledgeFreshnessWatch.js';

export type { KnowledgeFreshnessWatchOptions, KnowledgeFreshnessWatcherFactory } from './KnowledgeFreshnessWatch.js';

export type KnowledgeFreshnessReason = 'startup' | 'manual' | 'watch-event' | 'periodic-rescan' | 'watch-recovery';

export interface KnowledgeFreshnessRunResult {
  projectId: string;
  reason: KnowledgeFreshnessReason;
  registeredSources: number;
  newVersions: number;
  enqueuedJobs: number;
  requeuedJobs: number;
  unchangedSources: number;
  missingSources: number;
  failedSources: number;
  /** Jobs whose expired lease was cleared by this pass (startup and watch-recovery only). */
  recoveredLeases: number;
  /** Bounded, redacted, non-fatal notes such as unreadable files or a failed report hook. */
  warnings: string[];
}

export interface KnowledgeFreshnessStatus {
  projectId: string;
  watcherStatus: KnowledgeWatcherStatus;
  generation: number;
  lastScanAt: string | null;
  lastSuccessfulScanAt: string | null;
  pendingCount: number;
  failedCount: number;
  missingCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface KnowledgeFreshnessServiceOptions {
  now?: () => string;
  queue?: KnowledgeQueue;
  analyzers?: Pick<AnalyzerRegistry, 'resolve'>;
  graphReporter?: Pick<KnowledgeGraphReportingService, 'buildCompletenessReport'>;
  watcherFactory?: KnowledgeFreshnessWatcherFactory;
  /** Same size policy as manual ingestion; unset means no size limit. */
  maxBytes?: number;
}

interface Scope {
  roots: string[];
  absoluteRoots: string[];
  covers(sourcePath: string): boolean;
}

interface ObservedFile {
  path: string;
  hash: string;
  content: string;
  contentPath: string;
}

interface ObservedScan {
  files: ObservedFile[];
  unreadable: string[];
  observedPaths: Set<string>;
}

interface RequeueDecision {
  reason: KnowledgeRequeueReason;
  context?: KnowledgeRequeueContext;
}

const ANALYZE_JOB_KIND = 'analyze';
const RECOVERY_REASONS: readonly KnowledgeFreshnessReason[] = ['manual', 'startup', 'watch-recovery'];
const MAX_WARNINGS = 8;

function stateForJob(job: KnowledgeJobRecord): KnowledgeFreshnessState {
  if (job.status === 'completed') return 'fresh';
  if (job.status === 'failed') return 'failed';
  return 'pending';
}

function createScope(project: KnowledgeProject): Scope {
  const roots = project.roots;
  return {
    roots,
    absoluteRoots: roots.length === 0 ? [project.workspaceRoot] : roots.map((root) => path.resolve(project.workspaceRoot, root)),
    covers: (sourcePath) =>
      roots.length === 0 || roots.some((root) => sourcePath === root || sourcePath.startsWith(`${root}/`)),
  };
}

/** Reconciles the filesystem against knowledge source state and supervises watcher recovery for a project. */
export class KnowledgeFreshnessService {
  private readonly now: () => string;
  private readonly queue: KnowledgeQueue;
  private readonly analyzers: Pick<AnalyzerRegistry, 'resolve'>;
  private readonly graphReporter: Pick<KnowledgeGraphReportingService, 'buildCompletenessReport'>;
  private readonly store: KnowledgeFreshnessStore;
  private readonly sources: KnowledgeSourceStore;
  private readonly projects: KnowledgeProjectStore;
  private readonly maxBytes: number | undefined;
  private readonly watcherFactory: KnowledgeFreshnessWatcherFactory | undefined;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeFreshnessServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.queue = options.queue ?? new KnowledgeQueue(db, { now: this.now });
    this.analyzers = options.analyzers ?? createDefaultAnalyzerRegistry();
    this.graphReporter = options.graphReporter ?? new KnowledgeGraphReporter(db, { now: this.now });
    this.store = new KnowledgeFreshnessStore(db, { now: this.now });
    this.sources = new KnowledgeSourceStore(db);
    this.projects = new KnowledgeProjectStore(db);
    this.maxBytes = options.maxBytes;
    this.watcherFactory = options.watcherFactory;
  }

  public getStatus(projectId: string): KnowledgeFreshnessStatus {
    const watcher = this.store.getWatcher(projectId);
    const counts = this.store.countByState(projectId);
    return {
      projectId,
      watcherStatus: watcher.status,
      generation: watcher.generation,
      lastScanAt: watcher.lastScanAt,
      lastSuccessfulScanAt: watcher.lastSuccessfulScanAt,
      pendingCount: counts.pending,
      failedCount: counts.failed,
      missingCount: counts.missing,
      lastErrorCode: watcher.lastErrorCode,
      lastErrorMessage: watcher.lastErrorMessage,
    };
  }

  public watchProject(projectId: string, options: KnowledgeFreshnessWatchOptions = {}): Promise<void> {
    const project = this.requireProject(projectId);
    const scope = createScope(project);
    return new KnowledgeFreshnessWatchLoop({
      projectId: project.id,
      roots: scope.absoluteRoots,
      policy: { workspaceRoot: project.workspaceRoot, maxBytes: this.maxBytes },
      options,
      store: this.store,
      factory: this.watcherFactory,
      now: this.now,
      privateRoots: [project.workspaceRoot],
      refresh: (reason) => this.refreshProject(project.id, reason),
    }).run();
  }

  /** Async because the shared source scanner is. */
  public async refreshProject(projectId: string, reason: KnowledgeFreshnessReason): Promise<KnowledgeFreshnessRunResult> {
    const project = this.requireProject(projectId);
    const scope = createScope(project);
    let scan: ObservedScan;
    try {
      scan = await this.scan(project, scope);
    } catch (error) {
      this.recordFailure(project, 'scan_failed', error);
      throw error;
    }
    let outcome: { result: KnowledgeFreshnessRunResult; changed: boolean };
    try {
      outcome = this.db.transaction(() => this.applyScan(project, scope, scan, reason))();
    } catch (error) {
      this.recordFailure(project, 'refresh_failed', error);
      throw error;
    }
    if (outcome.changed) this.refreshReport(project.id, outcome.result.warnings);
    return outcome.result;
  }

  private requireProject(projectId: string): KnowledgeProject {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Knowledge project not found: ${projectId}`);
    return project;
  }

  private recordFailure(project: KnowledgeProject, code: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.store.updateWatcher(project.id, {
      lastScanAt: this.now(),
      lastErrorCode: code,
      lastErrorMessage: boundedFreshnessMessage(message, [project.workspaceRoot]),
    });
  }

  private async scan(project: KnowledgeProject, scope: Scope): Promise<ObservedScan> {
    const policy: SourcePolicy = { workspaceRoot: project.workspaceRoot, maxBytes: this.maxBytes };
    const candidates = new Map<string, { path: string; absolutePath: string }>();
    for (const root of scope.absoluteRoots) {
      for (const candidate of await scanKnowledgeSources(root, policy)) {
        if (!candidates.has(candidate.path)) candidates.set(candidate.path, candidate);
      }
    }
    const scanResult: ObservedScan = { files: [], unreadable: [], observedPaths: new Set(candidates.keys()) };
    for (const candidate of [...candidates.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      try {
        const stats = await fs.lstat(candidate.absolutePath);
        if (!stats.isFile()) throw new Error('not a regular file');
        const content = await fs.readFile(candidate.absolutePath, 'utf8');
        const hash = computeSourceVersion(content).hash;
        scanResult.files.push({ path: candidate.path, hash, content, contentPath: this.contentPathFor(project, candidate.path, hash, content) });
      } catch {
        scanResult.unreadable.push(candidate.path);
      }
    }
    return scanResult;
  }

  private contentPathFor(project: KnowledgeProject, sourcePath: string, hash: string, content: string): string {
    const existing = this.db
      .prepare(
        `SELECT content_path FROM knowledge_source_versions
         WHERE project_id = ? AND source_id = ? AND content_hash = ?`,
      )
      .get(project.id, this.sourceIdFor(project.id, sourcePath), hash) as { content_path: string } | undefined;
    return existing?.content_path ?? storeImmutableKnowledgeSourceContent(project.workspaceRoot, sourcePath, content);
  }

  private sourceIdFor(projectId: string, sourcePath: string): KnowledgeSourceId {
    return createKnowledgeId('source', sourceIdentitySeed(projectId, 'file', normalizeKnowledgePath(sourcePath))) as KnowledgeSourceId;
  }

  private applyScan(
    project: KnowledgeProject,
    scope: Scope,
    scan: ObservedScan,
    reason: KnowledgeFreshnessReason,
  ): { result: KnowledgeFreshnessRunResult; changed: boolean } {
    const timestamp = this.now();
    const result: KnowledgeFreshnessRunResult = {
      projectId: project.id,
      reason,
      registeredSources: 0,
      newVersions: 0,
      enqueuedJobs: 0,
      requeuedJobs: 0,
      unchangedSources: 0,
      missingSources: 0,
      failedSources: 0,
      recoveredLeases: 0,
      warnings: [],
    };
    if (reason === 'startup' || reason === 'watch-recovery') {
      const recovered = this.queue.recoverExpiredKnowledgeJobsSummary(project.id);
      result.recoveredLeases = recovered.requeuedIds.length + recovered.failedIds.length;
    }
    let changed = false;
    for (const file of scan.files) {
      changed = this.applyFile(project, file, reason, timestamp, result) || changed;
    }
    for (const unreadable of scan.unreadable) {
      result.failedSources += 1;
      this.warn(result.warnings, `Skipped unreadable source ${unreadable}`);
    }
    const newlyMissing = this.applyMissing(project, scope, scan.observedPaths, timestamp, result);
    const watcher = this.store.getWatcher(project.id);
    const scanErrorCleared = watcher.lastErrorCode === 'scan_failed' || watcher.lastErrorCode === 'refresh_failed';
    this.store.updateWatcher(project.id, {
      lastScanAt: timestamp,
      lastSuccessfulScanAt: timestamp,
      ...(reason === 'watch-event' ? { lastEventAt: timestamp } : {}),
      ...(scanErrorCleared ? { lastErrorCode: null, lastErrorMessage: null } : {}),
    });
    return { result, changed: changed || newlyMissing };
  }

  private applyFile(
    project: KnowledgeProject,
    file: ObservedFile,
    reason: KnowledgeFreshnessReason,
    timestamp: string,
    result: KnowledgeFreshnessRunResult,
  ): boolean {
    const sourceId = this.sourceIdFor(project.id, file.path);
    const before = this.sources.get(project.id, sourceId);
    const versionsBefore = before ? this.sources.listVersions(project.id, sourceId) : [];
    try {
      this.sources.register({
        projectId: project.id,
        kind: 'file',
        path: file.path,
        content: file.content,
        contentPath: file.contentPath,
      });
    } catch (error) {
      return this.recordRegisterFailure(project, sourceId, file, versionsBefore.at(-1), timestamp, result, error);
    }

    const versions = this.sources.listVersions(project.id, sourceId);
    const latest = versions.at(-1) as KnowledgeSourceVersionRecord;
    const newVersion = latest.id !== versionsBefore.at(-1)?.id;
    const restored = before !== null && before.deletedAt !== null && !newVersion;
    if (!before) result.registeredSources += 1;
    if (newVersion) result.newVersions += 1;
    if (before && newVersion) new KnowledgeSearchIndex(this.db, { now: this.now }).markSourceStale(project.id, sourceId);

    const existingJob = this.findAnalyzeJob(project.id, latest.id);
    let job = this.queue.enqueue({
      projectId: project.id,
      jobKind: ANALYZE_JOB_KIND,
      sourceVersionId: latest.id,
      payload: { sourceId, sourceVersionId: latest.id, path: file.path },
    });
    let requeued = false;
    if (existingJob === null) {
      result.enqueuedJobs += 1;
    } else {
      const decision = this.requeueDecision(job, reason, restored, file.path, latest);
      const updated = decision ? this.queue.requeueAnalyze(job.id, decision.reason, decision.context) : null;
      if (updated) {
        job = updated;
        requeued = true;
        result.requeuedJobs += 1;
      }
    }

    const state = stateForJob(job);
    if (state === 'failed') result.failedSources += 1;
    const eventKind = !before ? 'created' : newVersion ? 'changed' : restored ? 'restored' : undefined;
    this.store.upsertSource({
      projectId: project.id,
      sourceId,
      state,
      currentSourceVersionId: latest.id,
      lastObservedHash: file.hash,
      lastScanAt: timestamp,
      ...(eventKind ? { lastEventKind: eventKind, lastEventAt: timestamp } : {}),
      lastEnqueuedJobId: job.id,
      lastErrorCode: state === 'failed' ? (job.failureCode ?? 'job_failed') : null,
      lastErrorMessage: state === 'failed' ? job.failureMessage : null,
    });
    const changed = existingJob === null || newVersion || restored || requeued;
    if (!changed) result.unchangedSources += 1;
    return changed;
  }

  private recordRegisterFailure(
    project: KnowledgeProject,
    sourceId: KnowledgeSourceId,
    file: ObservedFile,
    latestBefore: KnowledgeSourceVersionRecord | undefined,
    timestamp: string,
    result: KnowledgeFreshnessRunResult,
    error: unknown,
  ): boolean {
    result.failedSources += 1;
    const code = error instanceof KnowledgeSourceVersionRevertError ? 'source_version_reverted' : 'source_register_failed';
    if (!latestBefore) {
      this.warn(result.warnings, `Could not register ${file.path}: ${code}`);
      return false;
    }
    this.store.upsertSource({
      projectId: project.id,
      sourceId,
      state: 'failed',
      currentSourceVersionId: latestBefore.id,
      lastObservedHash: file.hash,
      lastScanAt: timestamp,
      lastErrorCode: code,
      lastErrorMessage: boundedFreshnessMessage(error instanceof Error ? error.message : String(error), [project.workspaceRoot]),
    });
    return false;
  }

  private applyMissing(
    project: KnowledgeProject,
    scope: Scope,
    observedPaths: Set<string>,
    timestamp: string,
    result: KnowledgeFreshnessRunResult,
  ): boolean {
    const rows = this.db
      .prepare(
        `SELECT id, source_path, status FROM knowledge_sources
         WHERE project_id = ? AND source_kind = 'file' AND source_path IS NOT NULL
         ORDER BY source_path`,
      )
      .all(project.id) as Array<{ id: string; source_path: string; status: string }>;
    const reconciliation = new KnowledgeReconciliation(this.db, { now: this.now });
    let newlyMissing = false;
    for (const row of rows) {
      if (observedPaths.has(row.source_path) || !scope.covers(row.source_path)) continue;
      const sourceId = row.id as KnowledgeSourceId;
      if (row.status === 'active') {
        reconciliation.reconcileDeletedSource(sourceId);
        newlyMissing = true;
      }
      const current = this.store.getSource(project.id, sourceId);
      const latest = this.sources.listVersions(project.id, sourceId).at(-1);
      this.store.upsertSource({
        projectId: project.id,
        sourceId,
        state: 'missing',
        currentSourceVersionId: latest?.id ?? null,
        lastObservedHash: current?.lastObservedHash ?? null,
        lastScanAt: timestamp,
        ...(current?.state === 'missing' ? {} : { lastEventKind: 'deleted', lastEventAt: timestamp }),
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      result.missingSources += 1;
    }
    return newlyMissing;
  }

  private findAnalyzeJob(projectId: string, sourceVersionId: string): string | null {
    const row = this.db
      .prepare(`SELECT id FROM knowledge_jobs WHERE project_id = ? AND job_kind = ? AND source_version_id = ?`)
      .get(projectId, ANALYZE_JOB_KIND, sourceVersionId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private requeueDecision(
    job: KnowledgeJobRecord,
    reason: KnowledgeFreshnessReason,
    restored: boolean,
    sourcePath: string,
    version: KnowledgeSourceVersionRecord,
  ): RequeueDecision | null {
    switch (job.status) {
      case 'failed':
        return reason === 'manual' ? { reason: 'manual' } : null;
      case 'cancelled':
        return RECOVERY_REASONS.includes(reason) ? { reason: 'cancelled_recovery' } : null;
      case 'completed':
        return restored ? { reason: 'manual' } : this.analyzerDecision(job, sourcePath, version);
      default:
        return null;
    }
  }

  private analyzerDecision(
    job: KnowledgeJobRecord,
    sourcePath: string,
    version: KnowledgeSourceVersionRecord,
  ): RequeueDecision | null {
    const resolution = this.analyzers.resolve({ sourceKind: 'file', sourcePath, mimeType: version.mimeType });
    if (resolution.kind !== 'supported' || !job.result) return null;
    const { id, version: analyzerVersion } = resolution.analyzer;
    const target = `${id}@${analyzerVersion}`;
    const reason = this.triggerFor(job, id, analyzerVersion);
    if (!reason) return null;
    const alreadyRequeued = this.queue
      .listRequeueEvents(job.id)
      .some((event) => event.reason === reason && event.targetAnalyzer === target);
    return alreadyRequeued ? null : { reason, context: { analyzerId: id, analyzerVersion } };
  }

  private triggerFor(job: KnowledgeJobRecord, analyzerId: string, analyzerVersion: string): KnowledgeRequeueReason | null {
    const result = job.result;
    if (!result) return null;
    if (result.resultKind === 'coverage_only') return 'coverage_adapter_available';
    return result.analyzerId !== analyzerId || result.analyzerVersion !== analyzerVersion ? 'analyzer_upgraded' : null;
  }

  private refreshReport(projectId: string, warnings: string[]): void {
    try {
      this.graphReporter.buildCompletenessReport({ projectId });
    } catch (error) {
      this.warn(warnings, `graph_report_failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private warn(warnings: string[], message: string): void {
    if (warnings.length < MAX_WARNINGS) warnings.push(boundedFreshnessMessage(message));
  }
}
