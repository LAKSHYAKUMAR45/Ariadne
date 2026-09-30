# Task 6 report — typed graph materialization and Graphify preservation

## Scope completed

Implemented deterministic, project-scoped native graph materialization for deterministic extraction symbols and relationships, plus hardened Graphify/native provenance handling for authoritative source paths, zero-based columns, metadata safety bounds, collision rejection, legacy-read guards, and Task 6 review-round-2 security/compatibility fixes.

## Design decisions

- Added `KnowledgeGraphMaterializer` on top of the existing `KnowledgeGraph` API instead of introducing a parallel store.
- Materialized symbol node IDs are stable via `createKnowledgeId('graph-node', projectId:sourceVersionId:symbolKind:qualifiedName:startOffset:endOffset)`.
- Materialized edge IDs are stable via `createKnowledgeId('graph-edge', projectId:sourceVersionId:edgeType:sourceNodeId:targetNodeId)`.
- Native graph reads now hydrate materialized node provenance with authoritative `provenanceSourceId` / `provenanceSourcePath` from `knowledge_source_versions` + `knowledge_sources`, so node provenance includes source ID/version/path/span without trusting caller-supplied metadata.
- Native graph edge writes and reads now hydrate `kind: 'source'` provenance paths from authoritative source/version records and ignore caller attempts to substitute a different path.
- Graph edge types are now validated against a shared native typed-edge set at the graph boundary.
- Repeated relationship occurrences with the same typed endpoints collapse into one native edge with merged, deterministic provenance entries and max confidence.
- Re-materializing a source version now deletes prior `deterministic_symbol` rows for that same source version first, so the persisted snapshot matches the latest extraction exactly.
- Local relationship resolution first uses symbols from the current extraction, then safely resolves unique same-project existing graph nodes by qualified name/label, preventing cross-project attachment and fake unresolved endpoint nodes.
- Materialization now validates that `sourceId`, `sourceVersionId`, and `extraction.sourceVersionId` agree within the target project before persisting lineage-bearing nodes or edges.
- Deterministic materialization now rejects same-source extractions that derive the same stable graph node ID for two distinct symbols, aborting the transaction before overwrite/graph-poisoning can occur.
- Graphify relation precedence now considers `edgeType`, `relation`, `type`, then `label`, preserving the first recognized native edge type and retaining the earliest unknown label for diagnostics when none are recognized.
- Graphify object-shaped `source_location` values now preserve valid zero-based columns while rejecting negative/fractional columns.
- Added shared graph metadata safety limits and sanitizers:
  - maximum depth: `4`
  - maximum entry count: `64`
  - maximum string length: `512`
  - maximum serialized byte size: `4096`
- Graph metadata sanitization now drops `__proto__`, `constructor`, and `prototype` keys at every nested object level and rebuilds sanitized objects with null prototypes so JSON-parsed and direct-object inputs cannot poison output objects or downstream merges.
- Legacy stored graph provenance now rehydrates through a compatibility path that preserves bounded nested JSON, redacts/truncates secrets, drops unsafe top-level and nested keys, emits bounded `diagnostic` metadata when legacy nested metadata is invalid, and omits malformed legacy provenance refs instead of aborting list/traversal reads.
- Optional Graphify `source_location` parsing now degrades safely for cyclic, over-deep, or oversized values by keeping the edge, preserving file-level provenance when possible, and storing a bounded `sourceLocationDiagnostic` marker when raw malformed input itself cannot be safely retained.
- Provenance/import metadata now uses the repository redaction boundary (`Redactor`) plus strict allowlists and bounded truncation/rejection instead of persisting arbitrary nested objects, secrets, or oversized blobs verbatim.
- Legacy stored graph-edge metadata is re-read through bounded sanitizer/stringifier paths, so bounded legacy rows remain readable and invalid rows degrade contextually instead of failing the entire edge/traversal read.

## Files changed

- `packages/core/src/knowledge/GraphMetadata.ts`
- `packages/core/src/knowledge/KnowledgeGraphMaterializer.ts`
- `packages/core/src/knowledge/graph/KnowledgeGraph.ts`
- `packages/core/src/knowledge/GraphifyImport.ts`
- `packages/core/test/knowledge/KnowledgeGraphMaterializer.test.ts`
- `packages/core/test/knowledge/GraphifyImport.test.ts`
- `packages/core/test/knowledge/graph/KnowledgeGraph.test.ts`
- `.superpowers/sdd/2026-09-24-offline-knowledge-worker-implementation-plan/task-6-report.md`

## RED evidence

Command run before implementation:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeGraphMaterializer.test.ts GraphifyImport.test.ts KnowledgeGraph.test.ts
```

Observed failures after adding the new regression cases:

- Graph metadata sanitization still allowed attacker-controlled prototype keys to survive in sanitized output objects and nested arrays, leaving prototype-pollution gadgets reachable from JSON-parsed import payloads;
- optional Graphify `source_location` values that were cyclic, over-deep, or oversized still aborted the whole import instead of preserving the edge with a bounded diagnostic marker;
- legacy graph traversal/list reads still either rejected bounded nested provenance metadata outright or threw on malformed legacy provenance refs/unsafe top-level keys instead of degrading safely;
- Graphify object-shaped `source_location` dropped valid zero-based columns and accepted invalid fractional/negative columns as if they were absent;
- materialized node/edge provenance lacked authoritative source paths and allowed deterministic node-ID collisions to overwrite earlier symbols inside the same source-version refresh;
- graph-edge provenance metadata persisted unallowlisted/secret-like values verbatim and lacked bounded recursion/entry-size guards;
- legacy graph reads still accepted unbounded persisted provenance metadata without contextual guard failures.

## GREEN evidence

Focused graph validation:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeGraphMaterializer.test.ts GraphifyImport.test.ts KnowledgeGraph.test.ts KnowledgeGraphTraversal.test.ts knowledgeMigrations.test.ts
```

Result: pass (`61` files / `480` tests passed in the filtered Vitest run environment).

Full core validation:

```bash
pnpm --filter @ariadne-dev/core test
```

Result: pass (`61` files / `480` tests).

Core build:

```bash
pnpm --filter @ariadne-dev/core build
```

Result: pass.

## Compatibility notes

- Existing graph traversal and path behavior are unchanged; validation explicitly kept `KnowledgeGraphTraversal.test.ts` green.
- Existing generic graph node/edge usage remains compatible; new node provenance read fields are additive and nullable.
- Existing Graphify inputs remain accepted; only relation preservation and provenance/diagnostic handling became stricter and more faithful.
- Existing page/source provenance flows still work because `KnowledgeProvenanceRef` expansion is additive.

## Rulings

- Deterministic materialization does **not** invent unresolved external nodes; unresolved references are counted and skipped.
- Explicit graph node IDs cannot be reused to move a node across projects; cross-project ID reuse now throws.
- Distinct extraction symbols that collide on the required stable node-ID seed now fail atomically with a contextual collision error; the prior graph snapshot is preserved by the materializer transaction rollback.
- Source provenance path hydration is authoritative on both write and read paths; caller-supplied `path` values for `kind: 'source'` are ignored in favor of the recorded source/version path when one exists.
- Graphify provenance is only emitted when it can be parsed safely. If `source_location` is malformed, the raw value is retained in metadata instead of fabricating line data while still preserving normalized file-level provenance, and scheme-based/non-workspace `source_file` values are rejected by path normalization.
- Zero-based object columns (`0`) are preserved for Graphify line objects; negative or non-integer columns downgrade to file-only provenance plus explicit `unparsedSourceLocation` diagnostics.
- Safe diagnostic metadata is stored under edge/node metadata, not promoted into graph identity fields.
- Materialization now runs in a graph transaction so source-version refresh is all-or-nothing.
- File provenance is canonicalized to normalized workspace-relative paths before persistence and must resolve to a known project source record before graph-edge storage accepts it.
- Relationship/import metadata persistence is now bounded and allowlisted: secrets are redacted, long strings are truncated, nested objects are rejected on provenance writes, and oversized/wide metadata fails with stable contextual errors and no partial writes.
- Legacy stored graph-edge metadata is guarded by bounded compatibility sanitizers: bounded nested rows remain readable, unsafe prototype keys are dropped, malformed legacy refs are omitted, and invalid metadata degrades to bounded diagnostics instead of recursing until crash or aborting traversal/list reads.
