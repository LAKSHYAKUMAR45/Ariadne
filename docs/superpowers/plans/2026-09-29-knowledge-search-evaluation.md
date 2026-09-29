# Knowledge Search Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a versioned, deterministic, providerless search evaluator that detects ranking, exact-span citation, typed-graph, malformed-fixture, and ordering regressions.

**Architecture:** Keep evaluation code in the core test support layer so production search APIs and schemas remain unchanged. A validated fixture corpus feeds a pure scoring layer; the existing synthetic NAAS test supplies database-backed graph evidence through a narrow callback and asserts the declared thresholds.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, existing `searchKnowledge`, existing synthetic NAAS fixtures.

**Spec:** `docs/superpowers/specs/2026-09-29-knowledge-search-evaluation-design.md`

## Global Constraints

- Do not change `searchKnowledge` behavior or its public API in this slice.
- Do not contact providers, remote services, SSH hosts, or the real NAAS workspace.
- Do not persist evaluation queries or source contents in production tables.
- Keep evidence limited to stable IDs, paths, scores, citation presence, and failure metadata.
- Preserve the initial thresholds: at least 8/10 top-three hits, 10/10 exact-span citations, and at least 8/10 typed-graph evidence hits.
- Top-one remains a reported optimization metric, not an acceptance gate.
- Follow RED → GREEN → IMPROVE for every behavior change.
- Use stable fixture ordering and stable serialized result ordering.

---

### Task 1: Define and validate the versioned question corpus

**Files:**
- Modify: `packages/core/test/knowledge/fixtures/naas/questions.json`
- Create: `packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts`

**Interfaces:**
- Produces the fixture contract consumed by later tasks:
  `corpusVersion`, `questions[]`, and each question’s `id`, `prompt`,
  `expectedPaths`, `expectedSymbols`, and `required`.

- [ ] **Step 1: Write failing fixture-validation tests**

Add tests covering the accepted shape and invalid inputs:

```ts
it('requires stable ids, prompts, expected paths, symbols, and required flags', () => {
  expect(() => parseKnowledgeAccuracyCorpus({
    corpusVersion: 'naas-v1',
    questions: [{
      id: 'q1',
      prompt: 'find the loader',
      expectedPaths: ['task-managers/use_case.py'],
      expectedSymbols: ['UseCaseLoader'],
      required: true,
    }],
  })).not.toThrow();
});

it('rejects duplicate ids, empty prompts, and empty expected paths', () => {
  expect(() => parseKnowledgeAccuracyCorpus({
    corpusVersion: 'naas-v1',
    questions: [{
      id: 'q1',
      prompt: '',
      expectedPaths: [],
      expectedSymbols: [],
      required: true,
    }, {
      id: 'q1',
      prompt: 'duplicate',
      expectedPaths: ['x.py'],
      expectedSymbols: [],
      required: true,
    }],
  })).toThrow(/questions|prompt|expectedPaths|duplicate/i);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeSearchEvaluator.test.ts
```

Expected: FAIL because `parseKnowledgeAccuracyCorpus` does not exist.

- [ ] **Step 3: Implement the minimal corpus parser**

Create `KnowledgeSearchEvaluator.ts` with:

```ts
export interface KnowledgeAccuracyQuestion {
  id: string;
  prompt: string;
  expectedPaths: string[];
  expectedSymbols: string[];
  required: boolean;
}

export interface KnowledgeAccuracyCorpus {
  corpusVersion: string;
  questions: KnowledgeAccuracyQuestion[];
}

export function parseKnowledgeAccuracyCorpus(input: unknown): KnowledgeAccuracyCorpus;
```

Validate plain-object input, non-empty `corpusVersion`, non-empty string
fields, unique IDs, non-empty expected paths, and boolean `required`. Return
new arrays rather than retaining caller-owned mutable arrays.

- [ ] **Step 4: Migrate the fixture from `query` to `prompt` and add metadata**

Update every question in `questions.json` from `"query"` to `"prompt"` and add
`"required": true`. Preserve all existing IDs, paths, and symbols. Keep the
fixture order unchanged.

- [ ] **Step 5: Run the focused tests**

Run the evaluator test file again. Expected: all parser tests pass.

- [ ] **Step 6: Commit the corpus contract**

```bash
git add packages/core/test/knowledge/KnowledgeSearchEvaluator.ts \
  packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts \
  packages/core/test/knowledge/fixtures/naas/questions.json
git commit -m "test(knowledge): define versioned search corpus"
```

### Task 2: Implement deterministic ranking and citation scoring

**Files:**
- Modify: `packages/core/test/knowledge/KnowledgeSearchEvaluator.ts`
- Modify: `packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts`

**Interfaces:**
- Consumes `KnowledgeAccuracyCorpus` from Task 1.
- Produces:

```ts
export interface KnowledgeAccuracyFailure {
  id: string;
  prompt: string;
  expectedPaths: string[];
  returnedPaths: string[];
  missing: string[];
}

export interface KnowledgeAccuracyReport {
  corpusVersion: string;
  questionCount: number;
  top1PathHits: number;
  top3PathHits: number;
  spanCitationHits: number;
  typedGraphEvidenceHits: number;
  failures: KnowledgeAccuracyFailure[];
}

export interface KnowledgeAccuracySearchResult {
  title: string;
  citations: ReadonlyArray<{ span: unknown }>;
}

export function scoreKnowledgeAccuracy(
  corpus: KnowledgeAccuracyCorpus,
  search: (prompt: string) => readonly KnowledgeAccuracySearchResult[],
  hasTypedGraphEvidence: (question: KnowledgeAccuracyQuestion, path: string) => boolean,
): KnowledgeAccuracyReport;
```

- [ ] **Step 1: Write failing scoring tests**

Cover top-one/top-three counting, multiple acceptable paths, span presence,
typed-graph callbacks, required-question filtering, failure details, and
stable output:

```ts
it('scores acceptable paths and records only failed required questions', () => {
  const report = scoreKnowledgeAccuracy(corpus, (prompt) => prompt === 'q1'
    ? [{ title: 'a.py', citations: [{ span: { startOffset: 1 } }] }]
    : [{ title: 'wrong.py', citations: [{ span: null }] }],
  ), (question, path) => question.id === 'q1' && path === 'a.py');

  expect(report).toMatchObject({
    questionCount: 2,
    top1PathHits: 1,
    top3PathHits: 1,
    spanCitationHits: 1,
    typedGraphEvidenceHits: 1,
  });
  expect(report.failures[0]).toMatchObject({
    id: 'q2',
    returnedPaths: ['wrong.py'],
    missing: ['top1', 'top3', 'spanCitation', 'typedGraphEvidence'],
  });
});

it('keeps failure ordering equal to corpus ordering and does not mutate inputs', () => {
  const original = structuredClone(corpus);
  const report = scoreKnowledgeAccuracy(corpus, () => [], () => false);
  expect(corpus).toEqual(original);
  expect(report.failures.map(({ id }) => id)).toEqual(['q1', 'q2']);
});
```

- [ ] **Step 2: Run the scoring tests to verify they fail**

Run the focused evaluator test. Expected: FAIL because the scoring function is
not implemented.

- [ ] **Step 3: Implement the minimal pure scorer**

For each question, call `search(prompt)`, derive returned titles in order,
count an exact expected-path match at positions 0 and 0–2, and count a citation
hit only when an expected result has a citation whose `span !== null`. Call the
typed-graph callback once per expected path until one succeeds. Add missing
labels in deterministic order:

```ts
const missing = [
  top3 ? null : 'top3',
  spanCitation ? null : 'spanCitation',
  typedGraph ? null : 'typedGraphEvidence',
].filter((value): value is string => value !== null);
```

Top-one is diagnostic only: it is counted in `top1PathHits` but never appears
in `missing` and never records a failure. Only `required: true` questions
affect threshold counters and failures;
`questionCount` reports the full corpus size.

- [ ] **Step 4: Run the scoring tests**

Expected: all scorer tests pass.

- [ ] **Step 5: Commit the pure evaluator**

```bash
git add packages/core/test/knowledge/KnowledgeSearchEvaluator.ts \
  packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts
git commit -m "test(knowledge): add deterministic search scorer"
```

### Task 3: Refactor synthetic NAAS acceptance to use the evaluator

**Files:**
- Modify: `packages/core/test/knowledge/KnowledgeWorker.naas.test.ts`
- Modify: `packages/core/test/knowledge/KnowledgeSearchEvaluator.ts`
- Modify: `packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts`

**Interfaces:**
- Consumes the existing database setup, `searchKnowledge`, and graph-evidence
  query from `KnowledgeWorker.naas.test.ts`.
- Produces the same acceptance report plus `corpusVersion` and failures.

- [ ] **Step 1: Write a failing integration assertion for corpus-backed scoring**

Replace the test’s direct JSON cast and local `scoreAccuracy` call with the
new parser/scorer imports, but initially assert the new `corpusVersion` field:

```ts
expect(report.corpusVersion).toBe('naas-v1');
```

Run the synthetic acceptance test. Expected: FAIL because the current local
scorer does not return corpus metadata or failure details.

- [ ] **Step 2: Implement the integration adapter**

Load the fixture as `unknown`, parse it with `parseKnowledgeAccuracyCorpus`,
and call `scoreKnowledgeAccuracy` with:

```ts
const report = scoreKnowledgeAccuracy(
  corpus,
  (prompt) => searchKnowledge(prompt, {
    db,
    projectId: PROJECT_ID,
    mode: 'sources',
  }),
  (question, sourcePath) => hasTypedGraphEvidence(
    db,
    sourcePath,
    question.expectedSymbols,
  ),
);
```

Move the existing graph-evidence SQL helper into the evaluator module only
after parameterizing `projectId`; do not retain a hard-coded project ID in a
reusable helper. Keep fixture ingestion, worker execution, queue assertions,
and terminal-job assertions in the integration test.

- [ ] **Step 3: Preserve and strengthen threshold assertions**

Assert the report shape, corpus version, and existing thresholds through the
declared `KNOWLEDGE_ACCEPTANCE_THRESHOLDS` and `evaluateKnowledgeAcceptanceGate`
(not `failures=[]`, which would implicitly gate every metric):

```ts
expect(report.questionCount).toBe(10);
expect(report.top3PathHits).toBeGreaterThanOrEqual(8);
expect(report.spanCitationHits).toBe(10);
expect(report.typedGraphEvidenceHits).toBeGreaterThanOrEqual(8);
expect(evaluateKnowledgeAcceptanceGate(report)).toEqual([]);
```

Do not add a top-one threshold.

- [ ] **Step 4: Run the synthetic acceptance test**

Run:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeWorker.naas.test.ts
```

Expected: PASS with the existing offline fixture and unchanged search
behavior.

- [ ] **Step 5: Commit the integration refactor**

```bash
git add packages/core/test/knowledge/KnowledgeWorker.naas.test.ts \
  packages/core/test/knowledge/KnowledgeSearchEvaluator.ts \
  packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts
git commit -m "test(knowledge): reuse search evaluator in NAAS acceptance"
```

### Task 4: Add explicit evaluator safety and determinism regressions

**Files:**
- Modify: `packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts`
- Modify: `packages/core/test/knowledge/KnowledgeWorker.naas.test.ts`
- Modify: `docs/knowledge-worker.md`

**Interfaces:**
- Consumes the scorer and corpus from Tasks 1–3.
- Produces documented evidence semantics and deterministic failure diagnostics.

- [ ] **Step 1: Write failing safety tests**

Add tests that prove:

```ts
it('does not expose source contents in failures', () => {
  const report = scoreKnowledgeAccuracy(corpus, () => [{
    title: 'secret.py',
    citations: [{ span: null }],
    snippet: 'must not be serialized',
  }], () => false);

  expect(JSON.stringify(report)).not.toContain('must not be serialized');
});

it('does not invoke graph evidence for non-required questions', () => {
  let calls = 0;
  scoreKnowledgeAccuracy({ ...corpus, questions: [
    { ...corpus.questions[0], required: false },
  ]}, () => [], () => {
    calls += 1;
    return true;
  });
  expect(calls).toBe(0);
});
```

Also add a repeated-run test that serializes two reports from identical inputs
and expects byte-for-byte equality.

- [ ] **Step 2: Run the safety tests to verify they fail**

Run the focused evaluator test. Expected: FAIL until result serialization
excludes snippets and optional questions are skipped.

- [ ] **Step 3: Implement bounded evidence projection**

Project search results to titles and boolean citation-span presence before
constructing failures. Never copy snippets, metadata, source content, provider
responses, or arbitrary result fields into the report. Skip all scoring
callbacks for non-required questions.

- [ ] **Step 4: Document the evaluator command and report contract**

Update `docs/knowledge-worker.md` with the fixture version, report fields,
thresholds, and the fact that evidence contains paths/metrics only and is safe
to write outside repositories. State that the real NAAS scorer remains
read-only and external to CI.

- [ ] **Step 5: Run focused validation**

```bash
pnpm --filter @ariadne-dev/core exec vitest run \
  test/knowledge/KnowledgeSearchEvaluator.test.ts \
  test/knowledge/KnowledgeWorker.naas.test.ts
pnpm --filter @ariadne-dev/core build
```

Expected: PASS.

- [ ] **Step 6: Commit the safety and documentation changes**

```bash
git add packages/core/test/knowledge/KnowledgeSearchEvaluator.test.ts \
  packages/core/test/knowledge/KnowledgeWorker.naas.test.ts \
  docs/knowledge-worker.md
git commit -m "test(knowledge): harden search evaluation evidence"
```

### Task 5: Run the complete regression gate and record the milestone

**Files:**
- Modify: `task-10-report.md`
- Modify: `.superpowers/sdd/2026-09-24-offline-knowledge-worker-implementation-plan/progress.md`

**Interfaces:**
- Consumes the evaluator and synthetic acceptance results from Tasks 1–4.
- Produces a recorded benchmark milestone without changing production behavior.

- [ ] **Step 1: Run all required validation**

```bash
pnpm --filter @ariadne-dev/core test
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/cli test
pnpm --filter @ariadne-dev/cli build
git diff --check
```

Expected: all tests and builds pass; the CLI’s known unrelated noisy stderr
line may remain but must not cause a nonzero exit.

- [ ] **Step 2: Verify the synthetic report metrics**

Confirm the evaluator reports:

```text
questionCount=10
top3PathHits>=8
spanCitationHits=10
typedGraphEvidenceHits>=8
gate violations=[] (top-one reported, not gated)
```

Do not run the real NAAS worker or mutate `/home/lkumar/atom`.

- [ ] **Step 3: Update the task evidence**

Record the evaluator extraction, corpus version, metrics, and validation
commands in `task-10-report.md` and the SDD progress ledger. Keep real
workspace paths and external evidence locations out of tracked test output.

- [ ] **Step 4: Commit the completed evaluation slice**

```bash
git add task-10-report.md \
  .superpowers/sdd/2026-09-24-offline-knowledge-worker-implementation-plan/progress.md
git commit -m "test(knowledge): establish search regression gate"
```
