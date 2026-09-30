# Task 4 Report: evaluator safety and determinism regressions

## Scope

- Added evaluator regressions for safe failure serialization, optional-question
  callback skipping, and byte-for-byte deterministic repeated runs.
- Implemented bounded evidence projection in the knowledge accuracy scorer.
- Documented the evaluator command, fixture version, report contract, and
  evidence-safety boundary.

## RED

- Added failing coverage in
  `packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts` for:
  - non-required questions skipping typed-graph callbacks
  - source-content redaction from serialized reports
  - identical-input deterministic serialization
- Ran:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeSearchEvaluator.test.ts
```

- Observed the expected failure before the implementation change:
  `does not invoke graph evidence for non-required questions`

## GREEN

- Updated `scoreKnowledgeAccuracy(...)` to:
  - skip all scoring callbacks for non-required questions
  - project search results to `{ title, hasSpanCitation }` before scoring
  - keep failures bounded to ids, prompts, expected paths, returned paths, and
    missing metric names
- Extended the synthetic acceptance test to assert serialized reports do not
  leak fixture source content.

## IMPROVE

- Documented `naas-v1`, the evaluator test command, threshold semantics, and
  the safe-to-export report contract in `docs/knowledge-worker.md`.
- Clarified that real NAAS scoring stays read-only and external to CI.

## Validation

```bash
pnpm --filter @ariadne-dev/core exec vitest run \
  test/knowledge/KnowledgeSearchEvaluator.test.ts \
  test/knowledge/KnowledgeWorker.naas.test.ts
pnpm --filter @ariadne-dev/core build
```

Expected outcome: passing focused regressions and core build.

## Round 1 fix

- Replaced the repo-root documentation example with
  `pnpm --filter @ariadne-dev/core run test:knowledge:evaluation`.
- Added `test:knowledge:evaluation` to `packages/core/package.json` so the
  focused evaluator command stays anchored to package-local test paths when it
  is launched from the repository root.

### Repo-root verification

```bash
pnpm --filter @ariadne-dev/core run test:knowledge:evaluation
```

```text
> @ariadne-dev/core@0.1.0 test:knowledge:evaluation /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/core
> vitest run test/knowledge/KnowledgeSearchEvaluator.test.ts test/knowledge/KnowledgeWorker.naas.test.ts

 RUN  v3.2.7 /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/core

 ✓ test/knowledge/KnowledgeSearchEvaluator.test.ts (9 tests) 26ms
 ✓ test/knowledge/KnowledgeWorker.naas.test.ts (1 test) 1051ms
   ✓ KnowledgeWorker synthetic NAAS-shaped acceptance > meets path, citation, and typed-graph thresholds for ten offline worker questions  1049ms

 Test Files  2 passed (2)
      Tests  10 passed (10)
   Start at  04:48:38
   Duration  1.97s (transform 527ms, setup 27ms, collect 839ms, tests 1.08s, environment 0ms, prepare 227ms)
```
