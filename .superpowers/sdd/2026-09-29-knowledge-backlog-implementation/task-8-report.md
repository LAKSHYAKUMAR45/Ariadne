# Task 8 Report: Safe worker concurrency

Status: DONE_WITH_CONCERNS

## What changed
- **`KnowledgeHostSettingsStore`** (`KnowledgeHostSettingsStore.ts`): `get`/`set`/`delete` over the `host.` namespace of `knowledge_settings` with a key registry for all six contract keys (unknown or non-`host.` keys rejected without echoing them; values validated on write and on read; values never appear in errors). `KnowledgeWorkerSettingsStore` (`getConcurrency`/`setConcurrency`/`clearConcurrency`), `validateKnowledgeWorkerConcurrency` (integer 1..8, never clamps) and `resolveKnowledgeWorkerConcurrency` (override > host setting > default 1, reports `source`). No migration.
- **`KnowledgeWorker.runOne`** returns `{ claimedJobId, status: idle|completed|failed|cancelled|lease_lost, warnings, unsupportedCoverage }`. `runOnce` is now the single-slot loop over it (recovery before each claim, same result shape and counts). New `refreshProjectGraphReport` for batch callers.
- **`KnowledgeWorkerPool`** (`runOnce`, `runWatch`): resolves/validates concurrency before recovering or claiming; one project-scoped expired-lease recovery per pass; N slots each with own worker instance and ID `<base>/run_<id>/slot_<n>`; aggregated result adds `concurrency`, `resolvedConcurrency`, `recoveredExpired`, `slots[]`; recovery-failed jobs count in `failed`; graph report refreshed once. Abort propagates to all slots. Base worker ID validated (1-64 of `[A-Za-z0-9._:@-]`).
- **`KnowledgeQueue.claim`** now runs `BEGIN IMMEDIATE`, so competing connections wait for the write lock instead of reading a stale snapshot and hitting `SQLITE_BUSY_SNAPSHOT`. Complete/fail/cancel/renew/requeue predicates unchanged.
- **CLI**: `worker run --concurrency` (strict integer parse, 1-8, pool-backed, `--once` and `--watch`), new `worker concurrency <project> [--set n | --reset]`, `worker status` reports resolved `concurrency` (null plus a `worker_concurrency_invalid` warning when the stored value is corrupt) and text output. Only unexpired leases count as active workers (existing behavior, now per slot ID).
- Docs: `docs/knowledge-worker.md`. Exports added to `packages/core/src/index.ts`.

## TDD
RED observed for: settings store (module missing), `runOne` (5 failing), queue claim interleaving (`database is locked` thrown to the caller before the `.immediate()` fix). Pool and CLI tests were written before the implementation; the pool suite passed on first implementation run except the lease-renewal timing test, whose parameters I then tuned (CLI tests were also not observed failing before implementation).

## Tests
- core: `tsc --noEmit` clean; full `vitest run` 77 files / 992 tests pass (3 consecutive full runs). New: `KnowledgeHostSettingsStore` (27), `KnowledgeWorkerPool` (24), `runOne` (6), queue claim across connections (2), archive host-local round trip (1).
- cli: 12 files / 149 tests pass (13 new concurrency tests); mcp-server 72 pass; cli/core type-check.
- Pool tests cover: parallel drain with exactly-once completion, project isolation, precedence/validation, fail-fast before claim/recovery, per-slot lease renewal and intruder rejection, lease loss, slot crash and later exactly-once recovery, abort, expired-lease recovery once per pass, requeue racing slots, watch, single-worker compatibility.

## Deviations / concerns
- A lease-lost step is reported as `lease_lost` only; the old `runOnce` also counted a job as failed/cancelled if it happened to be terminal after a lease loss, which double-counted work done by another owner or recovery.
- A slot crash lets siblings finish, then the pool rejects with the first crash error (as `runOnce` always did) rather than hiding it in a warning.
- Slots share one process and DB connection; a CPU-heavy synchronous stage in one slot can delay another slot's renewal timer (default lease 60 s makes this benign). Multi-process safety comes from the immediate claim and queue predicates; no true multi-process test exists (no TS loader available for child processes), only an interleaving proxy test and alternating two-connection claims.
- `--worker` IDs are now validated (previously any string).
- Only the CLI adopts the pool; MCP, VS Code, and dashboard still use single `KnowledgeWorker.runOnce`.
- Pre-existing uncommitted `knowledge-search-evaluation/progress.md` was not touched or committed.
