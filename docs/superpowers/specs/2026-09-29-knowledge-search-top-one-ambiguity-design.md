# Knowledge Search Top-One Ranking and Ambiguity Design

## Purpose

Improve deterministic top-one source ranking for offline knowledge search while
making genuine near-ties explicit instead of hiding them behind fragile score
bonuses. The slice must raise diagnostic top-one quality without question-
specific path rules, providers, or nondeterministic heuristics, and it must
preserve the existing acceptance contract where top-three path accuracy, exact
span citations, and typed graph evidence remain the gated metrics.

## Scope

This slice adds:

- A bounded, deterministic source-ranking comparator that uses explicit match
  signals instead of relying on a single additive score.
- A project-local ambiguity classifier for near-tied source results.
- Optional result metadata that marks whether the first source result is clear
  or ambiguous, without changing the public `searchKnowledge(...)` return
  shape.
- Regression coverage for top-one improvements, ambiguity detection, stable
  ordering, and search-index parity.
- Evaluator extensions for non-gated top-one and ambiguity diagnostics used in
  targeted tests and external evidence reports.

The slice applies only to source-mode ranking. Page, task, and hybrid task/page
behavior remain unchanged unless they consume the ordered source results.

## Non-goals

- No semantic embeddings, provider requests, or remote services.
- No question-specific source-path exceptions or curated aliases for the NAAS
  corpus.
- No change to the gated acceptance thresholds defined by the evaluation slice.
- No synthetic “ambiguity placeholder” result inserted into `searchKnowledge`
  output.
- No changes to deterministic extraction formats, worker queue semantics, or
  graph materialization.

## Ranking model

The current scorer mixes lexical, metadata, and structural bonuses into one
number. That has improved top-three accuracy, but it makes rank one sensitive
to repeated vocabulary and large symbolic bonuses. This slice replaces the
“best total wins” behavior with an ordered decision vector computed per source.

For each source candidate, compute these bounded signals:

1. **bestMatchClass** — extraction span-backed field, extraction metadata
   field, or path-only metadata.
2. **distinctTermCoverage** — how many normalized query terms matched after
   existing stopword and inflection rules.
3. **rareTermCoverage** — how many higher-IDF query terms matched.
4. **exactPhraseHits** — exact phrase or exact identifier hits across span-
   backed extraction fields.
5. **exactSymbolHits** — exact symbol-name or qualified-name matches after
   role alignment.
6. **spanBackedFieldHits** — count of matching extraction fields with persisted
   spans.
7. **structuralIntentScore** — the existing bounded task-manager/workflow/
   use-case/loader/defaults/pytest role alignment, but only as a later
   tie-break stage.
8. **metadataScore** — bounded path/title/summary fallback evidence.

The final comparator is lexicographic, not purely additive. A source with
better span-backed coverage or exact symbol alignment should outrank a source
with more repeated generic tokens. Numeric scores remain for snippet selection,
debugging, and stable reporting, but ordering is controlled by the feature
vector first and raw score second.

## Interfaces and data flow

The public `searchKnowledge(...)` API stays unchanged and still returns a
sorted `KnowledgeSearchResult[]`.

Introduce internal ranking types:

```ts
interface SourceMatchFeatures {
  bestMatchClass: 0 | 1 | 2;
  distinctTermCoverage: number;
  rareTermCoverage: number;
  exactPhraseHits: number;
  exactSymbolHits: number;
  spanBackedFieldHits: number;
  structuralIntentScore: number;
  metadataScore: number;
  lexicalScore: number;
}

interface SourceRankingDecision {
  features: SourceMatchFeatures;
  ambiguity: {
    state: 'clear' | 'ambiguous';
    reason: 'near_tie' | 'shared_role' | 'insufficient_intent';
    alternativeCount: number;
  };
}
```

Search flow:

1. Normalize the query with the existing bounded token/variant rules.
2. Load source candidates through the search-index candidate API when an active
   index exists; otherwise adapt the legacy source-row scan into the same
   candidate shape.
3. Build `SourceMatchFeatures` from indexed or parsed extraction fields.
4. Sort with a deterministic comparator:
   - feature vector descending;
   - citation-bearing field quality;
   - lexical score;
   - redacted title/path;
   - source ID.
5. Select the citation from the strongest matching span-backed field, not
   merely the highest-scoring field overall.
6. Compare the top candidate with the next eligible candidate. If the leading
   feature vector differs only in late tie-break stages or falls within the
   configured ambiguity band, mark the top result metadata as ambiguous.

Returned metadata stays backward-compatible by using optional keys on existing
source results:

- `searchConfidence`: `clear` or `ambiguous`
- `ambiguityReason`: `near_tie`, `shared_role`, or `insufficient_intent`
- `ambiguityAlternatives`: count of immediately competing results

Consumers that ignore these keys keep current behavior.

This slice is the **sole owner** of these keys and of their meaning (see
`2026-09-29-knowledge-backlog-contracts-design.md`). Downstream slices only read
them:

- The confidence is computed by the deterministic comparator over the pooled
  candidates (indexed and per-source fallback candidates are ranked identically).
- The hybrid slice preserves this value and never upgrades `ambiguous` to
  `clear`; it may add `semanticReordered` and `rankingMethod`, which are its
  own optional keys.
- The answer-synthesis slice maps this value into synthesis warnings and claim
  confidence and computes no ambiguity of its own.
- The relevance-analytics slice records it as the `clear`/`ambiguous`/`none`
  exposure state.

## Ambiguity handling

This slice does not try to “solve” genuinely underspecified questions such as
queries that name only a broad JCNR use-case shape when several use-case files
share valid deployment/readiness evidence. Instead:

- the winner remains deterministic;
- the result is annotated as ambiguous when the next candidate is materially
  equivalent under the comparator;
- ambiguity is limited to the first cluster of near-equal candidates, not the
  entire tail of the ranking;
- the scan covers every candidate inside the leader's score band, skipping
  weaker in-band candidates that lack the leader's exact-symbol or term
  coverage rather than stopping at them; alternatives are counted before the
  caller's result `limit` is applied, over the bounded retained candidate pool;
- ambiguity never suppresses a better exact-symbol or better span-backed match.

This makes top-one quality more honest without weakening current top-three/span
acceptance.

## Determinism, offline, and security constraints

- No provider, network, or remote model calls.
- No user-behavior learning, click feedback, or time-based scoring.
- Ambiguity thresholds are fixed constants in code and tests, not environment-
  dependent configuration.
- Ranking signals are derived only from project-scoped indexed/parsed
  extraction fields, persisted spans, and existing metadata.
- Result metadata must not expose raw source contents, secrets, or unredacted
  snippets beyond the existing redaction boundary.
- A metadata-only candidate cannot win over a span-backed extraction candidate
  solely because of ambiguity or structural tie-breaks.

## Migration and compatibility

No schema migration is required and no global migration version is reserved
for this slice, because ambiguity is result metadata only.

If the evaluation layer records ambiguity diagnostics, add those fields only to
external evidence artifacts or internal evaluator helpers. Do not change the
gated report contract consumed by existing tests unless the evaluation spec is
explicitly revised. Existing consumers of `searchKnowledge` remain compatible
because:

- the return type shape is unchanged;
- sort order remains deterministic;
- optional metadata keys are additive;
- legacy scan fallback continues to work when the search-index slice is absent
  or stale.

## Sequencing with the search-index slice

Recommended order:

1. **Search index slice first.** It provides the bounded candidate and field
   representation that this slice should consume in the steady state.
2. **Top-one and ambiguity slice second.** Implement the ranking comparator and
   ambiguity metadata on top of the shared candidate representation, while
   keeping legacy-scan fallback parity until the index is universal.
3. **Hybrid lexical + local semantic slice third.** That slice should reuse the
   ambiguity contract and must not bypass these deterministic lexical/structural
   tie-break rules.

This slice must not introduce a second long-lived candidate store or a second
parallel parsing pipeline. If search-index implementation is still in flight,
the acceptable temporary adapter is “legacy source row → indexed-candidate
shape,” not a bespoke top-one-only data path.

## Validation and TDD

Follow RED → GREEN → IMPROVE with focused tests for:

- exact symbol or exact identifier matches outranking broad repeated workflow
  vocabulary;
- persisted-span matches outranking metadata-only or spanless title matches;
- ambiguity marking for a CloudRouter-style underspecified use-case query;
- stable tie-breaking across repeated runs and differing insertion order;
- no structural-only promotion when lexical evidence is absent;
- index-path and legacy-path ranking parity when semantic retrieval is off;
- unchanged gated acceptance metrics for the synthetic NAAS evaluator.

Run:

- focused `KnowledgeSearch.test.ts`;
- `KnowledgeSearchEvaluator` tests if ambiguity diagnostics are added there;
- synthetic `KnowledgeWorker.naas.test.ts`;
- full core tests and build;
- existing CLI regression/build commands that cover search callers.

The real local NAAS scorer remains read-only and diagnostic. Success for this
slice is: improved top-one ordering where the query is actually specific,
explicit ambiguity where the query is not, and no regression in the approved
top-three/span/typed-graph gate.
