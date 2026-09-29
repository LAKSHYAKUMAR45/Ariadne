# Task 5 Report — Regression Gate and Synthetic Acceptance Milestone

## Scope

Recorded the completed knowledge-search evaluation gate for the synthetic
NAAS-shaped acceptance corpus.

This task only updated evidence artifacts. No production code changed, and the
real NAAS worker was not run.

## Evaluator / corpus evidence

- Evaluator entrypoint:
  - `packages/core/test/knowledge/KnowledgeWorker.naas.test.ts`
- Shared scorer:
  - `packages/core/test/knowledge/KnowledgeSearchEvaluator.ts`
- Corpus version:
  - `naas-v1`

The synthetic acceptance flow parses the versioned corpus, runs the offline
worker against the fixture sources, and scores the resulting search output with
typed graph evidence checks.

## Verified synthetic metrics

The synthetic acceptance thresholds were met:

- `questionCount=10`
- `top3PathHits>=8`
- `spanCitationHits=10`
- `typedGraphEvidenceHits>=8`
- `failures=[]`

The acceptance test also confirmed:

- the report shape is stable
- the corpus version remains `naas-v1`
- terminal job state is clean after the offline worker run
- serialized evidence stays free of fixture source-content leakage

## Validation commands

```bash
pnpm --filter @ariadne-dev/core test
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/cli test
pnpm --filter @ariadne-dev/cli build
git diff --check
cd packages/core && pnpm exec vitest run test/knowledge/KnowledgeWorker.naas.test.ts
```

## Concerns

- The CLI test suite still prints the known unrelated noisy stderr line during
  the broader run, but the suite exits successfully and the regression gate
  remains green.
