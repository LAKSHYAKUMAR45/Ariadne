# Knowledge Search Index Design

## Purpose

Reduce query-time memory and CPU growth in deterministic knowledge search by
materializing bounded searchable extraction fields when a source is analyzed.
Search must remain providerless, project-scoped, deterministic, redaction-safe,
and behavior-compatible with the current lexical and structural scorer.

## Scope

This slice adds:

- A project-scoped materialized search index for extraction-backed source
  fields.
- Idempotent index replacement when a source version is analyzed or reanalyzed.
- Explicit index freshness/version state and rebuild support.
- SQLite candidate filtering before the existing deterministic scorer runs.
- Bounded candidate, field, and span loading.
- A safe fallback to the existing source scan when an index is unavailable or
  stale.
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

## Data model

Add a schema migration for:

```sql
CREATE TABLE knowledge_search_indexes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  index_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  field_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
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
    ON DELETE RESTRICT
);
```

Create indexes on `(project_id, status)`, `(project_id, source_version_id)`,
and `(project_id, field_text)` or an equivalent SQLite-supported candidate
lookup strategy. The exact implementation may use a normalized token table if
substring matching over `field_text` would be too expensive, but it must retain
the original bounded field text needed by the current scorer.

Index rows are active only for the current source version and active source.
Older source-version indexes remain auditable but are excluded from search.

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
failure. Search falls back to the existing scan path rather than returning a
success-shaped empty result.

## Search flow

The existing `searchKnowledge` options and result types do not change.

For source search:

1. Normalize and bound the query using the existing token rules.
2. Ask `KnowledgeSearchIndex.findCandidates` for at most
   `MAX_RESULT_CANDIDATES` source-version candidates in the requested project.
3. Load only the bounded indexed fields and persisted spans for those
   candidates.
4. Reuse the existing lexical term weighting, structural score, citation
   selection, graph expansion, redaction, deduplication, and stable ordering.
5. If the project has no usable active index, use the current source-row scan
   and extraction parser as a compatibility fallback.

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
  source-version ID before the existing final scorer.
- Index replacement and stale marking are transactional.
- No broad catch converts an index failure into a false successful empty result;
  fallback is explicit and testable.

## Validation

Follow RED → GREEN → IMPROVE with tests for:

- index row creation from deterministic extraction fields;
- idempotent replacement;
- source-version replacement and stale/deleted exclusion;
- project isolation;
- malformed or missing source-version rejection;
- candidate and field bounds;
- fallback when no active index exists;
- ranking/citation parity between indexed and legacy scan paths;
- worker integration and rollback on index-write failure;
- migration safety and reopening an existing database.

Run focused knowledge tests, the full core suite/build, the CLI suite/build,
and the existing synthetic NAAS acceptance command. Do not run the real NAAS
worker or mutate `/home/lkumar/atom`.
