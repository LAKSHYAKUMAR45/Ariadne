# Knowledge Search Index Design

## Purpose

Reduce query-time memory and CPU growth in deterministic knowledge search by
materializing bounded searchable extraction fields when a source is analyzed.
Search must remain providerless, project-scoped, deterministic, redaction-safe,
and behavior-compatible with the current lexical and structural scorer.

Shared contracts (migration ordering, archive classification, job-result
representation) are owned by
`2026-09-29-knowledge-backlog-contracts-design.md`; this spec follows them.

## Scope

This slice adds:

- A project-scoped materialized search index for extraction-backed source
  fields.
- Idempotent index replacement when a source version is analyzed or reanalyzed.
- Explicit index freshness/version state and rebuild support.
- SQLite candidate filtering before the existing deterministic scorer runs,
  including path/title metadata candidates for sources with no extraction.
- Bounded candidate, field, and span loading.
- A per-source (and, when nothing is indexed, per-project) fallback to the
  existing source scan for any source without a usable index, so a partially
  built index can never produce an incomplete result that looks successful.
- Regression coverage for indexing, replacement, deletion, isolation, bounds,
  fallback, and ranking parity.

The public `searchKnowledge` API remains unchanged.

## Non-goals

- No semantic embeddings, provider requests, or network access.
- No change to lexical weights, structural bonuses, citation semantics, or
  acceptance thresholds.
- No cross-file answer synthesis.
- No CLI, MCP, dashboard, or VS Code behavior changes.
- No storage of raw source contents, secrets, or provider responses in the
  index.
- No index-driven change to archive contents: index tables are derived data and
  are never exported.

## Definitions

- **Current source version**: for an active source
  (`knowledge_sources.status = 'active'`), the version with the highest
  `version_number` in `knowledge_source_versions`. This is the same rule the
  existing source scan uses (`MAX(version_number)`), so index and scan agree on
  which version is searched. Older versions are never searched.
- **Current extraction**: the latest completed extraction with a non-null
  `result_json` for the current source version, ordered as the existing scan
  orders it. A current source version may have none (not yet analyzed, or a
  `coverage_only` unsupported result).
- **Index version**: the code constant `KNOWLEDGE_SEARCH_INDEX_VERSION`.
- **Usable index**: an index row whose `status = 'active'`,
  `index_version = KNOWLEDGE_SEARCH_INDEX_VERSION`, whose `source_version_id`
  is the current source version of an active source, and whose `extraction_id`
  equals the current extraction id (both `NULL` for `metadata_only` indexes).
  Anything else is **unusable** for that source.

## Data model

Add a schema migration for:

```sql
CREATE TABLE knowledge_search_indexes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  index_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  coverage TEXT NOT NULL,
  extraction_id TEXT,
  field_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('active', 'stale', 'failed')),
  CHECK (coverage IN ('extraction', 'metadata_only')),
  CHECK ((coverage = 'extraction') = (extraction_id IS NOT NULL)),
  UNIQUE (project_id, source_version_id),
  FOREIGN KEY (project_id, source_version_id)
    REFERENCES knowledge_source_versions(project_id, id)
    ON DELETE CASCADE
);

CREATE TABLE knowledge_search_index_fields (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  index_id TEXT NOT NULL,
  field_order INTEGER NOT NULL,
  field_kind TEXT NOT NULL,
  field_text TEXT NOT NULL,
  field_weight REAL NOT NULL,
  rank_class INTEGER NOT NULL,
  span_id TEXT,
  symbol_kind TEXT,
  symbol_name TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, index_id, field_order),
  FOREIGN KEY (project_id, index_id)
    REFERENCES knowledge_search_indexes(project_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (project_id, span_id)
    REFERENCES knowledge_source_spans(project_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE knowledge_search_index_tokens (
  project_id TEXT NOT NULL,
  token TEXT NOT NULL,
  index_id TEXT NOT NULL,
  field_order INTEGER NOT NULL,
  PRIMARY KEY (project_id, token, index_id, field_order),
  FOREIGN KEY (project_id, index_id)
    REFERENCES knowledge_search_indexes(project_id, id)
    ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_knowledge_search_index_tokens_index_field
  ON knowledge_search_index_tokens(project_id, index_id, field_order);
```

The span reference is a deferred check rather than an immediate `RESTRICT`:
deleting a project or source version cascades to spans and index rows in one
statement (per the contracts rule that project deletion leaves no orphans), and
an immediate `RESTRICT` would abort that cascade whenever span-backed fields
existed. Index fields are derived, so nothing needs to outlive their spans.

`knowledge_search_index_tokens` is the candidate-narrowing structure: one row
per distinct lowercase character trigram of each stored field text. A needle of
three or more characters can only match a field that contains all of its
trigrams, so lookups intersect (a bounded prefix of) the needle's trigrams
through the `(project_id, token, ...)` primary key, then verify the survivors
with the original substring check on `field_text`. Needles shorter than three
characters have no trigrams and scan fields. Document frequency for all query
terms is computed in a single pass over the same narrowed matches. The table is
derived data (`derived-rebuild`) and cascades with its index.

`coverage = 'metadata_only'` rows are built for a source version with no
current extraction (not yet analyzed or an unsupported `coverage_only` result).
They hold only `field_kind` values `path`, `title`, and `summary` derived from
source metadata, so path/title matches remain findable exactly as they are with
the existing scan. `coverage = 'extraction'` rows additionally hold symbol and
section fields with persisted spans. `field_kind` values are
`symbol`, `section`, `title`, `summary`, and `path`.

Create indexes on `(project_id, status)`, `(project_id, source_version_id)`,
and `(project_id, field_text)` or an equivalent SQLite-supported candidate
lookup strategy. The exact implementation may use a normalized token table if
substring matching over `field_text` would be too expensive, but it must retain
the original bounded field text needed by the current scorer.

Index rows are usable only for the current source version of an active source.
Older source-version indexes remain auditable but are excluded from search.

## Redacted indexed text

`field_text` is **redacted extraction-derived text**, not source contents:
symbol names, section titles, summaries, titles, and workspace-relative paths,
each passed through the existing redaction hook and bounded by the existing
extraction field limits **before** it is persisted or tokenized. Consequences:

- Secrets and absolute private paths never enter `field_text`, the token table,
  or (later) semantic vectors. Redaction placeholders are not tokenized.
- The scorer scores the same redacted normalized text on both the indexed path
  and the fallback scan path. Any ranking difference from pre-index behavior is
  confined to fields that contained redacted secrets, and is covered by the
  parity tests below.
- Snippets returned to callers are still built from persisted spans through the
  existing redaction boundary; the index never stores snippet or file body text.
- Index rows hold no provider output.

## Stale behavior

An index row stops being usable, and its source is served by the fallback scan
(see "Search flow"), when any of the following occurs:

- a newer source version is registered (the old row is for a non-current
  version);
- a newer completed extraction exists for the current version (reanalysis,
  analyzer upgrade) — `extraction_id` no longer matches;
- `markSourceStale` is called (source deleted, reconciled missing, or marked
  stale by freshness);
- `index_version` differs from the current constant;
- the index write failed (`status = 'failed'`).

`markSourceStale` and `replaceForSourceVersion` also invoke an optional
"index changed" hook in the same transaction. The hybrid slice registers it to
mark the project's local semantic model stale; until that slice lands the hook
is a no-op, so this slice has no dependency on the semantic tables. Stale rows
are never returned as candidates and are never silently treated as current.

## Index lifecycle

`KnowledgeSearchIndex` owns index construction and lookup:

```ts
export interface KnowledgeSearchIndex {
  replaceForSourceVersion(input: ReplaceSearchIndexInput): void;
  markSourceStale(projectId: string, sourceId: KnowledgeSourceId): void;
  rebuildProject(projectId: string): SearchIndexRebuildReport;
  getStatus(projectId: string): SearchIndexStatus;
  findCandidates(input: SearchIndexCandidateQuery): SearchIndexCandidate[];
}
```

`replaceForSourceVersion` validates the project and source version, deletes
existing rows for that exact `(projectId, sourceVersionId)`, inserts the
bounded fields in deterministic order, and marks the index active in one
transaction. Repeating the operation produces the same rows and does not
duplicate fields.

When a source version changes, the new version receives a new active index.
The old index is retained for audit but is not eligible for candidate lookup.
When a source is marked stale/deleted, its active index is marked stale or
excluded by the candidate query before any search result is built.

If indexing fails, the source analysis result remains explicit about the
failure. Search serves the affected source through the fallback scan rather
than omitting it or returning a success-shaped partial result.

## Search flow

The existing `searchKnowledge` options and result types do not change.

For source search:

1. Normalize and bound the query using the existing token rules.
2. Ask `KnowledgeSearchIndex.findCandidates` for at most
   `MAX_RESULT_CANDIDATES` **usable-indexed** source versions in the requested
   project. Candidates come from all field kinds, including `path` and `title`
   metadata fields, so metadata/path-only matches are returned as they are
   today.
3. Load only the bounded indexed fields and persisted spans for those
   candidates.
4. Ask the index for the project's **unindexed source set**: active sources
   whose current version has no usable index (unindexed, stale, failed, or old
   `index_version`). Serve exactly those sources through the existing
   source-row scan and extraction parser (`sourceRows` restricted to that set),
   streamed in deterministic batches of `FALLBACK_BATCH_SIZE` while retaining
   only the top `MAX_RESULT_CANDIDATES` candidates, so memory stays bounded and
   the result is complete.
5. Merge indexed and fallback candidates into one pool and reuse the existing
   lexical term weighting, structural score, citation selection, graph
   expansion, redaction, deduplication, and stable ordering. Candidate origin
   (indexed or scanned) must not influence ordering.
6. If no source in the project has a usable index, this degenerates to the
   current full source-row scan.

Partial-index rules:

- A source appears in exactly one of the two candidate sets. The indexed set
  never includes an unusable source and the fallback set never includes a
  usable one, so results are neither missing nor duplicated.
- The fallback is per source, not all-or-nothing, so an index that covers 9,000
  of 10,000 sources still bounds work to the 1,000 unindexed sources.
- If the index status query itself throws, search falls back to the full scan
  for that project and does not swallow the original error silently: it is
  reported through the existing logger/diagnostic hook.
- If both the index path and the fallback path fail, `searchKnowledge` throws.
  It never returns an empty array that could be mistaken for "no matches".
- `getStatus` reports `indexedCount`, `unindexedCount`, `staleCount`,
  `failedCount`, and `metadataOnlyCount` so operators can see partial coverage.
  `rebuildProject` is the repair path; search never writes.

Candidate lookup must be project-scoped in every SQL predicate. It must never
return a source version from another project, a stale version, or an index row
whose source no longer exists. Query results remain bounded even when the
database contains more than `MAX_RESULT_CANDIDATES` matching source versions.

## Resource and determinism guarantees

- Index fields are bounded by the existing extraction symbol, section, field,
  and payload limits.
- Candidate results are capped before extraction data is parsed.
- Field order is deterministic: extraction symbols, sections, title, summary,
  then stable field order as defined by the current parser.
- Candidate ordering is deterministic by indexed relevance, source path, and
  source-version ID before the existing final scorer; the fallback scan applies
  the same ordering to its retained candidates.
- Index replacement and stale marking are transactional.
- No broad catch converts an index failure into a false successful empty result;
  fallback is explicit and testable.

## Migration and archive

- **Reserved global migration version 11** (knowledge revision 7), owned by this
  slice; see the migration table in
  `2026-09-29-knowledge-backlog-contracts-design.md`. It creates only the two
  tables above with `IF NOT EXISTS` guards and does not touch
  `KNOWLEDGE_SCHEMA_SQL`.
- `KNOWLEDGE_SEARCH_INDEX_VERSION` is owned by this slice; bumping it makes
  every existing index unusable until `rebuildProject` runs.
- **Archive class: derived-rebuild** for both tables. They are never exported,
  are declared in the manifest omissions with reason `derived_rebuild`, and are
  deleted for the project on `replaceExisting` import. After import, search uses
  the per-source fallback until `rebuildProject` runs (the import result reports
  `rebuildRequired: ['search_index']`).
- Lifecycle hooks: the worker calls `replaceForSourceVersion` (extraction or
  `metadata_only`) in the same job transaction as extraction persistence;
  reconciliation and freshness call `markSourceStale`.

## Validation

Follow RED → GREEN → IMPROVE with tests for:

- index row creation from deterministic extraction fields;
- idempotent replacement;
- source-version replacement and stale/deleted exclusion;
- project isolation;
- malformed or missing source-version rejection;
- candidate and field bounds;
- fallback when no active index exists;
- partial index: a mix of indexed, stale, failed, and unindexed sources returns
  the same set and order as the legacy scan, with no duplicates or omissions;
- pending (newer, unanalyzed) source version is served by fallback and never by
  the older version's index;
- metadata/path-only candidates and `metadata_only` indexes;
- redaction: secrets in extraction fields never appear in `field_text` or in any
  token row;
- index failure plus fallback failure throws instead of returning `[]`;
- ranking/citation parity between indexed and legacy scan paths;
- worker integration and rollback on index-write failure;
- migration safety and reopening an existing database.

Run focused knowledge tests, the full core suite/build, the CLI suite/build,
and the existing synthetic NAAS acceptance command. Do not run the real NAAS
worker or mutate `/home/lkumar/atom`.
