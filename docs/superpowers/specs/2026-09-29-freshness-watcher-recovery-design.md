# Automatic Freshness Updates and Deterministic Watcher Recovery

## Purpose

Keep knowledge projects fresh automatically after local source changes while
preserving deterministic state, project isolation, and offline operation. The
system must detect new, changed, deleted, and missed-event files, enqueue the
right analysis work, and recover from filesystem watcher failures without
requiring users to manually rescan the workspace after every interruption.

## Scope

This slice adds:

- a core freshness service that reconciles the current filesystem against
  knowledge source state;
- persisted project/source freshness status;
- automatic analyze-job enqueueing for newly observed source versions;
- deterministic handling of deleted or renamed files through existing
  reconciliation rules;
- watcher restart/backoff logic with periodic scan fallback; and
- regression coverage for startup scans, event bursts, missed events, restart
  recovery, and compatibility.

The design reuses existing source scanning, source registration, queueing,
reconciliation, and source-policy logic instead of inventing a second ingestion
path.

Shared contracts are owned by `2026-09-29-knowledge-backlog-contracts-design.md`.
This slice owns the two tables below (reserved global migration version 15,
knowledge revision 11) and the `KnowledgeQueue.requeueAnalyze` API. Both tables
are **host-local** for archive purposes.

## Non-goals

- No dependence on cloud sync, remote services, or provider calls.
- No attempt to preserve inode identity across renames as canonical knowledge
  identity.
- No mutable in-place rewrite of historical source versions.
- No replacement for manual `ingest` or explicit source registration flows.
- No guarantee that changed files are fully reprocessed without a worker; this
  slice enqueues and marks freshness, while workers still perform analysis.
- No bypass of the existing sensitive-path, binary, or size policies.

## Current constraints

Today `KnowledgeSourceWatcher` is a low-level event emitter that:

- snapshots approved files below one root;
- emits `created`, `changed`, `deleted`, and `renamed` events;
- debounces local bursts; and
- reports errors without crashing callers.

It does **not** currently:

- update source/version freshness state;
- enqueue analyze jobs;
- reconcile deleted sources/pages;
- restart itself after watcher failure; or
- compensate for missed filesystem events.

Because source IDs are path-derived today, path changes must remain
path-deterministic: a rename is modeled as a stale old source plus a newly
registered source for the new path, not as hidden identity mutation.

## Proposed interfaces

### Freshness persistence

Add two project-scoped tables:

```sql
CREATE TABLE knowledge_source_freshness (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  freshness_state TEXT NOT NULL,
  current_source_version_id TEXT,
  last_observed_hash TEXT,
  last_scan_at TEXT,
  last_event_kind TEXT,
  last_event_at TEXT,
  last_enqueued_job_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, source_id),
  FOREIGN KEY (project_id, source_id)
    REFERENCES knowledge_sources(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, current_source_version_id)
    REFERENCES knowledge_source_versions(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, last_enqueued_job_id)
    REFERENCES knowledge_jobs(project_id, id) ON DELETE SET NULL
);

CREATE TABLE knowledge_project_watchers (
  project_id TEXT PRIMARY KEY,
  watcher_status TEXT NOT NULL,
  generation INTEGER NOT NULL,
  last_scan_at TEXT,
  last_successful_scan_at TEXT,
  last_event_at TEXT,
  last_restart_at TEXT,
  consecutive_error_count INTEGER NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES knowledge_projects(id) ON DELETE CASCADE
);
```

Initial `freshness_state` values:

- `fresh` — latest source version exists and its analyze job completed,
  including a `coverage_only` (unsupported) completion, which is an accurate,
  finished outcome rather than a pending one; the coverage status itself is read
  from `knowledge_analysis_coverage`, not duplicated here;
- `pending` — latest source version exists and needs or is awaiting analysis;
- `failed` — the latest source version's analyze job failed;
- `missing` — the source was previously known but is absent from the current
  scan and has been reconciled as deleted.

### Core service

```ts
export type KnowledgeFreshnessReason =
  | 'startup'
  | 'manual'
  | 'watch-event'
  | 'periodic-rescan'
  | 'watch-recovery';

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
}

export interface KnowledgeFreshnessStatus {
  projectId: string;
  watcherStatus: 'idle' | 'watching' | 'recovering' | 'degraded' | 'stopped';
  generation: number;
  lastScanAt: string | null;
  lastSuccessfulScanAt: string | null;
  pendingCount: number;
  failedCount: number;
  missingCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface KnowledgeFreshnessWatchOptions {
  debounceMs?: number;
  rescanIntervalMs?: number;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
  signal?: AbortSignal;
}

export interface KnowledgeFreshnessService {
  refreshProject(projectId: string, reason: KnowledgeFreshnessReason): KnowledgeFreshnessRunResult;
  watchProject(projectId: string, options?: KnowledgeFreshnessWatchOptions): Promise<void>;
  getStatus(projectId: string): KnowledgeFreshnessStatus;
}
```

`watchProject(...)` is an adapter-safe long-running operation. It is responsible
for watcher lifecycle and periodic reconciliation; it is not itself the worker.

## Exact data flow

### Refresh pass

1. Resolve project roots from `knowledge_project_roots`, or the workspace root
   when no explicit roots are stored.
2. Run `scanKnowledgeSources(...)` for each root using the same `SourcePolicy`
   rules as manual ingestion.
3. For every admitted candidate:
   - compute its content hash/version using existing source identity logic;
   - register it through `KnowledgeSourceStore.register(...)`;
   - detect whether a new source version was created;
   - update `knowledge_source_freshness` to `pending` for new versions or keep
     `fresh` for unchanged analyzed versions;
   - ensure exactly one `analyze` job exists for the latest version using the
     enqueue/requeue rules in "Analyze job uniqueness and requeue" below.
4. For previously active knowledge sources that no longer appear in the scan:
   - mark them `missing` in `knowledge_source_freshness`;
   - call `KnowledgeReconciliation.reconcileDeletedSource(...)`;
   - leave historical versions intact.
5. For sources whose latest analyze job failed, set `freshness_state = 'failed'`.
6. Commit source/version/freshness/job updates in one database transaction per
   refresh pass. Freshness also calls `KnowledgeSearchIndex.markSourceStale` for
   sources reconciled as missing, in the same transaction.
7. Update `knowledge_project_watchers` timestamps/status after the scan
   completes.

### Watch mode

1. `watchProject(...)` performs a `startup` refresh before opening filesystem
   watchers.
2. It creates a `KnowledgeSourceWatcher` per configured root.
3. Any `created`, `changed`, `deleted`, or `renamed` event is treated as a
   **hint**, not the source of truth:
   - update watcher status timestamps;
   - debounce bursts; then
   - run a full `refreshProject(..., 'watch-event')`.
4. A periodic full refresh runs on `rescanIntervalMs` even if no events arrive.
   This is the deterministic repair path for missed events.
5. If a watcher emits `error`, the service:
   - marks project watcher status `recovering`;
   - stops the failing watcher set;
   - continues periodic rescans; and
   - retries watcher startup with exponential backoff.
6. After a successful restart, increment `generation`, set status back to
   `watching`, and continue normal operation.
7. After repeated restart failures, switch to `degraded` while periodic rescans
   continue. Recovery to `watching` is automatic on the next successful restart.

## Analyze job uniqueness and requeue

`knowledge_jobs` has a unique index on `(project_id, job_kind,
source_version_id)`, and `KnowledgeQueue.enqueue` returns the existing row of
any status. A source version therefore has at most one `analyze` job for its
whole life; a second `enqueue` for the same version returns the old row, which
may be `completed` or `failed`. Freshness must never assume `enqueue` created
new work, and reanalysis must reuse the same row.

### Rule

For the latest version of a source, freshness calls `enqueue(...)` and then
inspects the returned status:

| Existing job status | Action |
| ------------------- | ------ |
| none (new row) | Counted in `enqueuedJobs`; state `pending` |
| `queued`, `running` | No-op; state `pending`. A running job is never touched, so a leased job cannot be double-run or have its lease disturbed |
| `completed` | State `fresh`, unless a requeue trigger applies (below) |
| `failed` | State `failed`; requeued only by the triggers below |
| `cancelled` | Requeued on `manual`, `startup`, or `watch-recovery` refresh; otherwise state `pending` |

### `KnowledgeQueue.requeueAnalyze`

```ts
export type KnowledgeRequeueReason =
  | 'manual'
  | 'analyzer_upgraded'
  | 'coverage_adapter_available'
  | 'cancelled_recovery';

requeueAnalyze(jobId: string, reason: KnowledgeRequeueReason): KnowledgeJobRecord | null;
```

- One conditional `UPDATE ... WHERE id = ? AND status IN ('completed','failed',
  'cancelled') AND worker_id IS NULL AND lease_expires_at IS NULL` sets
  `status = 'queued'`, clears `completed_at`, `started_at`, `failure_*`,
  `result_json`, `result_processing_mode`, and `result_schema_version`, and
  resets `retry_count` to 0. It returns `null` (no change) when the row is
  `queued`, `running`, or leased. It runs inside the refresh transaction, so a
  concurrent slot either claimed the job first (no requeue) or claims it
  afterward as a normal queued job.
- It appends a `knowledge_job_events` row (`requeued`, previous status, previous
  `result_schema_version`, reason) so the prior outcome stays auditable even
  though `result_json` is cleared. The existing `retry()` API is unchanged and
  remains the path for retryable failures within `maxRetries`.
- A slot from an earlier run can never complete the requeued row, because
  `complete`, `fail`, `cancelOwned`, and `renewLease` still require the matching
  `worker_id` and an unexpired lease; requeue clears both.
- It is per row, so it cannot cross projects: the predicate includes
  `project_id`.

### Requeue triggers

- `analyzer_upgraded`: the current extraction's `analyzerId`/`analyzerVersion`
  differs from the analyzer the registry now resolves for that source. Requeued
  at most once per (source version, analyzer version), tracked by the event log.
- `coverage_adapter_available`: the latest job is a `coverage_only` completion
  and the registry now resolves a supported analyzer.
- `manual`: a `manual` refresh may requeue a `failed` job.
- `cancelled_recovery`: a `cancelled` job found on a `manual`, `startup`, or
  `watch-recovery` refresh.
- **Periodic and watch-event refreshes never requeue `failed` jobs** and never
  requeue the same trigger twice, so a permanently failing file cannot loop.
  Retryable failures keep using the queue's existing retry/backoff.
- Search-index version bumps do not requeue analysis: `rebuildProject` repairs
  the index from stored extractions (search-index slice).

`KnowledgeFreshnessRunResult` gains `requeuedJobs`, counted separately from
`enqueuedJobs`, and the same-snapshot determinism rule still holds because
triggers depend only on persisted state.

## Determinism rules

- Final freshness state is derived from full-scan results plus persisted job
  state, not from nondeterministic event ordering.
- Renames remain path-deterministic: the old path becomes missing/stale and the
  new path becomes a new source identity.
- Duplicate event bursts may trigger one debounced refresh only.
- Repeated refreshes over unchanged content must be no-ops.
- The same workspace snapshot must yield the same registered source versions,
  queued analyze jobs, and freshness states.

## Failure handling and rollback

- **Watcher startup failure**: record watcher error, keep the process alive, and
  retry instead of forcing the caller to recreate the monitor manually.
- **Refresh scan failure**: abort that transaction, preserve prior freshness
  state, and record a bounded project watcher error.
- **Job enqueue failure**: roll back the same refresh transaction so source
  freshness never claims that work is pending when no job exists.
- **Deletion reconciliation failure**: roll back the refresh transaction so the
  source is not marked missing without the accompanying reconciliation updates.
- **Missed filesystem events**: repaired by periodic rescans.
- **Process crash during watch**: the next startup refresh recomputes truth from
  the filesystem and database.

Because the refresh pass is derived state over immutable source-version records,
recovery favors recomputation over ad hoc repair.

## Offline and security constraints

- The entire feature works offline.
- Only workspace-confined roots are watched or scanned.
- Sensitive-path, ignored-path, binary, and file-size policies are identical to
  the existing scanner rules.
- Status/error records contain bounded, redacted metadata only; they do not
  store file contents.
- No event handler may enqueue or register content from outside the project
  roots.
- Periodic rescans must not follow symlink escapes or weaken current path
  security checks.

## Compatibility

- Existing manual source scan/ingest commands remain valid.
- Existing `KnowledgeSourceWatcher` stays reusable as the low-level emitter; the
  new service composes it rather than replacing it.
- Projects without freshness rows bootstrap themselves on first refresh.
- Existing queue, worker, and reconciliation behavior remains authoritative.
- The search-index design can consume freshness state later, for example to mark
  indexed source versions stale when a newer source version is pending.
- **Archive class: host-local** for `knowledge_source_freshness` and
  `knowledge_project_watchers`. They describe this host's filesystem scan and
  watcher state, so they are never exported, are declared in the manifest as
  omissions with reason `host_local_only`, and are rejected if an archive
  contains them. After import, or after `replaceExisting`, the rows for the
  project are absent and bootstrap on the first refresh, which recomputes
  freshness from the (imported) source versions and jobs. No imported
  freshness value is ever trusted.
- The search-index slice already treats a pending newer version as unusable and
  serves it through its per-source fallback; freshness only needs to call
  `markSourceStale` for missing sources.
- Worker concurrency (which runs concurrent slots) is compatible with requeue
  because requeue never touches leased rows.

## TDD validation

Follow RED → GREEN → IMPROVE:

1. Add refresh tests for:
   - unchanged sources;
   - changed content producing a new version and one analyze job;
   - deleted files producing `missing` plus reconciliation;
   - failed latest analyze jobs producing `failed` freshness;
   - `enqueue` returning an existing completed/failed/running job is handled
     without creating a second row (unique index) and without disturbing a
     leased job;
   - `requeueAnalyze` for analyzer upgrade and adapter availability, including
     audit event, cleared result, once-only trigger, and refusal on leased rows;
   - periodic refresh never requeues a failed job.
2. Add watcher tests for:
   - startup error followed by automatic recovery;
   - event-burst debouncing;
   - periodic rescan detecting a change when no filesystem event is emitted;
   - repeated restart failures entering `degraded` and later recovering.
3. Add project-isolation tests proving that one project's watch/refresh state
   never mutates another project's sources or jobs.
4. Add migration/archive compatibility tests for databases with and without the
   new freshness tables, export omitting both tables, and import rejecting an
   archive that contains them.
5. Run focused scanner/source-store/reconciliation/queue/watcher tests, then
   full core tests/build.

The slice is complete only when freshness remains correct after watcher errors,
not merely while the happy-path watcher stays attached.
