# Knowledge Backlog Shared Contracts Design

## Purpose

Own every contract that more than one knowledge backlog slice touches, so the
slice specs cannot define incompatible copies. This spec is the tie-breaker:
if a slice spec disagrees with this document, this document wins and the slice
spec must be corrected.

It covers:

1. the ordered migration ladder and schema-version ownership;
2. archive classification for every existing and new table;
3. the host-local settings namespace;
4. the single chat payload (`MessagePayloadV2`) owner;
5. the shared job-result and unsupported/coverage-only representation;
6. the shared search-confidence, provider-fallback, and offline invariants; and
7. implementation sequencing.

It changes no source code and adds no runtime behavior by itself.

## Slice inventory

| Slice | Spec |
| ----- | ---- |
| Evaluation (committed) | `2026-09-29-knowledge-search-evaluation-design.md` |
| Archive compatibility | `2026-09-29-archive-compatibility-and-authenticity-design.md` |
| Search index | `2026-09-29-knowledge-search-index-design.md` |
| Top-one ambiguity | `2026-09-29-knowledge-search-top-one-ambiguity-design.md` |
| Citation context + job-result envelope | `2026-09-29-citation-context-and-legacy-result-handling-design.md` |
| Analyzer coverage | `2026-09-29-analyzer-coverage-and-unsupported-diagnostics-design.md` |
| Graph completeness | `2026-09-29-graph-completeness-and-ambiguity-reporting-design.md` |
| Freshness and requeue | `2026-09-29-freshness-watcher-recovery-design.md` |
| Worker concurrency | `2026-09-29-worker-concurrency-design.md` |
| Hybrid local semantic | `2026-09-29-knowledge-search-hybrid-local-semantic-design.md` |
| Answer synthesis | `2026-09-29-answer-synthesis-design.md` |
| Provider semantic summaries | `2026-09-29-provider-semantic-summarization-design.md` |
| Relevance analytics | `2026-09-29-relevance-feedback-analytics-and-ranking-regression-design.md` |

## Cross-cutting invariants

These hold for every slice.

- **Offline by default.** Search, indexing, local semantic retrieval, worker
  processing, freshness, analyzer coverage, graph reporting, archive, and
  analytics never call a provider or the network. The only provider-touching
  slices are answer synthesis and semantic summarization (plus the existing
  optional worker enrichment), and each is opt-in per call with a
  warning-only deterministic fallback.
- **No provider dependency in local semantic retrieval.** The hybrid slice
  never uses provider profiles or the `embeddings` capability. The existing
  provider-backed `rankByEmbedding(...)` stays a separate, explicit caller path
  and is never invoked by `searchKnowledge`.
- **Project isolation.** Every new table carries `project_id` (except
  host-local `knowledge_search_regression_runs`, whose `project_id` is
  nullable) and every predicate is project-scoped.
- **No raw content persistence.** No new table, archive file, or payload
  stores raw source contents, raw queries, provider prompts/responses,
  secrets, or absolute private paths. See "Redaction terms" below.
- **Additive only.** No slice drops, renames, or narrows an existing column,
  table, or public type.

### Redaction terms (shared vocabulary)

- *Redacted extraction-derived text*: symbol names, section titles, summaries,
  titles, and workspace-relative paths taken from deterministic extraction,
  after the existing redaction hook, bounded per field. This is what the search
  index, semantic vectors, and deterministic synthesis prose may persist.
- *Snippet policy* `reference_only`: only IDs, coordinates, labels; no excerpt
  text. `ephemeral_redacted`: a bounded redacted excerpt that exists only in
  memory or in a single provider request and is never persisted.

## Migration ordering and schema-version ownership

### Version namespaces

| Namespace | Location | Owner | Rule |
| --------- | -------- | ----- | ---- |
| Global migration ladder | `schema_meta.schema_version`, `MIGRATIONS` in `packages/core/src/migrations.ts` (latest today: **10**) | This spec (reservation), implementing slice (code) | Authoritative ordering; ascending, one transaction each |
| Knowledge data-model revision | `KNOWLEDGE_SCHEMA_VERSION` in `knowledgeSchema.ts` (today: **6**), also `archive.compatibility.producedBy.knowledgeSchemaVersion` | Implementing slice of each reserved migration | Increments by exactly 1 per reserved migration that changes a knowledge table |
| Search index version | `KNOWLEDGE_SEARCH_INDEX_VERSION` constant | Search-index slice | Bumped when field derivation or tokenization changes; forces rebuild |
| Semantic model version | `KNOWLEDGE_SEMANTIC_MODEL_VERSION` constant | Hybrid slice | Bumped when projection, dimension, or neighbor rules change |
| Job result schema | `knowledge_jobs.result_schema_version` | Citation slice | `NULL` legacy, `1` versioned envelope (below) |
| Chat payload schema | `MessagePayloadV2.schemaVersion` | Citation slice | Absent legacy, `2` current |
| Archive manifest version | `archiveVersion` | Archive slice | `1`, `2` |
| Analyzer version | `analyzerId`/`analyzerVersion` on extractions | Analyzer owners | Bump triggers analyze requeue (freshness slice) |

### Reserved global migrations

Slices land in the order below. A reserved version is never reused or
renumbered. If a slice is cancelled, its version is registered as a no-op
migration so later versions keep their numbers.

| Global version | Knowledge revision | Owning slice | Change |
| -------------- | ------------------ | ------------ | ------ |
| 11 | 7 | Search index | `knowledge_search_indexes`, `knowledge_search_index_fields` |
| 12 | 8 | Citation context | `ALTER TABLE knowledge_jobs ADD COLUMN result_schema_version INTEGER` |
| 13 | 9 | Analyzer coverage | `knowledge_analysis_coverage`, `knowledge_deferred_relationships` |
| 14 | 10 | Graph completeness | `knowledge_graph_reports`, `knowledge_graph_ambiguities` |
| 15 | 11 | Freshness | `knowledge_source_freshness`, `knowledge_project_watchers` |
| 16 | 12 | Hybrid local semantic | `knowledge_search_semantic_models`, `knowledge_search_semantic_vectors`, `knowledge_search_semantic_neighbors` |
| 17 | 13 | Provider summaries | `knowledge_semantic_summaries` |
| 18 | 14 | Relevance analytics | `knowledge_search_feedback`, `knowledge_query_analytics_daily`, `knowledge_search_regression_runs` |

Slices with **no** migration: archive compatibility (format only), top-one
ambiguity (result metadata only), worker concurrency (host-local settings
only), answer synthesis (payload extension only).

Rules for every reserved migration:

- Guard with `hasTable`/`hasColumn` so it is idempotent and safe on a database
  that was created fresh through the v7 base schema.
- Never edit `KNOWLEDGE_SCHEMA_SQL` (the v7 base) to add these objects; add
  them only through the reserved migration.
- Do not recreate `knowledge_jobs`. The version 12 change is an
  `ALTER TABLE ... ADD COLUMN`; the existing recreate path in
  `knowledgeMigrations.ts` only runs for pre-`unknown`-mode databases and
  finishes before version 11.
- Register the new tables in the archive classification registry in the same
  change (see next section), and extend
  `packages/core/test/knowledge/knowledgeMigrations.test.ts` to assert the new
  tables/columns and the new `KNOWLEDGE_SCHEMA_VERSION`.
- Foreign keys reference `knowledge_source_versions(project_id, id)` or
  `knowledge_projects(id)` with explicit cascade behavior so project deletion
  and archive `replaceExisting` leave no orphans.
- Add a ladder test asserting versions are contiguous and equal to the table
  above once all slices land.

Each slice spec states its reserved version in a "Migration" section and refers
back to this table.

## Archive table classification

### Classes

| Class | Exported | Import behavior | Declared in manifest |
| ----- | -------- | --------------- | -------------------- |
| `required` | yes | Reject if missing when the manifest declares the feature; reject unknown required features | `requiredFeatures` |
| `optional` | yes, when rows exist | Import if present; warn and continue if absent | `optionalFeatures` |
| `derived-rebuild` | never | Not present; rebuilt locally after import | `omissions` reason `derived_rebuild` |
| `host-local` | never | Rejected if present in an archive | `omissions` reason `host_local_only` |
| `privacy-omitted` | never (default) | Not present; never fabricated | `omissions` reason `secret_omitted` or `privacy_omitted` |

The archive spec's `omissions[].reason` union gains `derived_rebuild`, and each
omission may carry an optional row filter (`{ column, prefix }`) for
partially-omitted tables such as `knowledge_settings`.

### Classification of every table

Existing tables (unchanged, all `required`): `knowledge_projects`,
`knowledge_project_roots`, `knowledge_settings` (rows with the `host.` key
prefix are `host-local` and filtered), `knowledge_schema_versions`,
`knowledge_sources`, `knowledge_source_versions`, `knowledge_source_assets`,
`knowledge_source_spans`, `knowledge_extractions`, `knowledge_pages`,
`knowledge_page_versions`, `knowledge_page_sources`,
`knowledge_page_provenance`, `knowledge_page_aliases`, `knowledge_page_links`,
`knowledge_graph_nodes`, `knowledge_graph_edges`, `knowledge_graph_snapshots`,
`knowledge_communities`, `knowledge_insights`, `knowledge_jobs`,
`knowledge_job_events`, `knowledge_reviews`, `knowledge_review_actions`,
`knowledge_research_runs`, `knowledge_research_results`,
`knowledge_conversations`, `knowledge_messages`, `knowledge_outputs`,
`knowledge_operation_log`.

Existing omitted table: `knowledge_provider_profiles` is `privacy-omitted`
(reason `secret_omitted`) exactly as today.

New tables:

| Table | Class | Feature id | Rebuild / notes |
| ----- | ----- | ---------- | --------------- |
| `knowledge_search_indexes` | derived-rebuild | n/a | Rebuilt by `KnowledgeSearchIndex.rebuildProject` |
| `knowledge_search_index_fields` | derived-rebuild | n/a | Same |
| `knowledge_search_semantic_models` | derived-rebuild | n/a | Rebuilt by `KnowledgeLocalSemanticIndex.replaceForProject` |
| `knowledge_search_semantic_vectors` | derived-rebuild | n/a | Same |
| `knowledge_search_semantic_neighbors` | derived-rebuild | n/a | Same |
| `knowledge_source_freshness` | host-local | n/a | Bootstrapped by the first `refreshProject` |
| `knowledge_project_watchers` | host-local | n/a | Bootstrapped by the first `watchProject` |
| `knowledge_analysis_coverage` | required | `knowledge-analysis-coverage-v1` | Absent rows mean `legacy_unknown` |
| `knowledge_deferred_relationships` | required | `knowledge-analysis-coverage-v1` | Ships with coverage |
| `knowledge_graph_reports` | optional | `knowledge-graph-reports-v1` | Recomputable; absent means "report not yet computed" |
| `knowledge_graph_ambiguities` | optional | `knowledge-graph-reports-v1` | Same |
| `knowledge_semantic_summaries` | optional | `knowledge-semantic-summaries-v1` | Grounded artifacts; `provider_profile_name` exported as `NULL` |
| `knowledge_search_feedback` | privacy-omitted (`privacy_omitted`) | n/a | Never exported by default |
| `knowledge_query_analytics_daily` | privacy-omitted (`privacy_omitted`) | n/a | Never exported by default |
| `knowledge_search_regression_runs` | host-local | n/a | Measures this host's build; never exported |

Additional exported-format changes that are not tables:

- `knowledge_jobs.result_schema_version` is an `optionalColumns` entry in the
  archive table schema (citation slice adds it). Older archives lacking it
  import with `NULL`.
- Conversation payload files may be `MessagePayloadV2`; any archive that
  contains one declares required feature `knowledge-chat-payload-v2`.
- The archive `knowledge_settings` table never contains `host.*` rows.

### Ordering and behavior rules

1. **Land order.** Archive v2 (reader, classification registry, host-local row
   filter) lands **first**, before any reserved migration, so every new table
   has a declared class from the moment it exists. Each later slice registers
   its tables in the registry in the same change as its migration.
2. **Data file order.** New exported tables are appended to the archive table
   list in foreign-key dependency order, after the tables they reference:
   `knowledge_analysis_coverage` and `knowledge_deferred_relationships` after
   `knowledge_source_spans`; `knowledge_graph_reports` and
   `knowledge_graph_ambiguities` after `knowledge_graph_snapshots`;
   `knowledge_semantic_summaries` after `knowledge_page_versions`.
3. **Manifest version selection.** `manifestVersion` defaults to `'auto'`: `1`
   when the project has no `required`-class new data (no coverage rows, no V2
   chat payloads); otherwise `2`. Explicit `1` on a project that has such data
   fails closed with `manifest_version_incompatible`; it never silently drops
   required data.
4. **Ownership validation.** Every exported new table passes the existing
   project-ownership and same-archive-reference checks. `knowledge_semantic_summaries.scope_id`
   must resolve to a source version, page version, or the project inside the
   archive, else import rejects.
5. **Post-import rebuild.** Import never rebuilds derived data inside the
   import transaction. After a successful import the derived-rebuild tables are
   empty for that project; search transparently uses the per-source legacy scan
   fallback (search-index spec) and hybrid falls back to lexical-only until
   `rebuildProject` and `replaceForProject` are run. `ImportResult` gains
   `postImport: { rebuildRequired: Array<'search_index' | 'semantic_model'> }`
   and a warning code `derived_data_rebuild_required`.
6. **`replaceExisting`.** Deletes the project's derived-rebuild rows and
   host-local freshness/watcher rows in the same transaction as the table
   replacement (freshness bootstraps on the next refresh). It preserves the
   project's `host.*` settings and its privacy-omitted analytics rows.
7. **Provider profile references.** Archived summaries may carry
   `provider_profile_name` only as `NULL`. No exported table, manifest field,
   or warning may include a profile's endpoint, model, `apiKeyEnv`, or key.
   `host.provider.*` settings hold profile names and are host-local.

## Host-local settings namespace

`knowledge_settings` remains the storage. Keys with the prefix `host.` are
**host-local**: they describe this machine's runtime behavior and privacy
posture, not project knowledge.

Rules:

- The archive exporter filters rows whose `setting_key` starts with `host.`
  (declared as an omission with reason `host_local_only` and row filter
  `{ column: 'setting_key', prefix: 'host.' }`).
- The archive importer rejects any archive whose `knowledge_settings` contains a
  `host.` row. Import never writes a `host.` key.
- `replaceExisting` import preserves existing `host.` rows.
- Keys are validated fail-fast on read and write through a registry; unknown
  `host.` keys are rejected. Invalid stored values raise when resolved and are
  never silently clamped.
- Non-`host.` keys keep today's portable behavior.

A small `KnowledgeHostSettingsStore` in core (`get`, `set`, `delete`, typed
per-key helpers) implements this. The worker-concurrency slice, as the first
consumer, implements the store and registry; the archive slice implements only
the prefix constant and the export/import filter.

| Key | Type / default | Owning slice |
| --- | -------------- | ------------ |
| `host.worker.concurrency` | integer 1..8, unset means `1` | Worker concurrency |
| `host.search.hybrid.enabled` | `'true'` or `'false'`, unset means `'false'` | Hybrid local semantic |
| `host.analytics.enabled` | `'true'` or `'false'`, unset means `'false'` | Relevance analytics |
| `host.analytics.salt` | opaque hex string, created on first enable | Relevance analytics |
| `host.provider.synthesis_profile` | provider profile name or unset | Answer synthesis |
| `host.provider.summary_profile` | provider profile name or unset | Provider summaries |

## Shared chat payload: `MessagePayloadV2`

**Owner: the citation-context slice.** Its spec holds the only definition of
`MessagePayloadV2` (`schemaVersion: 2`, `content`, `citations`, `retrievalMode`,
and the optional `synthesis` slot). This spec restates no code for it, so there
is no second copy to drift.

- `PersistedKnowledgeSynthesis` is defined by the answer-synthesis slice and is
  the only extension point in the payload. No other slice adds keys.
- The citation slice ships the tolerant parser and the `synthesis` slot
  (always written as absent/`null` until synthesis lands). The synthesis slice
  fills the slot and must not redeclare `MessagePayloadV2`.
- Writers emit V2 only after the tolerant reader lands. Legacy payloads (no
  `schemaVersion`) normalize in memory.
- Persisted payloads never contain excerpt text, provider prompts, or provider
  responses (`snippetPolicy` is `reference_only` for everything persisted).
- Archive: any V2 payload file makes `knowledge-chat-payload-v2` a required
  feature.

## Shared job result and unsupported/coverage-only representation

**Envelope owner: the citation-context slice** (column
`knowledge_jobs.result_schema_version`, `KnowledgeJobResult` union,
`KnowledgeJobResultBase`, `KnowledgeAnalyzedJobResult`, parser, legacy-state
mapping). **`coverage_only` variant owner: the analyzer-coverage slice**
(`KnowledgeCoverageOnlyJobResult`, its semantics, writer, and worker behavior).
Each type is defined in exactly one spec; the union is
`KnowledgeAnalyzedJobResult | KnowledgeCoverageOnlyJobResult`, discriminated by
`resultKind: 'analyzed' | 'coverage_only'`. The coverage-only variant has
non-nullable `unsupportedReason`, `coverageStatus: 'unsupported'`, and
`analyzerId`, `analyzerVersion`, `extractionId` fixed to `null`, so consumers
narrow on `resultKind` instead of null-checking an `analyzed` shape.

Rules:

- `result_schema_version`: `NULL` = legacy shape (implicitly `analyzed`);
  `1` = versioned envelope with `resultKind`. There is no second bump for
  `coverage_only`; the envelope reserves it and the coverage slice starts
  writing it.
- A coverage-only completion stores `result_processing_mode = 'deterministic'`
  so the existing CHECK constraint holds and `unknownCompletionCount` does not
  count it. Extraction, page, graph, and search-index-with-content rows are not
  created; a metadata-only search index row (path/title) is (search-index
  slice).
- `failed` coverage stays a job failure. `unsupported_source` remains a
  worker failure code only for unsupported **job kinds**; unsupported
  **sources** complete as `coverage_only`.
- Consumers key off `knowledge_analysis_coverage` (source of truth) and treat
  the job result as a pointer: freshness treats a completed `coverage_only` job
  as `fresh`; graph completeness counts it in `unsupportedCount`; the search
  index treats it as `metadata_only`; the archive carries both.
- Legacy failed jobs with `failure_code = 'unsupported_source'` are unchanged
  until requeued through the freshness slice's requeue API, after which they
  complete as `coverage_only`.

## Shared search-confidence contract

**Owner: the top-one ambiguity slice.** Optional keys on source results:
`searchConfidence` (`'clear' | 'ambiguous'`), `ambiguityReason`
(`'near_tie' | 'shared_role' | 'insufficient_intent'`), `ambiguityAlternatives`.

- The hybrid slice computes nothing new here. It reads the confidence computed
  by the deterministic comparator **before** any semantic reorder and preserves
  it (details in the hybrid spec). It may add `semanticReordered` metadata but
  never upgrades `ambiguous` to `clear`.
- The synthesis slice does not compute ambiguity. It maps the preserved
  `searchConfidence` of the results its evidence came from (details in the
  synthesis spec).
- The analytics slice records the same value (`clear`/`ambiguous`/`none`).

## Shared provider selection and fallback

Owner of the shared vocabulary: this spec; each provider-touching slice
restates the concrete behavior.

- Capability: both synthesis and summaries use the existing `generation`
  capability on an enabled project provider profile. Chat streaming keeps its
  existing `chat` capability. Neither uses `embeddings`.
- Selection precedence: explicit call input, then host-local
  `host.provider.*_profile` setting, then no provider.
- Provider calls in these slices are single-shot and non-streaming; the caller
  validates the whole response before anything is persisted or streamed.
- Every provider failure is warning-only and yields the deterministic result:

```ts
type ProviderFallbackReason =
  | 'no_profile'
  | 'profile_disabled'
  | 'capability_missing'
  | 'missing_credentials'
  | 'unsafe_endpoint'
  | 'timeout'
  | 'provider_error'
  | 'invalid_response';

interface ProviderFallbackWarning {
  code: 'provider_unavailable' | 'provider_invalid';
  reason: ProviderFallbackReason;
  message: string;
}
```

`provider_invalid` is used only for `invalid_response`; all other reasons use
`provider_unavailable`. Messages never contain endpoints, keys, environment
variable values, or provider transcripts.

## Requeue and unique analyze jobs

`knowledge_jobs` has a unique index on `(project_id, job_kind,
source_version_id)`, and `KnowledgeQueue.enqueue` returns the existing row of
any status. Therefore reanalysis of the same source version can never insert a
second job. **Owner: the freshness slice**, which adds
`KnowledgeQueue.requeueAnalyze` and defines its rules (see that spec). The
worker-concurrency slice must keep claim, complete, fail, cancel, and renew
predicates compatible with it. No migration is needed.

## Sequencing

Implementation order (equals ascending reserved migration order):

1. Archive compatibility framework (no migration).
2. Search index (global 11).
3. Top-one ambiguity (no migration).
4. Citation context and job-result envelope (global 12).
5. Analyzer coverage (global 13).
6. Graph completeness (global 14).
7. Freshness and requeue (global 15).
8. Worker concurrency (no migration; introduces the host settings store).
9. Hybrid local semantic (global 16).
10. Answer synthesis (no migration; fills the payload `synthesis` slot).
11. Provider semantic summaries (global 17).
12. Relevance analytics (global 18).

Hard dependencies: search index before top-one and hybrid; top-one before
hybrid and synthesis; citation before coverage, synthesis, and archive
payload-V2; coverage before graph completeness; archive framework before every
migration; freshness before worker concurrency is exercised with requeue.

Each slice ends with the full core and CLI suites plus the synthetic NAAS
acceptance test. The real NAAS workspace stays read-only.

## Consistency checklist for implementers

- Every new table appears in the reserved-migration table and the archive
  classification table above.
- No slice redefines `MessagePayloadV2`, `KnowledgeJobResult`, or the
  search-confidence keys.
- No `host.*` value is ever exported, imported, logged, or echoed in errors.
- No search path returns a success-shaped empty or partial result when index
  data is missing; it falls back explicitly per source.
- Provider failures never fail a worker job, search, or page build.
