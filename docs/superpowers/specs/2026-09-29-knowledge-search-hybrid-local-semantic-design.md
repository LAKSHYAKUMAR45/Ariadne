# Knowledge Search Hybrid Lexical and Local Semantic Retrieval Design

## Purpose

Add a providerless hybrid retrieval layer that combines the existing
deterministic lexical search with a project-local semantic reranker built only
from locally indexed knowledge fields. The goal is to improve ordering for
natural-language questions whose wording differs from source identifiers, while
preserving exact-span citations, project isolation, offline operation, and
fully deterministic behavior.

Shared contracts (migration ordering, archive classification, host-local
settings, search-confidence metadata) are owned by
`2026-09-29-knowledge-backlog-contracts-design.md`; this spec follows them.

## Scope

This slice adds:

- A project-scoped local semantic model derived from deterministic extraction
  fields already approved for search indexing.
- A bounded semantic vector or feature representation stored locally in SQLite.
- Query-time hybrid ranking that combines lexical evidence with local semantic
  similarity over a bounded candidate set.
- Bounded lexical candidate expansion through stored local neighbor terms so
  the semantic layer can rescue vocabulary mismatch without unbounded scans.
- An explicit enablement setting and per-call option (off by default).
- Automatic fallback to lexical-only ranking when hybrid is disabled, no active
  semantic model exists, or the model is stale.
- Vector invalidation, cascade, and single-writer rebuild rules.
- Regression coverage for model building, deterministic reranking, fallback,
  isolation, and lexical safety rails.

`searchKnowledge(...)` keeps its existing options and return type. The only
API addition is one optional option, `semanticRetrieval?: 'off' | 'if-available'`,
described under "Enablement".

## Non-goals

- No remote embedding providers, network calls, or hosted vector services.
- No dependence on OpenAI-compatible providers or provider profiles.
- No cross-project corpus, shared global model, or user-telemetry training.
- No semantic-only answer synthesis that lacks lexical/provenance grounding.
- No change to the deterministic extraction schema beyond what the search-index
  slice already materializes.

## Design overview

The current `KnowledgeEmbeddings.ts` module exposes optional provider-backed
ranking with a lexical fallback, but source search does not consume it and the
provider path would violate offline requirements. This slice introduces a local
semantic model that is built from project data and used as a bounded reranker.

The semantic signal is intentionally conservative:

- lexical retrieval remains the primary filter and provenance anchor;
- the local semantic model reranks only a bounded pool made of the lexical
  candidates plus a small, capped set of neighbor-term expansion candidates;
- semantic similarity cannot promote a purely metadata-only result above a
  stronger span-backed lexical match;
- an expansion candidate is eligible only when a neighbor term matched a
  span-backed indexed field, so every result stays grounded in a persisted span;
- the `searchConfidence` computed by the deterministic comparator before any
  semantic reorder is preserved and never upgraded.

## Enablement

Hybrid is **off by default** and is enabled explicitly:

- Host-local setting `host.search.hybrid.enabled` (`'true'`/`'false'`, default
  `'false'`) in `knowledge_settings`, per the host-local namespace in the
  umbrella spec. It is not exported in archives.
- Optional per-call `searchKnowledge` option
  `semanticRetrieval?: 'off' | 'if-available'`. Precedence: the option, then
  the setting, then off.
- Hybrid ranking applies only when the resolved value is enabled **and** an
  active, non-stale model exists. Otherwise the result is exactly the
  lexical-only result. `rankingMethod` is `'hybrid'` only when semantic scores
  actually contributed.
- Enablement never triggers a build. Building is explicit
  (`KnowledgeLocalSemanticIndex.replaceForProject`), typically after indexing
  or after an archive import.

## Local semantic model

Build the semantic model from active `knowledge_search_index_fields` rows
produced by the search-index slice. For each active source version:

1. Normalize field text with the same identifier-aware tokenization already
   used by lexical search.
2. Build bounded per-project term statistics and limited co-occurrence counts
   from the same field windows.
3. Expand each source’s sparse token set with a small number of high-confidence
   local neighbors (for example, strong project-local co-occurrences) so the
   vector captures terminology that appears together even when the exact query
   wording differs.
4. Project the weighted sparse representation into a fixed-size deterministic
   dense vector using a stable hashing/projection function.
5. Store the vector and its norm for the source version, and persist the bounded
   term-to-neighbor pairs used in step 3 in `knowledge_search_semantic_neighbors`
   so query-time expansion needs no corpus scan.

The result is “local semantic” rather than provider semantic because related
terms come from the project’s own indexed corpus, not from a remote model or
general-world training set.

## Interfaces and data flow

Add internal interfaces:

```ts
interface KnowledgeLocalSemanticIndex {
  replaceForProject(projectId: string): LocalSemanticRebuildReport;
  markStale(projectId: string): void;
  getStatus(projectId: string): LocalSemanticStatus;
  expandQueryTerms(input: LocalSemanticExpansionQuery): LocalSemanticExpansion;
  rankCandidates(input: LocalSemanticQuery): LocalSemanticCandidateScore[];
}

interface LocalSemanticExpansion {
  terms: Array<{ term: string; fromTerm: string; weight: number }>;
}

interface LocalSemanticCandidateScore {
  sourceVersionId: string;
  score: number;
}
```

Storage (reserved global migration version 16, knowledge revision 12):

```sql
CREATE TABLE knowledge_search_semantic_models (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  model_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  built_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('building', 'active', 'stale')),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id) REFERENCES knowledge_projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_semantic_models_one_active
  ON knowledge_search_semantic_models(project_id) WHERE status = 'active';
CREATE UNIQUE INDEX idx_semantic_models_one_building
  ON knowledge_search_semantic_models(project_id) WHERE status = 'building';

CREATE TABLE knowledge_search_semantic_vectors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  norm REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, model_id, source_version_id),
  FOREIGN KEY (project_id, model_id)
    REFERENCES knowledge_search_semantic_models(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_version_id)
    REFERENCES knowledge_source_versions(project_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_search_semantic_neighbors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  term TEXT NOT NULL,
  neighbor_term TEXT NOT NULL,
  neighbor_rank INTEGER NOT NULL,
  weight REAL NOT NULL,
  UNIQUE (project_id, model_id, term, neighbor_term),
  FOREIGN KEY (project_id, model_id)
    REFERENCES knowledge_search_semantic_models(project_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_semantic_neighbors_term
  ON knowledge_search_semantic_neighbors(project_id, model_id, term, neighbor_rank);
```

The vector encoding may be dense JSON or another deterministic SQLite-friendly
format, but it must remain local, bounded (fixed dimension), and fully
rebuildable from indexed fields. `knowledge_search_semantic_neighbors` keeps at
most `MAX_NEIGHBORS_PER_TERM` rows per term and at most `MAX_NEIGHBOR_TERMS`
terms per project, so expansion is a bounded indexed SQLite lookup rather than a
corpus scan.

## Redaction and storage

- Vectors and neighbor terms are built only from active
  `knowledge_search_index_fields.field_text`, which is already redacted
  extraction-derived text (search-index spec). Raw source contents, secrets,
  and provider responses are never read or stored.
- `vector_json` holds hashed-projection numbers only; it does not contain the
  field text and cannot be inverted to it.
- Neighbor `term`/`neighbor_term` values are normalized tokens from redacted
  text. Tokens that match secret patterns, contain long high-entropy runs, or
  are redaction placeholders are dropped before counting.
- No table stores queries, query vectors, or per-query scores. Query vectors and
  scores exist in memory only.
- Everything here is derived data and is classified **derived-rebuild** for
  archives: never exported, rebuilt after import.

## Invalidation, cascade, and rebuild locking

Invalidation (all in the same SQLite transaction as the triggering change):

- `KnowledgeSearchIndex.replaceForSourceVersion` and `markSourceStale` call
  `KnowledgeLocalSemanticIndex.markStale(projectId)`, which sets the project's
  `active` model to `stale`.
- Deleting a source version cascades to its vectors through the
  `knowledge_source_versions` foreign key; deleting a model cascades to its
  vectors and neighbors; deleting the project cascades to all three tables.
- A `stale` model is never used at query time. Search behaves as lexical-only
  until `replaceForProject` builds a new active model.
- Bumping `KNOWLEDGE_SEMANTIC_MODEL_VERSION` (or the search index version)
  makes existing models unusable in the same way.

Rebuild locking (single writer per project):

1. `replaceForProject` inserts a new model row with `status = 'building'` and a
   `lease_expires_at`. The partial unique index allows at most one `building`
   row per project, so a concurrent rebuild fails fast with
   `semantic_rebuild_in_progress` instead of racing or waiting.
2. An expired `building` lease is reclaimable: the next caller deletes the
   expired row (cascading its partial vectors) before inserting its own.
3. Vectors and neighbors are written under the building model, reading a
   consistent snapshot of index rows inside a read transaction.
4. In one final transaction the new model becomes `active` and the previous
   `active`/`stale` model is deleted (cascading its rows). If the index changed
   during the build (a `markStale` landed), the swap does not activate the new
   model: it is left `stale` and the report says `superseded_during_build`.
5. Query-time readers use only the `active` model, so they never see a partial
   build. Rebuild is independent of the worker queue and requires no queue job.

Query-time flow:

1. Resolve enablement (option, then `host.search.hybrid.enabled`, then off).
   When off, skip everything below; the result is lexical-only.
2. `searchKnowledge(..., mode: 'sources')` normalizes the query and gets
   lexical candidates through the search-index path, including per-source
   fallback candidates, exactly as the search-index and top-one specs define.
3. The deterministic comparator produces ranked source candidates, citations,
   and the top-one confidence metadata (`searchConfidence`, `ambiguityReason`,
   `ambiguityAlternatives`). **This confidence is computed here, before any
   semantic step, and is the confidence the hybrid result carries.**
4. If an active model exists, build the bounded expansion pool:
   - `expandQueryTerms` returns at most `MAX_EXPANSION_TERMS` neighbor terms
     (at most `MAX_NEIGHBORS_PER_TERM` per query term) from the neighbor table
     via indexed lookups;
   - `findCandidates` is called once more with only the expansion terms,
     restricted to span-backed indexed fields and capped at
     `MAX_EXPANSION_CANDIDATES`, excluding candidates already in the lexical
     pool;
   - the hybrid pool is at most `MAX_RESULT_CANDIDATES +
     MAX_EXPANSION_CANDIDATES`; expansion candidates are tagged
     `expandedByNeighbor` and carry the matching span as their citation.
5. Compute the query vector with the same deterministic projection and score
   only the hybrid pool.
6. Blend with an ordered comparator, not an unrestricted score sum:
   - deterministic lexical/span-backed quality remains primary among lexical
     candidates;
   - semantic similarity orders candidates within a near-tie cluster and orders
     expansion candidates among themselves;
   - an expansion candidate may enter the visible results only when the lexical
     pool has no span-backed candidate with distinct-term coverage of the
     original query, or when the lexical `searchConfidence` is `ambiguous`;
     it is placed after every lexical candidate in a `clear` result;
   - a `clear` lexical top-one result is invariant: hybrid never changes rank
     one, and never lifts a metadata-only candidate above a span-backed one.
7. Confidence preservation:
   - `searchConfidence` and `ambiguityReason` are copied from step 3 unchanged;
     hybrid never upgrades `ambiguous` to `clear`;
   - if semantic reorder changes rank one (possible only inside an `ambiguous`
     cluster or when expansion rescues a weak lexical pool), the new leader
     reports `searchConfidence: 'ambiguous'` and, for a rescue,
     `ambiguityReason: 'insufficient_intent'`, plus `semanticReordered: true`;
   - when the semantic layer separates a tie, that does not convert the result
     to `clear`.
8. Return the normal `KnowledgeSearchResult[]`, with optional metadata
   `semanticScore`, `semanticReordered`, and
   `rankingMethod: 'lexical' | 'hybrid'`.

## Determinism, offline, and security constraints

- The model must be built entirely from local indexed fields in the current
  project.
- Rebuilding the same project state must yield byte-for-byte identical vectors
  or value-equivalent deterministic floats under the documented projection.
- Vector dimension, neighbor counts (`MAX_NEIGHBORS_PER_TERM`,
  `MAX_NEIGHBOR_TERMS`, `MAX_EXPANSION_TERMS`), field windows, and candidate
  caps (`MAX_EXPANSION_CANDIDATES`) are fixed constants with regression tests.
  Expansion never scans all sources: every lookup goes through indexed
  neighbor/index tables and is capped.
- No remote model downloads, Python services, native vector databases, or
  background daemons.
- Only redacted indexed field text may be used (see "Redaction and storage").
- Query-time failure in the semantic layer must fall back to lexical-only
  ranking, not return a false successful empty result or mutate project state.

## Migration and compatibility

- **Reserved global migration version 16** (knowledge revision 12), owned by this
  slice; see the migration table in
  `2026-09-29-knowledge-backlog-contracts-design.md`. It creates the three
  tables above with `IF NOT EXISTS` guards and depends on migration 11.
- **Archive class: derived-rebuild** for all three tables. They are never
  exported, are declared as manifest omissions with reason `derived_rebuild`,
  and are deleted for the project on `replaceExisting` import. After import,
  hybrid stays lexical-only until `replaceForProject` runs (the import result
  reports `rebuildRequired: ['semantic_model']`).
- Existing databases remain compatible because the tables are additive, hybrid
  is off by default, and search falls back to lexical-only mode until a model
  exists.
- `searchKnowledge` keeps its current return type; the only API addition is the
  optional `semanticRetrieval` option.
- Provider-backed `rankByEmbedding(...)` remains available and unchanged for
  callers that explicitly use it elsewhere; hybrid never calls it.

`KnowledgeEmbeddings.ts` may be refactored internally to expose reusable vector
math helpers, but its current public API and tests must continue to pass.

## Sequencing with the search-index slice

This slice depends on the search-index slice and should not be implemented
first.

Required order:

1. **Search index slice** — establish the bounded project-scoped field store
   and candidate lookup path.
2. **Top-one and ambiguity slice** — stabilize the deterministic lexical/
   structural comparator and ambiguity contract.
3. **Hybrid lexical + local semantic slice** — add semantic reranking as a
   bounded secondary signal on top of the indexed candidate representation.

The semantic slice must consume search-index data rather than reparsing raw
extractions at query time. That avoids duplicate query-time JSON parsing and
ensures the local semantic model inherits the same redaction, bounds, and
freshness semantics as the index.

## Validation and TDD

Follow RED → GREEN → IMPROVE with tests for:

- deterministic rebuilds producing stable vectors for identical indexed input;
- lexical-only fallback when hybrid is disabled, or semantic tables are absent
  or stale, with option/setting precedence;
- vocabulary-mismatch rescue through neighbor expansion, with expansion
  candidates always span-backed and capped;
- `searchConfidence` computed pre-reorder is preserved, `clear` top-one never
  changes, `ambiguous` is never upgraded;
- invalidation: index replacement/stale marking marks the model stale in the same
  transaction; source-version deletion cascades vectors;
- rebuild locking: concurrent rebuild fails fast, expired lease is reclaimed,
  swap is atomic, and a `markStale` during build leaves the new model stale;
- redaction: secrets in indexed fields never reach vectors or neighbor terms;
- hybrid reranking improving an identifier-mismatch case without changing exact
  match winners;
- cross-project isolation for both model build and query-time scoring;
- semantic scores never promoting metadata-only results above span-backed
  content matches;
- bounded vector dimension, bounded candidate pool, and bounded co-occurrence
  expansion;
- unchanged `KnowledgeEmbeddings.test.ts` coverage for provider and lexical
  fallback behavior;
- unchanged synthetic NAAS acceptance thresholds when hybrid mode is enabled.

Run focused tests for:

- `KnowledgeEmbeddings.test.ts`
- `KnowledgeSearch.test.ts`
- search-index tests added by the preceding slice
- `KnowledgeWorker.naas.test.ts`
- full core suite and build

The real local NAAS scorer remains read-only and is used only after the above
tests pass. Success for this slice is improved ordering on natural-language
queries with lexical mismatch, no provider dependency, no regression in exact-
span grounding, and clean fallback to deterministic lexical search whenever the
local semantic model is unavailable.
