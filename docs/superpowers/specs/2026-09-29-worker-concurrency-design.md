# Safe Configurable Worker Concurrency with Lease Correctness

## Purpose

Lift the current `--concurrency 1` limitation for the knowledge worker without
breaking project isolation, lease ownership, or deterministic recovery. The
system must allow configurable parallel draining within one project while keeping
SQLite-backed queue leases authoritative and safe across multiple slots,
processes, or hosts that share the same workspace database.

## Scope

This slice adds:

- a project-scoped worker-pool coordinator in core;
- a validated host-local, per-project concurrency setting with optional per-run
  override;
- unique slot worker IDs for parallel claims and lease renewal;
- one-job-at-a-time worker steps that the pool can schedule safely;
- aggregated run/watch results that preserve existing single-worker fields;
- status/reporting for resolved concurrency and active worker slots; and
- regression coverage for lease renewal, lease loss, recovery, isolation, and
  compatibility.

The queue remains SQLite-backed and project-scoped. Provider enrichment remains
optional and is orthogonal to concurrency.

Shared contracts are owned by `2026-09-29-knowledge-backlog-contracts-design.md`.
This slice reserves **no** global migration. It stores its setting in the
host-local `host.` namespace of `knowledge_settings` and, as the first consumer,
implements the `KnowledgeHostSettingsStore` and key registry described there.

## Non-goals

- No distributed broker, external queue, or leader-election system.
- No workspace-global concurrency setting shared across all projects.
- No change to job semantics, analyzer output, page generation logic, or search.
- No best-effort silent clamping of invalid concurrency values.
- No attempt to make one job execute across multiple workers simultaneously.
- No remote service dependency.

## Current constraints

The current core worker is lease-safe for one active job per worker ID and the
queue already enforces project-scoped claim/update predicates. However:

- `KnowledgeWorker.runOnce(...)` drains sequentially inside one worker;
- CLI/docs intentionally reject `--concurrency > 1`;
- lease recovery is intertwined with that single-worker drain loop; and
- reusing the same `workerId` in multiple parallel loops would make lease
  renewal ambiguous.

The design therefore keeps the existing queue contract authoritative and adds a
coordinator instead of trying to reinterpret a single worker instance as a
parallel executor.

## Proposed interfaces

### Host-local setting helper

Concurrency is a property of **this host's** CPU, disk, and SQLite contention,
not of the project's knowledge. It is therefore stored under the host-local
namespace in the existing `knowledge_settings` table:

- `host.worker.concurrency`

```ts
export interface KnowledgeWorkerSettingsStore {
  getConcurrency(projectId: string): number | null;
  setConcurrency(projectId: string, concurrency: number): void;
}
```

It is a typed helper over the shared `KnowledgeHostSettingsStore` (which this
slice implements: `get`, `set`, `delete`, plus the key registry that rejects
unknown `host.` keys).

Rules:

- integer only;
- minimum `1`;
- maximum `8` in the first slice;
- invalid stored values fail fast when resolved;
- unset means "use the default", never an implicit clamp.

Portability: `host.worker.concurrency` is **not portable**. The archive exporter
filters every `host.` row, the importer rejects archives that contain one, and
`replaceExisting` import preserves the local value. An imported project therefore
starts at the default of `1` on the importing host until that host sets its own
value.

### Worker step interface

```ts
export interface KnowledgeWorkerStepResult {
  claimedJobId: string | null;
  status: 'idle' | 'completed' | 'failed' | 'cancelled' | 'lease_lost';
  warnings: KnowledgeWorkerWarning[];
}

export class KnowledgeWorker {
  runOne(projectId: string): Promise<KnowledgeWorkerStepResult>;
  runOnce(projectId: string): Promise<KnowledgeWorkerRunResult>; // unchanged public shape
  runWatch(projectId: string, options?: { pollMs?: number }): Promise<void>;
}
```

`runOnce(...)` becomes a thin single-slot loop over `runOne(...)`, preserving
current behavior when concurrency resolves to `1`.

### Pool coordinator

```ts
export interface ResolvedKnowledgeWorkerConcurrency {
  value: number;
  source: 'default' | 'host-setting' | 'override';
}

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
  recoveredExpired: number;
  slots: KnowledgeWorkerSlotResult[];
}

export interface KnowledgeWorkerPoolOptions {
  baseWorkerId: string;
  concurrency?: number;
  now?: () => string;
  signal?: AbortSignal;
}

export class KnowledgeWorkerPool {
  runOnce(projectId: string, options?: { concurrency?: number }): Promise<KnowledgeWorkerPoolRunResult>;
  runWatch(projectId: string, options?: { concurrency?: number; pollMs?: number }): Promise<void>;
}
```

Each slot worker ID is derived as:

```text
<baseWorkerId>/run_<stable-run-id>/slot_<n>
```

That prevents lease-renewal collisions between overlapping pool runs.

## Exact data flow

1. A caller resolves concurrency with precedence:
   - explicit per-run override;
   - host-local setting `host.worker.concurrency`;
   - default `1`.
2. Resolution validates the number before any claim occurs.
3. `KnowledgeWorkerPool.runOnce(...)` performs one project-scoped expired-lease
   recovery pass.
4. The pool launches `N` independent worker slots, each with a unique worker
   ID and its own `KnowledgeWorker` instance.
5. Each slot repeats:
   - call `worker.runOne(projectId)`;
   - if `claimedJobId === null`, exit idle;
   - otherwise continue until the queue is empty or the root signal aborts.
6. Each job still has exactly one lease owner at a time. Lease renewal remains
   per-job, per-worker-ID, and is still enforced by `KnowledgeQueue.renewLease`.
7. The coordinator aggregates per-slot counts and warnings into the existing
   run result plus additive concurrency metadata.
8. `runWatch(...)` repeats pool drains with the existing poll loop, but only
   after all current slots have gone idle.

## Queue and lease rules

No new lease table is introduced. Existing queue rows stay authoritative.

The following rules remain mandatory:

- every `claim(...)` predicate includes `project_id`;
- every `complete(...)`, `fail(...)`, `cancelOwned(...)`, and `renewLease(...)`
  still requires matching `worker_id` and unexpired `lease_expires_at`;
- a lease loss never becomes a successful completion;
- recovery requeues or fails only the jobs whose recorded lease is truly
  expired at recovery time.

Pool concurrency works because multiple slots compete safely through those same
transactional queue predicates.

## Failure handling and rollback

- **Invalid concurrency override/setting**: fail before creating any worker
  slots or claiming any jobs.
- **One slot loses a lease**: record `lease_lost` for that slot, do not mark
  the job complete/failed from the losing slot, and allow recovery to requeue
  or fail it in the next pass.
- **One slot crashes during processing**: sibling slots continue; the crashed
  job is recovered later by normal lease expiry.
- **Coordinator aborts**: propagate the abort signal to all slots; any in-flight
  leased jobs rely on existing lease expiry/recovery rather than forced
  best-effort mutation.
- **Provider enrichment failure in one slot**: unchanged from current behavior;
  the job can still complete deterministically.
- **Status/report aggregation failure**: does not alter committed queue state;
  rerun is safe because queue rows are authoritative.

Rollback is straightforward because the coordinator itself stores no durable
truth. Durable state remains the queue row plus downstream extraction/graph/page
transactions already handled by `KnowledgeWorker`.

## Offline and security constraints

- No remote services are required.
- Worker IDs must be bounded, non-secret, and must not embed raw provider keys,
  tokens, or full private paths.
- Concurrency is project-scoped only; one project's setting must never affect
  claims in another project. The value is host-local and is never echoed into
  archives, exported status, or worker IDs.
- All logging and warnings stay redacted through existing queue/worker
  sanitization.
- Lease correctness must not depend on wall-clock synchronization beyond the
  same timestamp model already used by the queue.

## Compatibility

- Default behavior remains equivalent to today's single-worker drain because the
  resolved default is still `1`.
- Existing callers that read `KnowledgeWorkerRunResult` keep working because the
  current `projectId`, `claimed`, `completed`, `failed`, `cancelled`, and
  `warnings` fields remain unchanged.
- New concurrency metadata is additive.
- The setting is host-local and omitted from archives (see "Host-local setting
  helper"); it is not portable and no import can change it.
- Queue schema and job result schema remain unchanged. The freshness slice's
  `KnowledgeQueue.requeueAnalyze` is compatible with concurrent slots because it
  only updates unleased `completed`/`failed`/`cancelled` rows in a single
  conditional statement; the claim, complete, fail, cancel, and renew predicates
  above are unchanged. `recoverExpired` requeues (lease expiry) and freshness
  requeues (explicit reasons) are separate paths on the same row and cannot
  both apply, because each requires the row to be in its own source state.
- The unique `(project_id, job_kind, source_version_id)` index means slots never
  see two analyze jobs for one source version; reanalysis reuses the same row.
- CLI, MCP, VS Code, and dashboard adapters can adopt the richer pool result
  incrementally.

## TDD validation

Follow RED → GREEN → IMPROVE:

1. Add core tests for concurrency resolution precedence and validation,
   including `host.worker.concurrency` storage, rejection of unknown `host.`
   keys, and archive export omitting / import rejecting the key.
2. Add queue/worker integration tests proving that:
   - two or more slots drain only the requested project;
   - the same job is never completed twice;
   - lease renewal only works for the owning slot worker ID;
   - expired jobs are recovered exactly once per pass;
   - a concurrent `requeueAnalyze` never disturbs a leased job and a requeued job
     is claimed by exactly one slot.
3. Add failure-path tests for slot crash, lease loss, and coordinator abort.
4. Add compatibility tests showing that `runOnce(...)` at concurrency `1`
   preserves the prior result shape and behavior.
5. Add CLI/MCP adapter tests for accepted/rejected `--concurrency` values and
   JSON output compatibility.
6. Run focused knowledge queue/worker tests, then full core tests/build and
   downstream CLI/MCP suites.

The slice is complete only when concurrency greater than one is demonstrably
safe under lease loss and cross-project contention, not merely faster in the
happy path.
