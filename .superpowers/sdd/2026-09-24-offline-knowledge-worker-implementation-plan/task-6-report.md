# Task 6 report — typed graph materialization and Graphify preservation

## Scope completed

Implemented deterministic, project-scoped native graph materialization for deterministic extraction symbols and relationships, plus defensive Graphify import preservation for typed relations and parsed provenance.

## Design decisions

- Added `KnowledgeGraphMaterializer` on top of the existing `KnowledgeGraph` API instead of introducing a parallel store.
- Materialized symbol node IDs are stable via `createKnowledgeId('graph-node', projectId:sourceVersionId:symbolKind:qualifiedName:startOffset:endOffset)`.
- Materialized edge IDs are stable via `createKnowledgeId('graph-edge', projectId:sourceVersionId:edgeType:sourceNodeId:targetNodeId)`.
- Graph nodes now persist optional `qualifiedName`, `sourceVersionId`, and exact span columns directly in the native graph schema, and source-version deletions now cascade via a schema trigger for materialized symbol cleanup.
- Graph edge types are now validated against a shared native typed-edge set at the graph boundary.
- Repeated relationship occurrences with the same typed endpoints collapse into one native edge with merged, deterministic provenance entries and max confidence.
- Re-materializing a source version now deletes prior `deterministic_symbol` rows for that same source version first, so the persisted snapshot matches the latest extraction exactly.
- Local relationship resolution first uses symbols from the current extraction, then safely resolves unique same-project existing graph nodes by qualified name/label, preventing cross-project attachment and fake unresolved endpoint nodes.
- Materialization now validates that `sourceId`, `sourceVersionId`, and `extraction.sourceVersionId` agree within the target project before persisting lineage-bearing nodes or edges.
- Graphify relation precedence now considers `edgeType`, `relation`, `type`, then `label`, preserving the first recognized native edge type and retaining the earliest unknown label for diagnostics when none are recognized.
- Unknown Graphify relations fall back to `related_to` while preserving the original type and malformed provenance payloads in safe diagnostic metadata.

## Files changed

- `packages/core/src/knowledge/KnowledgeGraphMaterializer.ts`
- `packages/core/src/knowledge/graph/KnowledgeGraph.ts`
- `packages/core/src/knowledge/GraphifyImport.ts`
- `packages/core/src/knowledge/KnowledgeIds.ts`
- `packages/core/src/knowledge/KnowledgeTypes.ts`
- `packages/core/src/knowledge/knowledgeSchema.ts`
- `packages/core/src/knowledge/knowledgeMigrations.ts`
- `packages/core/src/index.ts`
- `packages/core/test/knowledge/KnowledgeGraphMaterializer.test.ts`
- `packages/core/test/knowledge/GraphifyImport.test.ts`
- `packages/core/test/knowledge/graph/KnowledgeGraph.test.ts`
- `packages/core/test/knowledge/knowledgeMigrations.test.ts`
- `.superpowers/sdd/2026-09-24-offline-knowledge-worker-implementation-plan/task-6-report.md`

## RED evidence

Command run before implementation:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeGraphMaterializer.test.ts GraphifyImport.test.ts KnowledgeGraph.test.ts
```

Observed failures:

- missing `KnowledgeGraphMaterializer` module;
- `KnowledgeGraph` did not persist graph node metadata or support explicit-ID idempotent updates;
- `GraphifyImport` prefixed inferred relations, dropped native provenance mapping, and did not preserve fallback diagnostics as required.

## GREEN evidence

Focused graph validation:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeGraphMaterializer.test.ts GraphifyImport.test.ts KnowledgeGraph.test.ts KnowledgeGraphTraversal.test.ts
```

Result: pass (`61` files / `465` tests passed in the filtered Vitest run environment).

Core build:

```bash
pnpm --filter @ariadne-dev/core build
```

Result: pass.

## Compatibility notes

- Existing graph traversal and path behavior are unchanged; validation explicitly kept `KnowledgeGraphTraversal.test.ts` green.
- Existing generic graph node/edge usage remains compatible; new graph node fields are additive and nullable.
- Existing Graphify inputs remain accepted; only relation preservation and provenance/diagnostic handling became stricter and more faithful.
- Existing page/source provenance flows still work because `KnowledgeProvenanceRef` expansion is additive.

## Rulings

- Deterministic materialization does **not** invent unresolved external nodes; unresolved references are counted and skipped.
- Explicit graph node IDs cannot be reused to move a node across projects; cross-project ID reuse now throws.
- Graphify provenance is only emitted when it can be parsed safely. If `source_location` is malformed, the raw value is retained in metadata instead of fabricating line data while still preserving normalized file-level provenance, and scheme-based/non-workspace `source_file` values are rejected by path normalization.
- Safe diagnostic metadata is stored under edge/node metadata, not promoted into graph identity fields.
- Materialization now runs in a graph transaction so source-version refresh is all-or-nothing.
- File provenance is canonicalized to normalized workspace-relative paths before persistence and must resolve to a known project source record before graph-edge storage accepts it.
- Task required a schema bump and migration updates to persist exact node provenance without overloading existing source/page identity fields.
