# Task 7 Report: Freshness, watcher recovery, and explicit requeue

Status: DONE_WITH_CONCERNS

## What changed
- **Migration 15 / knowledge revision 11**: `knowledge_source_freshness` (state/status CHECKs, `UNIQUE(project_id, source_id)`, composite source FK with cascade, index on `(project_id, freshness_state)`) and `knowledge_project_watchers` (status/generation/error-count CHECKs, project FK cascade). Both were already classified host-local by the archive registry; they are never exported and are cleared per project on `replaceExisting`.
- **`KnowledgeQueue.requeueAnalyze(jobId, reason, context?)`** + `listRequeueEvents`: atomic reset of a terminal (`completed|failed|cancelled`), unleased, ownerless `analyze` row back to `queued` (same row, so the unique `(project_id, job_kind, source_version_id)` identity holds). Clears failure/result/lease fields, resets `retry_count`, records a `requeued` event (previous status, result schema, failure code, retry count, target analyzer). Returns null for queued/running/leased/owned/non-analyze/unknown jobs. Reasons: `manual`, `cancelled_recovery`, `coverage_adapter_available`, `analyzer_upgraded`. Old worker slots cannot complete/fail/cancel/renew the requeued row.
- **`KnowledgeFreshnessService`** (`KnowledgeFreshness.ts`, store in `KnowledgeFreshnessStore.ts`, loop in `KnowledgeFreshnessWatch.ts`): `refreshProject(projectId, reason)`, `watchProject`, `getStatus`.
  - Scan (policy, roots, workspace confinement) then one SQLite transaction: register versions, enqueue one analyze job per version, requeue decisions, missing-source reconciliation, freshness rows, watcher row. Any failure rolls back and records a bounded, path-free `refresh_failed`/`scan_failed`.
  - Startup and watch-recovery refreshes recover expired leases; changed/deleted sources mark search indexes stale; the graph completeness report is refreshed after changes (failure = warning).
  - Requeue rules: failed only on manual refresh; cancelled on manual/startup/watch-recovery; legacy failed `unsupported_source` jobs go through `requeueAnalyze` and the worker completes them as `coverage_only`; completed jobs requeue once per target analyzer `id@version` (`coverage_adapter_available`, `analyzer_upgraded`); queued/running never touched.
  - Watch loop: startup refresh before watchers open, debounced single-flight event refreshes, periodic rescan, watcher restart with exponential backoff, `degraded` after N consecutive failures (rescans continue) and automatic return to `watching`, generation increments, abort gives `stopped`.
- **`KnowledgeSourceStore.register`**: a stale source that reappears with identical content is reactivated (was a UNIQUE violation); content matching an older superseded version throws `KnowledgeSourceVersionRevertError`.
- **`KnowledgeSourceContentStore`**: core copy of the immutable content-addressed store (the CLI copy is untouched).
- Public exports added in `src/index.ts`.

## TDD
RED observed first for: migration ladder/tables, requeue API (methods missing), source store reactivation/revert, freshness service (module missing). The watch tests were written after the loop implementation existed (the loop was built alongside the service), so their RED run was not captured; they were checked for flakiness by repeated runs.

## Tests
- `packages/core`: `tsc --noEmit` clean; full `vitest run` 75 files / 922 tests pass (was 72 / 874). cli `test/knowledge` (30) and mcp-server (72) pass; cli/mcp-server type-check.
- `npm run test:knowledge:evaluation`: 25 pass.
- Archive tests updated to use the real freshness table instead of a stub.

## Deviations / concerns
- `refreshProject` is async (the scanner is async); the spec shows a sync return.
- Version/job FKs from freshness are composite `NO ACTION DEFERRABLE INITIALLY DEFERRED`, not `SET NULL` (SQLite would null the NOT NULL `project_id` half of the composite key).
- The queue has no automatic job backoff; retries stay manual/bounded by `maxRetries`. Backoff applies to watcher restarts only.
- Extra fields: `recoveredLeases`/`warnings` on run results, `degradedAfterFailures` watch option.
- Content revert (A→B→A) is recorded as a failed freshness row (`source_version_reverted`) because versions are unique per `(source_id, content_hash)` and history is not rewritten.
- Restored file with identical content requeues its completed job with reason `manual`.
- Not wired into CLI/MCP commands or the daemon; service API only.
- Pre-existing uncommitted `knowledge-search-evaluation/progress.md` was not committed.

## Review fix: A→B→A content revert (Important)

Previously a source that returned to an older known hash was recorded as a permanent `failed` freshness row (`source_version_reverted`) and never re-analyzed.

### Fix
- `KnowledgeSourceStore.register` now reuses the existing immutable version for a reverted hash: `current_hash` moves back, status becomes `active`, no version row is inserted/renumbered/rewritten. `KnowledgeSourceVersionRevertError` was removed (no longer thrown). Added `currentVersion()` (version whose hash equals `current_hash`).
- "Latest version" reads in search, search-index, graph reporting and graph node lookup previously used `MAX(version_number)`, which would keep serving version B after a revert. They now use the shared `currentSourceVersionNumberSql` (current hash first, `MAX` fallback for legacy/inconsistent rows). CLI `ingest` uses `currentVersion()`.
- Freshness: a revert marks the source's search indexes stale, enqueues (unique identity preserved, no new job row) and requeues the reused version's analyze job from `completed`/`failed`/`cancelled` with new audited reason `source_reverted`; queued/leased jobs are untouched (lease fencing unchanged). The freshness row is `pending`, `current_source_version_id` = reused version, `last_event_kind = 'reverted'`, no error; it turns `fresh` once the job completes. Missing files and genuine register failures (`source_register_failed`) behave as before.
- Spec updated (`2026-09-29-freshness-watcher-recovery-design.md`).

### Tests (RED first: 6 failing, revert threw/recorded failure)
- `KnowledgeFreshness.test.ts` › `content revert (A→B→A)`: reuse/no history rewrite/audited requeue/stale indexes/idempotent rescan; real worker run replaces the old analysis, A's index is active, B's stale, freshness `fresh`, search returns A content and not B; failed-job requeue with project isolation; leased job untouched.
- `KnowledgeSourceStore.test.ts`: revert reuses version; stale-source revert reactivates.

### Output
- `packages/core`: `tsc --noEmit` clean; vitest 75 files / 926 tests passed.
- `packages/cli`: `tsc --noEmit` clean; vitest 12 files / 133 tests passed.

### Concerns
- Requeue on revert also applies to a `failed` job (an explicit content change, bounded by the number of flips), which departs from "never requeue failed on watch events" only for this trigger.
- Pre-existing uncommitted `progress.md` change in the worktree was left untouched.

## Re-review fix: current-version selection in reconciliation and research (Important)

After A→B→A, the source's `current_hash` points at reused version A, but two callers still took the highest-numbered version (B).

### Fix
- `KnowledgeReconciliation.reconcileChangedSource` now uses `KnowledgeSourceStore.currentVersion(projectId, sourceId)` instead of `versions.at(-1)`. Stale versions are all others, so a page on A stays active and a page on B goes stale. It throws if the source has no current version rather than guessing.
- `KnowledgeResearch.ingestResults` (queue job binding) and `createSynthesisPage` (`sourceVersionIds`) now use `currentVersion(...)` instead of `listVersions(...).at(-1)` / `.slice(-1)`.
- Project isolation is preserved because `currentVersion` filters by `project_id`.

### Tests (RED first: both new regressions failed before the fix)
- `KnowledgeReconciliation.test.ts`: A→B→A leaves the page on A active and stales the page on B, with one review/insight. A later new version C makes the page on A stale (normal newest-content behavior).
- `KnowledgeResearch.test.ts`: research ingest of A→B→A binds the synthesis page and queue jobs to A's reused version, with no new version row and one job per version. A separate test covers the newest-version binding and project isolation.

### Output
- `packages/core`: `tsc --noEmit` clean; vitest 75 files / 929 tests passed.
- `packages/cli`: `tsc --noEmit` clean; vitest 12 files / 133 tests passed.

### Concerns
- `KnowledgePageStore.createPageVersion` returns an older duplicate-content version without making it current, so a synthesis page whose content reverts (same query) still resolves to the newer page version. This is a separate page-store behavior and was left unchanged; the research test uses distinct queries.
- Pre-existing uncommitted `progress.md` change was left untouched.

## Re-review fix 2: queue-binding regression and legacy current-version fallback

### Fix
- `KnowledgeSourceStore.currentVersion` now falls back to the highest version number when `current_hash` is NULL or matches no version (legacy/imported rows), mirroring `currentSourceVersionNumberSql` used by search/index/graph paths. A matching hash still wins (A→B→A), and the query stays scoped by `project_id`. Reconciliation, research and freshness therefore no longer throw for such rows.
- The A→B→A research test previously asserted the final queue job set, which is deduplicated per version and so passed even with `.at(-1)`. It now spies on `queue.enqueue` and asserts the third call's `sourceVersionId === versionA.id`.

### Tests (RED first)
- `KnowledgeResearch.test.ts`: enqueue spy asserts 3 calls, third bound to version A. Verified by mutation: reverting `ingestResults` to `listVersions(...).at(-1)` makes it fail (expected version B id to be version A id).
- `KnowledgeSourceStore.test.ts`: `currentVersion` falls back to highest version for NULL and unmatched `current_hash`; other project returns null (failed before the fix).
- `KnowledgeReconciliation.test.ts`: NULL `current_hash` legacy source reconciles (stales the page on the older version) instead of throwing (failed before the fix).

### Output
- `packages/core`: `tsc --noEmit` clean; vitest 75 files / 932 tests passed.
- `packages/cli`: `tsc --noEmit` clean; vitest 12 files / 133 tests passed.

### Concerns
- Pre-existing uncommitted `progress.md` change in the search-evaluation SDD dir was left untouched.
