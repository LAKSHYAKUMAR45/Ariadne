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

## Round 1 follow-up

- Synced the same evaluator extraction, corpus version, synthetic metrics, and
  validation-command evidence into `task-10-report.md` and
  `.superpowers/sdd/2026-09-24-offline-knowledge-worker-implementation-plan/progress.md`.
- Preserved the existing Task 10 / Task 12 history and did not add any new
  real-NAAS claims.

### Focused revalidation outputs

```text
$ cd packages/core && pnpm exec vitest run test/knowledge/KnowledgeWorker.naas.test.ts
RUN  v3.2.7 <repo>/packages/core

✓ test/knowledge/KnowledgeWorker.naas.test.ts (1 test) 884ms
  ✓ KnowledgeWorker synthetic NAAS-shaped acceptance > meets path, citation, and typed-graph thresholds for ten offline worker questions  883ms

Test Files  1 passed (1)
     Tests  1 passed (1)
  Start at  05:04:46
  Duration  1.77s (transform 443ms, setup 20ms, collect 571ms, tests 884ms, environment 0ms, prepare 98ms)

$ python documentation consistency check
Documentation consistency check: PASS
- task-5-report: .superpowers/sdd/2026-09-29-knowledge-search-evaluation/task-5-report.md
- task-10-report: task-10-report.md
- plan-progress: .superpowers/sdd/2026-09-24-offline-knowledge-worker-implementation-plan/progress.md

$ git diff --check
(no output)
```
