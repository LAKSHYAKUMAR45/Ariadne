# Task 8 report — reusable KnowledgeWorker

## Architecture decisions

- Added `packages/core/src/knowledge/KnowledgeWorker.ts` as the project-scoped staged worker that composes queue claim/recovery, immutable source loading, analyzer selection, extraction persistence, typed graph materialization, deterministic page generation, optional enrichment, and terminal queue transitions.
- Kept the worker reusable by defaulting concrete services from the core package while allowing dependency injection for queue, loader, analyzers, extraction store, graph materializer, generator, and page builder.
- Extended `KnowledgeGeneratorService.runKnowledgeGeneration(jobId, payloadOverride?, { completeJob? })` so Task 8 can reuse the deterministic page pipeline without introducing duplicate orchestration. `completeJob: false` leaves final queue completion/failure ownership with `KnowledgeWorker`.
- Hardened queue metadata persistence so result warnings, failure messages, progress stages, and progress detail keys/values are bounded and secret-redacted before durable storage.
- Aligned generator lease renewal with the worker queue lease duration to avoid generation extending leases past the queue policy.
- Fixed `KnowledgePageStore.resolveSourceSpanId()` to select `span.id`, which unblocked deterministic source-page provenance and exact-span search citations during worker generation.
- Expanded OpenAI key redaction to catch hyphenated and underscore-containing keys (including `sk-proj-..._...`) and added a regression test.
- Hardened worker-owned terminal transitions so `complete`, `fail`, and owner cancellation each perform a single guarded SQL update that requires the job id, `running` status, expected worker, and an unexpired lease at update time.
- Moved final `completed` progress persistence into the guarded completion transaction so success-shaped progress only appears when durable completion commits.
- Added enrichment grounding for reviews and insights so provider output can only target current-run page versions or current source/page paths, with bounded `enrichment_ungrounded` warnings for skipped items.
- Added atomic pending-review deduplication with migration-backed uniqueness plus `INSERT OR IGNORE`/reuse logic, including separate-connection regression coverage.
- Required explicit project context for direct processing via `processJob(projectId, jobId)` and counted expired-lease terminal failures in `runOnce()` results.
- Fix-all round 2 hardened lease renewal into a single guarded compare-and-swap, made admin cancel/retry transitions reject concurrent ownership/state drift, isolated invalid enrichment items into bounded per-item warnings without dropping valid siblings, and re-parented duplicate review audit actions during migration dedupe.

## RED evidence

Regression RED run before the fixes:

```bash
pnpm exec vitest run test/knowledge/KnowledgeQueue.test.ts test/knowledge/KnowledgeWorker.test.ts test/knowledge/knowledgeMigrations.test.ts
```

Result: **failed** with the expected Task 8 review regressions:

- lease renewal succeeded after expiry and after concurrent ownership drift
- admin cancel/retry still overwrote concurrent owner/claim changes
- one invalid enrichment item still collapsed the whole enrichment batch into `enrichment_failed`
- duplicate pending-review migration still deleted later reviews without re-parenting their action audit history

## GREEN evidence

Focused required validation:

```bash
pnpm exec vitest run test/knowledge/KnowledgeQueue.test.ts test/knowledge/KnowledgeReview.test.ts test/knowledge/KnowledgeWorker.test.ts test/knowledge/knowledgeMigrations.test.ts test/knowledge/KnowledgeGeneratorService.test.ts test/knowledge/KnowledgeSearch.test.ts
pnpm --filter @ariadne-dev/core test
pnpm --filter @ariadne-dev/core build
```

Final result: **pass**

- Focused suite: `68 passed`.
- Full core suite: `526 passed`.
- Build: `tsc -p tsconfig.json` passed.

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
- `processJob(projectId, jobId)` rejects jobs that are not currently `running`, owned by the worker, and scoped to the requested project.
- Lease renewal runs on an interval of `min(queue lease / 3, leaseRenewIntervalMs)` and is always cleared in `finally`.
- The worker checks abort/ownership/lease expiry before progress writes and before every durable stage transition.
- Cancellation between stages records `cancelled` when the worker still owns the running job.
- Lease loss or ownership drift stops the worker before later durable stages and never produces a success completion.
- Optional enrichment is warning-only; provider failure, invalid output, or persistence trouble produces bounded warnings and does not fail deterministic completion.

## Idempotency outcomes verified

- Reprocessing the same source version through a second analyze job does not duplicate extractions, graph nodes/edges, pages, page versions, reviews, or insights.
- Mixed valid/invalid enrichment reruns keep the same grounded review/insight IDs while re-emitting only bounded warnings for the invalid siblings.
- Deterministic page generation reuses unchanged page versions.
- Pending contradiction reviews and research-gap insights are deduplicated on rerun.
- Cross-project claiming and mutation remain isolated to the requested project.

## Rulings

- No manual spec rulings were needed beyond following the Task 8 brief literally.

## Post-implementation review status

Task 8 review remediation is **resolved**. The remaining fix-all findings are
now covered by regression tests and fixed in code:

1. lease renewal is a single guarded update that rejects expired or stolen leases
2. admin cancel/retry paths use guarded state predicates and reject TOCTOU drift
3. enrichment invalid items emit bounded per-item warnings while valid siblings persist
4. duplicate pending-review migration re-parents `knowledge_review_actions` instead of deleting history
5. lease-loss races during failure handling degrade to expected worker races instead of aborting the drain loop
6. grounded project-level enrichment reviews remain supported when no page version ID is supplied

Task 8 can be considered complete from the core worker perspective. Do not
start Task 9 from this report update alone; follow the plan sequencing
outside this file.
