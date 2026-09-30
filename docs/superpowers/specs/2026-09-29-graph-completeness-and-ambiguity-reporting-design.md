# Graph Completeness and Ambiguity Reporting Design

## Purpose

Tell callers how complete the native knowledge graph really is and where its
relationships are ambiguous, downgraded, or missing. Ariadne already preserves
strong typed graph facts, but it should stop pretending that an incomplete or
heuristically downgraded graph is equivalent to a fully grounded one.

## Scope

This slice adds:

- project- and snapshot-scoped graph completeness reports;
- persistent ambiguity records for unresolved, downgraded, and multi-candidate
  graph relationships;
- explicit linkage between analyzer coverage gaps and graph completeness;
- CLI/MCP/status/read-model surfaces for graph completeness warnings; and
- regression coverage for deterministic completeness scoring and ambiguity
  persistence.

The slice is reporting-focused. It does not attempt to invent missing nodes or
resolve ambiguity with provider guesses.

Shared contracts are owned by `2026-09-29-knowledge-backlog-contracts-design.md`.
This slice owns the two tables below (reserved global migration version 14,
knowledge revision 10) and depends on the analyzer-coverage tables
(migration 13). It is fully offline.

## Non-goals

- No semantic provider or remote graph service.
- No automatic promotion of deferred relationships into authoritative edges.
- No global cross-project graph.
- No replacement of the existing `KnowledgeInsights` feature set; this slice
  complements it.
- No user-visible score gamification that hides the underlying counts.

## Current state and gaps

The branch already has:

- typed nodes and edges with provenance in `KnowledgeGraph`;
- stable graph materialization from deterministic extraction;
- preserved Graphify relation types where possible;
- insights for sparse communities, contradictions, stale pages, orphan pages,
  and bridge nodes; and
- an `unresolvedRelationships` count from `KnowledgeGraphMaterializer`.

The missing pieces are:

1. no durable record of **why** a graph is incomplete;
2. no stable distinction between a graph that is complete for supported sources
   and one that is sparse because analyzers or imports were partial;
3. no additive reporting surface for relation downgrades such as
   `related_to` fallbacks or legacy provenance omissions; and
4. no easy way for search, dashboards, or future synthesis layers to know when
   graph traversal results should be treated as ambiguous.

## Interfaces and data model

### 1. Completeness report model

Add a project/snapshot-scoped report:

```ts
export interface KnowledgeGraphCompletenessReport {
  projectId: string;
  snapshotId: string | null;
  createdAt: string;
  sources: {
    activeCount: number;
    coveredCount: number;
    partialCount: number;
    unsupportedCount: number;
    legacyUnknownCount: number;
  };
  relationships: {
    materializedCount: number;
    deferredCount: number;
    unresolvedCount: number;
    downgradedCount: number;
    ambiguousCount: number;
  };
  provenance: {
    edgeWithProvenanceCount: number;
    edgeMissingProvenanceCount: number;
  };
  warnings: GraphCompletenessWarning[];
}

export interface GraphCompletenessWarning {
  code:
    | 'partial_source_coverage'
    | 'deferred_relationships_present'
    | 'downgraded_relation_types'
    | 'legacy_provenance_omitted'
    | 'graph_snapshot_stale';
  message: string;
}
```

### 2. Ambiguity persistence

Add additive tables:

```sql
CREATE TABLE knowledge_graph_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  graph_snapshot_id TEXT,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, graph_snapshot_id)
    REFERENCES knowledge_graph_snapshots(project_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_graph_ambiguities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  graph_snapshot_id TEXT,
  source_version_id TEXT,
  source_node_id TEXT,
  target_node_id TEXT,
  ambiguity_kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, graph_snapshot_id, id),
  FOREIGN KEY (project_id, graph_snapshot_id)
    REFERENCES knowledge_graph_snapshots(project_id, id) ON DELETE CASCADE
);
```

`ambiguity_kind` is constrained to:

- `multiple_candidate_targets`
- `downgraded_relation_type`
- `external_reference_unresolved`
- `generated_relationship_deferred`
- `legacy_metadata_omitted`
- `provenance_missing`

### 3. Service interface

```ts
export interface BuildKnowledgeGraphReportInput {
  projectId: string;
  snapshotId?: string | null;
}

export interface KnowledgeGraphReportingService {
  buildCompletenessReport(input: BuildKnowledgeGraphReportInput): KnowledgeGraphCompletenessReport;
  listAmbiguities(projectId: string, snapshotId?: string | null): KnowledgeGraphAmbiguity[];
}

export interface KnowledgeGraphAmbiguity {
  id: string;
  ambiguityKind:
    | 'multiple_candidate_targets'
    | 'downgraded_relation_type'
    | 'external_reference_unresolved'
    | 'generated_relationship_deferred'
    | 'legacy_metadata_omitted'
    | 'provenance_missing';
  severity: 'info' | 'warning' | 'review';
  sourceVersionId: string | null;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  candidateNodeIds?: string[];
  relatedEdgeIds?: string[];
  message: string;
}
```

## How completeness is computed

A completeness report is derived from persisted state, not from heuristic UI
code.

1. Start with active project sources.
2. Join analyzer coverage rows from the analyzer-coverage slice. A source whose
   current job completed as a `coverage_only` result counts toward
   `unsupportedCount`; a source with no coverage row counts toward
   `legacyUnknownCount`. Coverage rows, not job result payloads, are the input.
3. Join deterministic graph nodes/edges, deferred relationships, and Graphify
   import downgrade metadata.
4. Count the graph as incomplete when any of the following are true:
   - a source is `partial`, `unsupported`, or `legacy_unknown`;
   - deferred relationships exist;
   - relation types were downgraded to generic fallbacks;
   - edge provenance was omitted or sanitized from invalid legacy metadata.
5. Persist the report for the latest graph snapshot or an on-demand synthetic
   snapshot when no current snapshot exists.

The report may include percentage fields for display, but the authoritative
state remains the raw counts and warnings.

## Ambiguity rules

A graph ambiguity row is written when Ariadne has meaningful evidence but lacks
one unambiguous canonical edge.

Examples:

- an alias maps to multiple candidate symbol nodes;
- Graphify input supplied an unknown relation that had to be downgraded to
  `related_to`;
- a deferred dynamic/generated relationship could not be materialized safely;
- legacy provenance metadata was sanitized away during edge normalization; or
- a search/traversal request references an edge cluster whose endpoints are
  equally plausible under current graph evidence.

Rules:

- ambiguity rows must be deterministic and idempotent;
- ambiguity rows must reference existing project entities when possible;
- ambiguity reporting must never create fake endpoint nodes;
- severity `review` is reserved for ambiguities that should surface in
  `knowledge_reviews` or `knowledge_insights`.

## Read surfaces

The following surfaces gain additive reporting only:

- `knowledge worker status` / MCP project status: summary counts and warnings;
- graph neighborhood/path APIs: optional `warnings[]` when returned edges come
  from ambiguous or downgraded regions;
- graph snapshot resources: latest report and ambiguity list;
- future search/synthesis layers: ability to say “graph evidence exists but is
  ambiguous.”

No existing caller is required to consume these warnings, but new callers can.

## Security and privacy constraints

- No raw source snippets or provider prompts are stored in report or ambiguity
  rows.
- `detail_json` may include node IDs, edge IDs, source version IDs, relation
  types, severity, and bounded diagnostic text only.
- Graph completeness logic must remain project-scoped.
- Reports must not downgrade fail-closed validation rules into warnings; this
  slice explains ambiguity, not unsafe state.

## Compatibility and migrations

- `knowledge_graph_reports` and `knowledge_graph_ambiguities` are additive
  tables.
- Existing snapshots remain usable; reports can be backfilled lazily.
- Older graph rows without completeness metadata are treated as “report not yet
  computed,” not “complete.”
- Graphify imports and existing materialization logic remain backward
  compatible because downgrade/ambiguity capture is additive.
- **Archive class: optional**, feature `knowledge-graph-reports-v1`, for
  `knowledge_graph_reports` and `knowledge_graph_ambiguities` (see the umbrella
  spec). They are exported in archive v2 after `knowledge_graph_snapshots`,
  validated for project ownership and same-archive snapshot references, and an
  archive lacking them imports with a warning; the report is then recomputed
  lazily and reads as "report not yet computed" until it is. Reports are
  derived from persisted state, so losing them never corrupts graph facts.

## TDD validation

Follow RED → GREEN → IMPROVE with tests for:

1. complete reports over fully supported deterministic fixtures;
2. partial reports when analyzer coverage is partial or unsupported;
3. downgrade capture for Graphify relation fallbacks and legacy provenance
   sanitation;
4. multiple-candidate alias ambiguities without fake node creation;
5. idempotent re-reporting over the same snapshot;
6. additive warning propagation through status/neighborhood/path surfaces; and
7. legacy databases opening without the new tables until migrations run; and
8. archive round-trip of reports/ambiguities plus import of an archive that
   omits them.

Validation should run focused graph/materializer/import tests, full core tests,
search/evaluation tests that consume graph evidence, and the archive tests.
