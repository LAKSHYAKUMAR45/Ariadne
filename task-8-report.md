# Task 8 Report — Final Fix Round

## Scope
Applied the final Task 8 fixes for queue cancellation and public review creation in:

- `packages/core/src/knowledge/KnowledgeQueue.ts`
- `packages/core/src/knowledge/KnowledgeReview.ts`
- `packages/core/src/index.ts`
- focused core/CLI regressions

No `nodem2/network/deployment/sync` files were touched. The unrelated unstaged plan file remained untouched.

## RED
Initial focused RED commands:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeQueue.test.ts test/knowledge/KnowledgeReview.test.ts
pnpm --filter @ariadne-dev/cli exec vitest run test/knowledgeCommands.test.ts
```

Initial failures recorded before implementation:

- `KnowledgeQueue > rejects manual cancellation for expired running leases until recovery accounts for lease expiry`
  - `queue.cancel()` still cancelled an expired running job directly, leaving `retryCount = 0` and bypassing recovery accounting.
- `KnowledgeReview > reuses an existing pending review for the same logical identity instead of surfacing a SQLite uniqueness error`
  - `createKnowledgeReview()` leaked raw SQLite `UNIQUE constraint failed` for duplicate pending identities.
- `KnowledgeReview > throws a stable domain error when review creation conflicts without a reusable pending identity`
  - conflicting creation still surfaced raw SQLite constraint text instead of a domain-safe error.
- `KnowledgeReview > reuses the pending review for concurrent create requests across SQLite connections`
  - concurrent create still failed with a raw uniqueness error.
- `ariadne knowledge commands > review > reuses an existing pending review for the same project identity`
  - the CLI returned an error JSON payload instead of deterministically reusing the pending review.

## GREEN
Focused GREEN commands:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeQueue.test.ts test/knowledge/KnowledgeReview.test.ts test/knowledge/KnowledgeWorker.test.ts test/knowledge/knowledgeMigrations.test.ts
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/cli exec vitest run test/knowledgeCommands.test.ts
```

Results:

- focused core knowledge suites: pass (`4` files / `44` tests)
- focused CLI knowledge suite: pass (`1` file / `13` tests)

Full validation:

```bash
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/cli build
pnpm --filter @ariadne-dev/core test
pnpm --filter @ariadne-dev/cli test
```

Results:

- core build: pass (`tsc -p tsconfig.json`)
- CLI build: pass (`tsc -p tsconfig.json`)
- full core tests: pass (`63` files / `530` tests)
- full CLI tests: pass (`12` files / `116` tests)

## Fix summary

### 1. Manual cancellation now respects active running leases

- `KnowledgeQueue.cancel()` still cancels queued jobs exactly as before.
- Running-job cancellation now requires the current lease to still be active (`lease_expires_at > now`) and to still belong to the observed worker.
- If the lease has expired before cancellation applies, cancellation now fails with a stable lease-transition error instead of silently converting the job to `cancelled`.
- Recovery remains the only path that increments `retry_count`, requeues within retry budget, or records the terminal `lease_expired` failure.

### 2. Expired-running cancel can no longer bypass recovery accounting

- Added a regression proving an expired running job cannot be manually cancelled into `cancelled` with `retryCount = 0`.
- The same test proves `recoverExpiredKnowledgeJobs()` performs the first state transition and increments the retry count.
- Existing race coverage still guards concurrent owner/state changes during cancellation and retry.

### 3. Public review creation now reuses deterministic pending identities

- `createKnowledgeReview()` now checks for an existing reusable pending review with the same `(projectId, pageVersionId, summary)` identity before insert.
- If a concurrent insert wins first, uniqueness is caught and converted into deterministic reuse instead of leaking raw SQLite text.
- This matches `ensurePendingKnowledgeReview()` behavior for logical identity while preserving explicit create semantics for non-reusable cases.

### 4. Non-reusable review conflicts now surface a domain error

- Added `KnowledgeReviewConflictError` for create-time conflicts that cannot be safely reused.
- Raw SQLite `UNIQUE constraint failed` messages are no longer exposed through the public review-creation API.
- The new error message is contextual and stable (`Knowledge pending review already exists ...`).

### 5. No duplicate review race regression

- Added a two-connection regression showing concurrent `createKnowledgeReview()` calls converge on the same pending review instead of creating duplicates or surfacing SQLite uniqueness errors.
- Existing migration/index tests still validate the deterministic pending-review indexes and deduplication behavior for pre-index duplicate data.
- Existing resolve/reopen action-history coverage remains intact.

## Migration ruling

No schema migration was required for this round.

Ruling: the existing pending-review partial unique indexes are correct; the fix belongs in the public creation path and queue transition guards, not in new schema or index changes.

## Security / audit notes

- No raw SQLite constraint strings are surfaced through `createKnowledgeReview()` or the CLI review-create path for pending-review identity collisions.
- Queue cancellation no longer lets an expired running lease erase retry/failure accounting by forcing a direct `cancelled` terminal state.
- Concurrency remains guarded with compare-and-update predicates; racing owner/state changes still fail closed with transition errors.
- TypeScript reviewer pass found no additional correctness concerns in the scoped changes.

## Files changed

- `packages/core/src/knowledge/KnowledgeQueue.ts`
- `packages/core/src/knowledge/KnowledgeReview.ts`
- `packages/core/src/index.ts`
- `packages/core/test/knowledge/KnowledgeQueue.test.ts`
- `packages/core/test/knowledge/KnowledgeReview.test.ts`
- `packages/cli/test/knowledgeCommands.test.ts`
- `task-8-report.md`

## Remaining concerns

- Filtered CLI tests in this workspace consume the current `@ariadne-dev/core` build output at the package boundary, so the reliable validation order is to build core before running the focused/full CLI suites.
