# Task 2 Report — Deterministic Ranking and Citation Scoring

## Scope

Implemented the pure scorer in:

- `packages/core/test/knowledge/KnowledgeSearchEvaluator.ts`
- `packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts`

The task-1 corpus parser and fixture were left intact.

## What changed

- Added `KnowledgeAccuracyFailure`, `KnowledgeAccuracyReport`, and
  `KnowledgeAccuracySearchResult` types.
- Implemented `scoreKnowledgeAccuracy(...)` with deterministic ordering,
  required-question filtering, top-1/top-3 counting, span-citation detection,
  typed-graph callback evaluation, and stable failure records.
- Added focused tests for:
  - acceptable-path scoring
  - required-vs-optional question handling
  - failure ordering
  - immutability of corpus input
  - top-three matches from later acceptable paths

## RED / GREEN

- Focused evaluator tests were run in the worktree package context after the
  scorer was added.
- Verification command:

  ```bash
  cd /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/core
  pnpm exec vitest run test/knowledge/KnowledgeSearchEvaluator.test.ts \
    test/knowledge/KnowledgeWorker.naas.test.ts
  ```

## Results

- `KnowledgeSearchEvaluator.test.ts`: pass
- `KnowledgeWorker.naas.test.ts`: pass
- Total: 2 files, 6 tests, 0 failures

## Commit

- Pending at report write time

## Concerns

- None.
