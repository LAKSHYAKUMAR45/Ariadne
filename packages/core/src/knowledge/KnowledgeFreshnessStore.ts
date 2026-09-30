import type Database from 'better-sqlite3';
import { redact } from '../Redactor.js';
import { createKnowledgeId } from './KnowledgeIds.js';

export type KnowledgeFreshnessState = 'fresh' | 'pending' | 'failed' | 'missing';
export type KnowledgeWatcherStatus = 'idle' | 'watching' | 'recovering' | 'degraded' | 'stopped';

export interface KnowledgeSourceFreshnessRecord {
  id: string;
  projectId: string;
  sourceId: string;
  state: KnowledgeFreshnessState;
  currentSourceVersionId: string | null;
  lastObservedHash: string | null;
  lastScanAt: string | null;
  lastEventKind: string | null;
  lastEventAt: string | null;
  lastEnqueuedJobId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `undefined` keeps the stored value, `null` clears it. */
export interface UpsertSourceFreshnessInput {
  projectId: string;
  sourceId: string;
  state: KnowledgeFreshnessState;
  currentSourceVersionId: string | null;
  lastObservedHash: string | null;
  lastScanAt: string;
  lastEventKind?: string | null;
  lastEventAt?: string | null;
  lastEnqueuedJobId?: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface KnowledgeProjectWatcherRecord {
  projectId: string;
  status: KnowledgeWatcherStatus;
  generation: number;
  lastScanAt: string | null;
  lastSuccessfulScanAt: string | null;
  lastEventAt: string | null;
  lastRestartAt: string | null;
  consecutiveErrorCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: string | null;
}

export type UpdateProjectWatcherInput = Partial<Omit<KnowledgeProjectWatcherRecord, 'projectId' | 'updatedAt'>>;

interface FreshnessRow {
  id: string;
  project_id: string;
  source_id: string;
  freshness_state: KnowledgeFreshnessState;
  current_source_version_id: string | null;
  last_observed_hash: string | null;
  last_scan_at: string | null;
  last_event_kind: string | null;
  last_event_at: string | null;
  last_enqueued_job_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface WatcherRow {
  project_id: string;
  watcher_status: KnowledgeWatcherStatus;
  generation: number;
  last_scan_at: string | null;
  last_successful_scan_at: string | null;
  last_event_at: string | null;
  last_restart_at: string | null;
  consecutive_error_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  updated_at: string;
}

const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_ERROR_CODE_LENGTH = 64;
const ABSOLUTE_PATH_PATTERN = /(?<![\w.<>-])(?:[A-Za-z]:)?(?:[\\/][\w.@+~-]+){2,}/g;

/** Bounded, redacted diagnostic text: no secrets and no absolute (private) paths. */
export function boundedFreshnessMessage(value: string, privateRoots: readonly string[] = []): string {
  let text = value;
  for (const root of privateRoots) {
    if (root) text = text.split(root).join('<workspace>');
  }
  text = redact(text.replace(ABSOLUTE_PATH_PATTERN, '<path>')).replace(/\s+/g, ' ').trim();
  return text.length > MAX_ERROR_MESSAGE_LENGTH ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…` : text;
}

export function boundedFreshnessCode(value: string): string {
  return value.slice(0, MAX_ERROR_CODE_LENGTH);
}

function rowToFreshness(row: FreshnessRow): KnowledgeSourceFreshnessRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    state: row.freshness_state,
    currentSourceVersionId: row.current_source_version_id,
    lastObservedHash: row.last_observed_hash,
    lastScanAt: row.last_scan_at,
    lastEventKind: row.last_event_kind,
    lastEventAt: row.last_event_at,
    lastEnqueuedJobId: row.last_enqueued_job_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWatcher(row: WatcherRow): KnowledgeProjectWatcherRecord {
  return {
    projectId: row.project_id,
    status: row.watcher_status,
    generation: row.generation,
    lastScanAt: row.last_scan_at,
    lastSuccessfulScanAt: row.last_successful_scan_at,
    lastEventAt: row.last_event_at,
    lastRestartAt: row.last_restart_at,
    consecutiveErrorCount: row.consecutive_error_count,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    updatedAt: row.updated_at,
  };
}

/** Host-local persistence for per-source freshness and per-project watcher recovery state. Always project scoped. */
export class KnowledgeFreshnessStore {
  private readonly now: () => string;

  public constructor(
    private readonly db: Database.Database,
    options: { now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public getSource(projectId: string, sourceId: string): KnowledgeSourceFreshnessRecord | null {
    const row = this.db
      .prepare('SELECT * FROM knowledge_source_freshness WHERE project_id = ? AND source_id = ?')
      .get(projectId, sourceId) as FreshnessRow | undefined;
    return row ? rowToFreshness(row) : null;
  }

  public listSources(projectId: string): KnowledgeSourceFreshnessRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM knowledge_source_freshness WHERE project_id = ? ORDER BY source_id')
      .all(projectId) as FreshnessRow[];
    return rows.map(rowToFreshness);
  }

  public countByState(projectId: string): Record<KnowledgeFreshnessState, number> {
    const counts: Record<KnowledgeFreshnessState, number> = { fresh: 0, pending: 0, failed: 0, missing: 0 };
    const rows = this.db
      .prepare(
        `SELECT freshness_state AS state, COUNT(*) AS total
         FROM knowledge_source_freshness WHERE project_id = ? GROUP BY freshness_state`,
      )
      .all(projectId) as Array<{ state: KnowledgeFreshnessState; total: number }>;
    for (const row of rows) counts[row.state] = row.total;
    return counts;
  }

  public upsertSource(input: UpsertSourceFreshnessInput): KnowledgeSourceFreshnessRecord {
    const existing = this.getSource(input.projectId, input.sourceId);
    const timestamp = this.now();
    const values = {
      id: existing?.id ?? createKnowledgeId('freshness', `${input.projectId}:${input.sourceId}`),
      projectId: input.projectId,
      sourceId: input.sourceId,
      state: input.state,
      currentSourceVersionId: input.currentSourceVersionId,
      lastObservedHash: input.lastObservedHash,
      lastScanAt: input.lastScanAt,
      lastEventKind: input.lastEventKind === undefined ? (existing?.lastEventKind ?? null) : input.lastEventKind,
      lastEventAt: input.lastEventAt === undefined ? (existing?.lastEventAt ?? null) : input.lastEventAt,
      lastEnqueuedJobId:
        input.lastEnqueuedJobId === undefined ? (existing?.lastEnqueuedJobId ?? null) : input.lastEnqueuedJobId,
      lastErrorCode: input.lastErrorCode === null ? null : boundedFreshnessCode(input.lastErrorCode),
      lastErrorMessage: input.lastErrorMessage === null ? null : boundedFreshnessMessage(input.lastErrorMessage),
      now: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO knowledge_source_freshness
         (id, project_id, source_id, freshness_state, current_source_version_id, last_observed_hash, last_scan_at,
          last_event_kind, last_event_at, last_enqueued_job_id, last_error_code, last_error_message, created_at, updated_at)
         VALUES (@id, @projectId, @sourceId, @state, @currentSourceVersionId, @lastObservedHash, @lastScanAt,
                 @lastEventKind, @lastEventAt, @lastEnqueuedJobId, @lastErrorCode, @lastErrorMessage, @now, @now)
         ON CONFLICT (project_id, source_id) DO UPDATE SET
           freshness_state = excluded.freshness_state,
           current_source_version_id = excluded.current_source_version_id,
           last_observed_hash = excluded.last_observed_hash,
           last_scan_at = excluded.last_scan_at,
           last_event_kind = excluded.last_event_kind,
           last_event_at = excluded.last_event_at,
           last_enqueued_job_id = excluded.last_enqueued_job_id,
           last_error_code = excluded.last_error_code,
           last_error_message = excluded.last_error_message,
           updated_at = excluded.updated_at`,
      )
      .run(values);
    return this.getSource(input.projectId, input.sourceId) as KnowledgeSourceFreshnessRecord;
  }

  public getWatcher(projectId: string): KnowledgeProjectWatcherRecord {
    const row = this.db
      .prepare('SELECT * FROM knowledge_project_watchers WHERE project_id = ?')
      .get(projectId) as WatcherRow | undefined;
    if (row) return rowToWatcher(row);
    return {
      projectId,
      status: 'idle',
      generation: 0,
      lastScanAt: null,
      lastSuccessfulScanAt: null,
      lastEventAt: null,
      lastRestartAt: null,
      consecutiveErrorCount: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: null,
    };
  }

  public updateWatcher(projectId: string, patch: UpdateProjectWatcherInput): KnowledgeProjectWatcherRecord {
    const merged = { ...this.getWatcher(projectId), ...definedEntries(patch) };
    this.db
      .prepare(
        `INSERT INTO knowledge_project_watchers
         (project_id, watcher_status, generation, last_scan_at, last_successful_scan_at, last_event_at, last_restart_at,
          consecutive_error_count, last_error_code, last_error_message, updated_at)
         VALUES (@projectId, @status, @generation, @lastScanAt, @lastSuccessfulScanAt, @lastEventAt, @lastRestartAt,
                 @consecutiveErrorCount, @lastErrorCode, @lastErrorMessage, @now)
         ON CONFLICT (project_id) DO UPDATE SET
           watcher_status = excluded.watcher_status,
           generation = excluded.generation,
           last_scan_at = excluded.last_scan_at,
           last_successful_scan_at = excluded.last_successful_scan_at,
           last_event_at = excluded.last_event_at,
           last_restart_at = excluded.last_restart_at,
           consecutive_error_count = excluded.consecutive_error_count,
           last_error_code = excluded.last_error_code,
           last_error_message = excluded.last_error_message,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...merged,
        lastErrorCode: merged.lastErrorCode === null ? null : boundedFreshnessCode(merged.lastErrorCode),
        lastErrorMessage: merged.lastErrorMessage === null ? null : boundedFreshnessMessage(merged.lastErrorMessage),
        now: this.now(),
      });
    return this.getWatcher(projectId);
  }
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
