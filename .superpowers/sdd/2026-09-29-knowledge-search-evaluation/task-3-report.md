# Task 3 Report — Reuse evaluator in synthetic NAAS acceptance

## Scope

Refactored the synthetic NAAS-shaped acceptance test to reuse the shared
knowledge-search parser/scorer introduced by Tasks 1–2 while preserving:

- fixture ingestion
- offline worker execution
- queue drain assertions
- terminal-job assertions
- existing thresholds

### Files changed

- `packages/core/test/knowledge/KnowledgeWorker.naas.test.ts`
- `packages/core/test/knowledge/KnowledgeSearchEvaluator.ts`
- `packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts`

## RED

Added corpus-shape expectations to the synthetic NAAS acceptance test before
removing the local scorer:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeWorker.naas.test.ts
```

Failure:

- report keys were missing `corpusVersion` and `failures`

## GREEN

Replaced the integration test’s local accuracy scorer with
`scoreKnowledgeAccuracy()` and parsed the fixture as a full
`KnowledgeAccuracyCorpus`.

Moved the typed graph-evidence SQL helper into
`KnowledgeSearchEvaluator.ts` as `hasKnowledgeTypedGraphEvidence()` and made
`projectId` an explicit parameter so the reusable helper does not rely on a
hard-coded project.

The acceptance test now asserts:

- evaluator report shape
- `corpusVersion === 'naas-v1'`
- `failures === []`
- preserved top-3 / span / typed-graph thresholds

## IMPROVE

Added focused evaluator coverage proving the shared typed-graph helper honors
the supplied `projectId`, preventing cross-project leakage and locking in the
new reusable adapter behavior.

## Tests run

- `pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeSearchEvaluator.test.ts test/knowledge/KnowledgeWorker.naas.test.ts`
  - pass: `2` files, `7` tests
- `pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeWorker.naas.test.ts`
  - pass: `1` file, `1` test

## Concerns

- None.
