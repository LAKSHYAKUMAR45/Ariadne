# Task 2 Report — Knowledge benchmark metrics

## Files changed
- `packages/core/test/knowledge/KnowledgeBenchmarkMetrics.ts`
- `packages/core/test/knowledge/KnowledgeBenchmarkMetrics.test.ts`

## RED
Command:
```bash
cd /home/lkumar/Ariadne/.worktrees/knowledge-benchmark-baseline && pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeBenchmarkMetrics.test.ts
```
Outcome:
- Failed as expected because `./KnowledgeBenchmarkMetrics.js` did not exist yet.

## GREEN
Implemented a pure metric module that:
- calculates recall@1/@3/@10
- calculates mean reciprocal rank
- calculates nDCG@10 with the ideal denominator capped at `min(expectedPaths.length, 10)`
- calculates zero-result, ambiguity, exact span citation, and typed graph evidence rates
- validates empty outcomes, duplicate ids, empty expected paths, invalid percentile inputs, and non-finite numeric inputs
- rounds public metrics to six decimals without mutating caller arrays

## Verification
Commands:
```bash
cd /home/lkumar/Ariadne/.worktrees/knowledge-benchmark-baseline && pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeBenchmarkMetrics.test.ts
cd /home/lkumar/Ariadne/.worktrees/knowledge-benchmark-baseline && pnpm --filter @ariadne-dev/core build
```
Outcomes:
- Focused vitest suite passed: 7 tests passed.
- Core package TypeScript build passed.

## Formula / validation notes
- Recall counts are question-level hits at the requested cutoff.
- MRR uses the first relevant result rank, with zero for misses.
- nDCG@10 uses binary relevance, discounts via `1 / log2(rank + 1)`, and an ideal denominator bounded by `min(expectedPaths.length, 10)`.
- `nearestRankPercentile` uses the nearest-rank rule with `ceil(percentile * n) - 1`.
- Validation rejects:
  - empty outcome lists
  - duplicate outcome ids
  - empty expected-path lists
  - invalid percentile values outside `(0, 1]`
  - non-finite numeric inputs

## Commit
- `bf26614` — `test(knowledge): add benchmark metric formulas`

## Self-review
- Kept the implementation pure and localized to the requested benchmark test area.
- Preserved caller immutability by cloning before sorting and by avoiding in-place updates.
- Added coverage for the requested success and failure cases, including the nDCG denominator behavior.

## Concerns
- None identified for this scoped metric task.

## Fix Round 1

### Covering test
- Added `only counts ambiguity when the leading result is ambiguous` to ensure lower-ranked ambiguous results do not increase `ambiguityRate` when rank 1 is clear or null.

### Commands
```bash
cd /home/lkumar/Ariadne/.worktrees/knowledge-benchmark-baseline && pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeBenchmarkMetrics.test.ts
cd /home/lkumar/Ariadne/.worktrees/knowledge-benchmark-baseline && pnpm --filter @ariadne-dev/core build
```

### Outcomes
- RED: the new regression test failed before the fix because ambiguity was counted from any ranked result.
- GREEN: `KnowledgeBenchmarkMetrics.ts` now inspects only `outcome.results[0]` when determining ambiguity.
- Verification: targeted vitest suite passed and the core build succeeded.

### Commit
- Pending at report append time; created after verification.
