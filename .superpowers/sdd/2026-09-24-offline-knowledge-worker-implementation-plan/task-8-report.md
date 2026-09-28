# Task 8 report — reusable KnowledgeWorker

## Architecture decisions

- Added `packages/core/src/knowledge/KnowledgeWorker.ts` as the project-scoped staged worker that composes queue claim/recovery, immutable source loading, analyzer selection, extraction persistence, typed graph materialization, deterministic page generation, optional enrichment, and terminal queue transitions.
- Kept the worker reusable by defaulting concrete services from the core package while allowing dependency injection for queue, loader, analyzers, extraction store, graph materializer, generator, and page builder.
- Extended `KnowledgeGeneratorService.runKnowledgeGeneration(jobId, payloadOverride?, { completeJob? })` so Task 8 can reuse the deterministic page pipeline without introducing duplicate orchestration. `completeJob: false` leaves final queue completion/failure ownership with `KnowledgeWorker`.
- Hardened queue metadata persistence so result warnings, failure messages, progress stages, and progress detail keys/values are bounded and secret-redacted before durable storage.
- Aligned generator lease renewal with the worker queue lease duration to avoid generation extending leases past the queue policy.
- Fixed `KnowledgePageStore.resolveSourceSpanId()` to select `span.id`, which unblocked deterministic source-page provenance and exact-span search citations during worker generation.
- Expanded OpenAI key redaction to catch hyphenated and underscore-containing keys (including `sk-proj-..._...`) and added a regression test.

## RED evidence

Initial RED run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeWorker.test.ts
```

Result: **failed** because `packages/core/src/knowledge/KnowledgeWorker.ts` did not exist yet:

- `Cannot find module '../../src/knowledge/KnowledgeWorker.js'`

## GREEN evidence

Focused required validation:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeWorker.test.ts KnowledgeQueue.test.ts KnowledgeGeneratorService.test.ts KnowledgeSearch.test.ts
pnpm --filter @ariadne-dev/core build
```

Final result: **pass**

- Focused suite: `63 passed`, `514 passed` tests total in the invoked run.
- Build: `tsc -p tsconfig.json` passed.

Additional targeted checks run during implementation:

```bash
pnpm exec vitest run test/knowledge/KnowledgeWorker.test.ts
pnpm exec vitest run test/Redactor.test.ts test/knowledge/KnowledgeWorker.test.ts test/knowledge/KnowledgeQueue.test.ts test/knowledge/KnowledgeGeneratorService.test.ts test/knowledge/KnowledgeSearch.test.ts
```

## Failure codes implemented

`knowledgeWorkerFailure()` returns stable codes for:

- `source_version_missing`
- `source_content_missing`
- `source_hash_mismatch`
- `source_path_rejected`
- `source_too_large`
- `unsupported_source`
- `analyzer_failed`
- `extraction_persist_failed`
- `graph_persist_failed`
- `generation_failed`
- `lease_lost`
- `cancelled`
- `internal_error`

Notes:

- Unsupported job kinds map to `unsupported_source` per the Task 8 brief.
- Permanent source/version/path/hash/size/unsupported failures are marked non-retryable by the mapper.
- Lease loss is surfaced separately and does not permit success completion.

## Lease, ownership, and cancellation behavior

- `runOnce(projectId)` recovers expired leases before each claim and drains only the requested project queue.
- `processJob(jobId)` rejects jobs that are not currently `running` and owned by the worker.
- Lease renewal runs on an interval of `min(queue lease / 3, leaseRenewIntervalMs)` and is always cleared in `finally`.
- The worker checks abort/ownership/lease expiry before progress writes and before every durable stage transition.
- Cancellation between stages records `cancelled` when the worker still owns the running job.
- Lease loss or ownership drift stops the worker before later durable stages and never produces a success completion.
- Optional enrichment is warning-only; provider failure, invalid output, or persistence trouble produces bounded warnings and does not fail deterministic completion.

## Idempotency outcomes verified

- Reprocessing the same source version through a second analyze job does not duplicate extractions, graph nodes/edges, pages, page versions, reviews, or insights.
- Deterministic page generation reuses unchanged page versions.
- Pending contradiction reviews and research-gap insights are deduplicated on rerun.
- Cross-project claiming and mutation remain isolated to the requested project.

## Rulings

- No manual spec rulings were needed beyond following the Task 8 brief literally.

## Post-implementation review status

Task 8 is **implemented but blocked pending remediation**. Do not mark it
complete or begin Task 9 until these reviewed findings are fixed and
re-reviewed:

1. Make `complete`, `fail`, and owner cancellation single guarded queue updates
   that atomically require the expected running status, worker ownership, and
   an unexpired lease. A stale worker must never finalize a recovered or
   reclaimed job.
2. Persist the `completed` progress stage only after durable queue completion
   succeeds, so failed or requeued jobs cannot retain success-shaped progress.
3. Ground enrichment reviews to page versions generated by the current job.
   Validate or derive insight scope from the current source/page set instead of
   trusting provider-supplied identifiers.
4. Make pending enrichment-review deduplication atomic with a deterministic
   identity or database uniqueness plus conflict handling.
5. Include terminal failures caused by expired-lease recovery in
   `runOnce()` result counts.
6. Require explicit project context when processing a job directly so
   `processJob()` cannot accept an owned job from an unintended project.

Required regression coverage includes lease loss between the last ownership
check and terminal update, completion-update failure after generation,
cross-page enrichment output, concurrent duplicate reviews, exhausted retry
recovery counts, and direct cross-project job processing.
