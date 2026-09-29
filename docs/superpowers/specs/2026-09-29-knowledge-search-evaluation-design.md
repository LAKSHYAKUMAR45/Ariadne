# Knowledge Search Evaluation and Regression Design

## Purpose

Establish a repeatable, versioned evaluation layer for deterministic knowledge
search before changing retrieval, indexing, or answer synthesis. The evaluator
must detect regressions in ranking, exact-span citations, project isolation,
determinism, and resource bounds without contacting providers or remote
services.

## Scope

This first improvement slice covers:

- A versioned question corpus with expected source paths and acceptable ranking
  thresholds.
- Reusable scoring helpers for top-one, top-three, citation-span, and
  typed-graph evidence.
- Per-question evidence output that is deterministic and safe to store outside
  the repository when it contains real workspace paths.
- Regression tests over the existing synthetic NAAS-shaped fixtures.
- Clear failure diagnostics identifying the question, expected paths, returned
  paths, and missing evidence.

The existing search implementation and public search API remain unchanged in
this slice. The current real NAAS evidence remains an external acceptance
artifact and is not copied into the repository.

## Non-goals

- Changing ranking weights or adding semantic retrieval.
- Adding provider calls, embeddings, or network dependencies.
- Requiring the real `/home/lkumar/atom` workspace in unit or CI tests.
- Treating top-one accuracy as a release gate when the approved acceptance
  threshold is top-three accuracy.
- Persisting user queries or source content in production tables.

## Design

`packages/core/test/knowledge/fixtures/naas/questions.json` remains the
versioned corpus format. Each question declares:

- `id`: stable identifier.
- `prompt`: query text.
- `expectedPaths`: one or more acceptable evidence paths.
- `required`: whether the question participates in threshold scoring.

The evaluator loads the fixture corpus, runs deterministic source search
against a freshly built synthetic project, and returns:

```ts
{
  corpusVersion: string;
  questionCount: number;
  top1PathHits: number;
  top3PathHits: number;
  spanCitationHits: number;
  typedGraphEvidenceHits: number;
  failures: Array<{
    id: string;
    prompt: string;
    expectedPaths: string[];
    returnedPaths: string[];
    missing: string[];
  }>;
}
```

Scoring is path-strict for declared expected paths and span-strict for
citations. A question passes the citation criterion only when an expected
source appears in the returned results with a persisted span. Typed graph
evidence is checked through the existing graph expansion/provenance contract.
All result ordering and serialized evidence use stable sorting.

Thresholds are declared with the corpus or test configuration rather than
hidden in scorer logic. The initial synthetic gate remains:

- at least 8/10 top-three path hits;
- 10/10 exact-span citation hits;
- at least 8/10 typed-graph evidence hits.

Top-one is reported as an optimization metric but is not the acceptance gate:
it never appears in a failure's `missing` list, and the gate is evaluated
against the declared thresholds rather than by requiring `failures` to be empty.

## Failure handling and safety

Malformed fixture entries fail the evaluator with a descriptive validation
error. Search failures are reported per question only when the test explicitly
exercises a recoverable malformed source; otherwise the test fails. The
evaluator must not mutate the real NAAS database, make provider requests, or
write generated artifacts into tracked source directories.

Evidence output is limited to paths, scores, citation-presence flags, and
stable identifiers. It must not include source contents, secrets, or provider
responses.

## Validation

Implementation will follow RED → GREEN → IMPROVE:

1. Add scorer unit tests for pass, fail, malformed corpus, multiple acceptable
   paths, missing spans, and deterministic ordering.
2. Refactor the existing synthetic acceptance test to use the scorer.
3. Run the focused knowledge tests, full core tests, core build, and CLI
   regression suite/build.
4. Confirm the existing synthetic thresholds and the previously recorded real
   NAAS metrics remain unchanged.

The next slice may consume this evaluator to compare lexical, structural, and
future local-semantic ranking strategies without changing the acceptance
contract.
