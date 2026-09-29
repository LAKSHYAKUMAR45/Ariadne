# Relevance Feedback, Query Analytics, and Ranking Regression Detection Design

## Purpose

Introduce privacy-preserving local search feedback and analytics so Ariadne can
measure retrieval quality, detect regressions early, and support explicit local
relevance tuning without storing raw query text or leaking source content.

## Scope

This slice adds:

- explicit local relevance feedback recording for search results;
- aggregate local query analytics focused on search quality and ambiguity;
- regression-run persistence that compares current evaluation results to a
  baseline;
- warning surfaces for ranking regressions and degraded query quality; and
- an explicit opt-in gate, with counts and opaque IDs only; and
- archive/export classification: behavior analytics are never exported.

This slice builds on the existing search evaluation design rather than
replacing it.

Shared contracts are owned by `2026-09-29-knowledge-backlog-contracts-design.md`.
This slice owns the three tables below (reserved global migration version 18,
knowledge revision 14) and the host-local settings `host.analytics.enabled` and
`host.analytics.salt`. It is fully offline and reads, but never changes, ranking.

## Non-goals

- No remote telemetry, hosted analytics, or cross-user data collection.
- No raw query text, snippets, or source contents stored in analytics tables.
- No online learning model that mutates ranking weights automatically.
- No provider dependency.
- No requirement that every search caller implement feedback UI immediately.

## Current state and gaps

The worktree already has:

- a synthetic evaluation corpus and scoring contract;
- deterministic search ranking with exact-span citations;
- separate specs for search indexing, ambiguity, and local-semantic ranking.

What it does not have yet:

1. a durable local record that a user accepted or rejected a result;
2. aggregate visibility into zero-result, ambiguous, or citation-poor queries;
3. a baseline-vs-current regression store for comparing ranking changes over
   time; and
4. privacy boundaries that explain what is intentionally *not* stored.

## Interfaces and data model

### 0. Opt-in gate

Analytics are **disabled by default and enabled explicitly per host and
project** with the host-local setting `host.analytics.enabled = 'true'`
(umbrella spec: `host.` keys are never exported and never imported). When the
setting is absent or `'false'`:

- `recordSearchExposure`, `recordSearchFeedback`, and regression persistence of
  user data return `{ recorded: false, reason: 'disabled' }`;
- no row is written to the feedback or daily tables and no salt is created;
- search behaves identically.

Enabling creates `host.analytics.salt` (random, per project, never printed or
logged). Disabling stops writes; existing rows remain until the operator clears
them. Synthetic-fixture regression runs (no user data) are not gated.

### 1. Explicit relevance feedback

Add an additive table for explicit feedback only. It stores counts and opaque
references, never queries, result IDs, paths, snippets, or citations:

```sql
CREATE TABLE knowledge_search_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  query_fingerprint TEXT NOT NULL,
  search_mode TEXT NOT NULL,
  result_kind TEXT NOT NULL,
  result_ref TEXT NOT NULL,
  feedback_kind TEXT NOT NULL,
  rank_position INTEGER NOT NULL,
  ambiguity_state TEXT,
  citation_present INTEGER NOT NULL,
  feedback_count INTEGER NOT NULL DEFAULT 1,
  first_day TEXT NOT NULL,
  last_day TEXT NOT NULL,
  UNIQUE (project_id, query_fingerprint, search_mode, result_ref, feedback_kind),
  FOREIGN KEY (project_id) REFERENCES knowledge_projects(id) ON DELETE CASCADE
);
```

`feedback_kind` is constrained to:

- `accepted`
- `rejected`
- `not_relevant`
- `ambiguous_but_useful`

`query_fingerprint` and `result_ref` are opaque values: an HMAC-SHA-256 of the
normalized query text, or of the result ID, keyed with the project's
`host.analytics.salt` and truncated to 128 bits. Neither is reversible without
the salt, neither is a raw ID or path, and both are only useful for deduplicating
repeated feedback and joining to a known result by recomputing its digest.
Repeated feedback increments `feedback_count` and updates `last_day` (a
`YYYY-MM-DD` day, not a timestamp). `rank_position` is clamped to `1..100`.

### 2. Aggregate analytics

Add a daily aggregate table:

```sql
CREATE TABLE knowledge_query_analytics_daily (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  search_mode TEXT NOT NULL,
  total_queries INTEGER NOT NULL,
  zero_result_queries INTEGER NOT NULL,
  ambiguous_top_results INTEGER NOT NULL,
  citationless_top_results INTEGER NOT NULL,
  accepted_result_count INTEGER NOT NULL,
  rejected_result_count INTEGER NOT NULL,
  total_result_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, day, search_mode),
  FOREIGN KEY (project_id) REFERENCES knowledge_projects(id) ON DELETE CASCADE
);
```

This table stores only counts. `total_result_count` replaces a stored median so
no per-query distribution is kept; the mean is `total_result_count /
total_queries`.

### 3. Regression persistence

Add a table for explicit evaluation runs. It measures this host's build and
configuration against a corpus, so it is host-local:

```sql
CREATE TABLE knowledge_search_regression_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  corpus_version TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  strategy_label TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  baseline_run_id TEXT,
  regressed INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (baseline_run_id) REFERENCES knowledge_search_regression_runs(id)
);
```

`run_kind` is one of:

- `synthetic_fixture`
- `approved_local_benchmark`
- `manual_diagnostic`

`summary_json` contains counts only: the metrics already defined by the search
evaluation spec (`questionCount`, `top1PathHits`, `top3PathHits`,
`spanCitationHits`, `typedGraphEvidenceHits`) plus additive ambiguity and
zero-result counts, and failing **question IDs** from the versioned fixture
corpus. It must not contain prompts, expected/returned paths, snippets, or
source contents; per-question path evidence remains an external artifact, as the
evaluation spec already requires. `corpus_version` and `strategy_label` are
short labels validated against a safe pattern.

## Service interfaces

```ts
export interface RecordAnalyticsResult {
  recorded: boolean;
  reason?: 'disabled' | 'invalid_input';
}

// `query` and `resultId` are used in memory only to derive opaque digests; they are never stored.
export interface RecordSearchExposureInput {
  projectId: string;
  query: string;
  mode: KnowledgeSearchMode;
  resultCount: number;
  topResultAmbiguity: 'clear' | 'ambiguous' | 'none';
  topResultHasCitation: boolean;
}

export interface RecordSearchFeedbackInput {
  projectId: string;
  query: string;
  mode: KnowledgeSearchMode;
  resultId: string;
  resultKind: KnowledgeSearchResultKind;
  feedbackKind: 'accepted' | 'rejected' | 'not_relevant' | 'ambiguous_but_useful';
  rankPosition: number;
  ambiguityState: 'clear' | 'ambiguous' | 'none';
  citationPresent: boolean;
}

export interface DetectRankingRegressionInput {
  corpusVersion: string;
  strategyLabel: string;
  currentSummary: Record<string, unknown>;
  baselineRunId?: string;
}
```

Behavior:

- both recorders are no-ops unless analytics are explicitly enabled (opt-in
  gate above);
- when enabled, exposure recording updates only daily aggregates;
- when enabled, explicit feedback writes a fingerprinted feedback row plus
  aggregate counters;
- `accepted` and `ambiguous_but_useful` increment `accepted_result_count`;
  `rejected` and `not_relevant` increment `rejected_result_count`;
- regression detection compares current metrics to a baseline run and records a
  warning/report row when thresholds are crossed.
- `searchKnowledge` records one exposure after ranking only when the
  per-project opt-in is enabled. Feedback remains an explicit core API; this
  slice does not add a feedback UI or change ranking.
- `KnowledgeAnalyticsSettingsStore.enable` creates a cryptographically random
  per-project 256-bit salt. `disable` stops writes but retains existing rows
  and salt; `clear` removes feedback, daily analytics, project regression runs,
  and both analytics settings.
- Synthetic fixture runs are always persistable without opt-in. Approved local
  benchmark and manual diagnostic runs require analytics enabled for their
  project.

## Privacy-preserving rules

- Real user query text is never stored; only a salted keyed digest is stored for
  explicit feedback deduplication.
- No snippets, source paths, citations, source contents, provider payloads, or
  raw result IDs go into any analytics table. `result_ref` is a salted digest.
- Only counts, coarse labels, day granularity, and opaque digests are stored.
- The per-project salt lives only in `host.analytics.salt`, is host-local, and is
  never exported, imported, logged, or echoed in errors.
- Synthetic corpus regression runs may store clear corpus version labels because
  those are repository fixtures, not user queries.
- Retention: feedback and daily rows older than 90 days are pruned by an explicit
  maintenance call; the salt is deleted when analytics are cleared.

## Regression detection policy

Regression detection builds on the evaluation spec.

Recommended warning thresholds:

- any decrease in exact-span citation hit rate versus the selected baseline;
- a decrease of more than one question in top-three path hits;
- an increase of more than 10 percentage points in ambiguous-top-result rate;
- an increase of more than 10 percentage points in zero-result rate on an
  approved local benchmark (not a synthetic fixture or manual diagnostic).

The first run for a corpus/strategy has no comparison warning. Without an
explicit `baselineRunId`, the service uses the latest prior run with the same
project, corpus version, strategy label, and run kind. The persisted summary
contains only the seven evaluation counts and safe failing fixture question
IDs; evaluator prompts and path evidence are intentionally discarded.

Detected regressions should surface as warnings in explicit evaluator commands
and optional status surfaces, not as hidden database-only facts.

## Archive, export, and sharing rules

Classification (umbrella spec):

- `knowledge_search_feedback` and `knowledge_query_analytics_daily` are
  **privacy-omitted** (`privacy_omitted`): never exported by default, declared in
  the manifest omissions, and not fabricated on import. There is no per-row
  export path.
- `knowledge_search_regression_runs` is **host-local** (`host_local_only`): it
  records how this host's build performed and its `project_id` may be `NULL`, so
  it is never exported and an archive containing it is rejected.
- `host.analytics.enabled` and `host.analytics.salt` are host-local `host.`
  settings, filtered from export and rejected on import.
- `replaceExisting` import leaves all of these rows untouched. Because they hold
  only opaque digests and counts, orphaned references after a replace are
  harmless.
- Importing a project onto a new host starts with analytics disabled.

## Security and privacy constraints

- Local only, no network calls.
- No raw query text, no raw source content, no provider payloads.
- Analytics collection is opt-in: disabled unless `host.analytics.enabled` is
  explicitly `'true'` for the host and project.
- Feedback recording must be project-scoped and must never mix data between
  projects.
- Regression warnings must never change ranking automatically; they inform
  humans and explicit tuning work only.

## Compatibility and migrations

- All three tables are additive (reserved global migration version 18).
- Search callers that never record analytics remain fully compatible.
- Existing evaluator output remains valid; regression persistence wraps it.
- Archive import remains compatible because these tables are never part of an
  archive.
- CLI/MCP read surfaces gain additive commands/fields only.

## TDD validation

Follow RED → GREEN → IMPROVE with tests for:

1. explicit feedback recording without raw query persistence;
2. daily aggregate rollups for zero-result, ambiguous, and citationless-query
   counts;
3. salted-fingerprint determinism within one project and isolation across
   projects;
4. regression detection against a baseline run using the existing search
   evaluation summary shape;
5. warning generation when gated metrics regress;
6. archive omission of feedback/analytics (declared privacy-omitted) and
   regression runs (host-local), and import rejection of `host.analytics.*`;
7. disabled-by-default behavior: no rows and no salt until explicitly enabled,
   and `{ recorded: false, reason: 'disabled' }` results; plus schema assertions
   that no table has a column that could hold a query, path, snippet, or raw ID;
8. unchanged search ranking when feedback exists but no explicit tuning step
   consumes it.

Validation should run focused analytics/evaluator tests, synthetic search
acceptance, and full core/CLI suites.
