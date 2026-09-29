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
