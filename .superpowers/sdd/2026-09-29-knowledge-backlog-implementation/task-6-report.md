# Task 6 Report: Graph completeness and ambiguity reporting

Status: DONE_WITH_CONCERNS

## What changed
- **Migration 14 / knowledge revision 10**: `knowledge_graph_reports` and `knowledge_graph_ambiguities` (json_valid checks, kind/severity CHECKs, composite snapshot FK with cascade, `(project_id, graph_snapshot_id)` indexes). Additive; no existing table changed.
- **`KnowledgeGraphReporter`** (`KnowledgeGraphReporting.ts`, types in `KnowledgeGraphReportTypes.ts`): `buildCompletenessReport`, `getCompletenessReport` (null when never computed), `listAmbiguities`.
  - Derived only from persisted state: latest version of each active source joined to analyzer coverage. supported=covered, partial=partial, unsupported/failed=unsupported, no coverage row=legacyUnknown; the four counts always sum to the active source count.
  - Deferred relationships map to typed ambiguities (`multiple_candidate_targets` review/warning, `external_reference_unresolved`, `generated_relationship_deferred`), with candidate node ids (≤10).
  - Typed edge evidence is kept: `provenance_missing`, `downgraded_relation_type` (bounded, redacted `originalEdgeType`), `legacy_metadata_omitted`, `graph_snapshot_stale`.
  - Stored detail has ids, kinds and templated messages only: no target reference text, snippets, metadata or prompts.
  - Project-scoped; a foreign snapshot is rejected; bounded (500 stored ambiguities, exact counts kept in `ambiguities.{totalCount,storedCount}`); idempotent (unchanged body keeps id/createdAt); recomputable.
- **Materializer** now returns `ambiguousRelationships` (alias matching several local symbols). The **worker** appends them through the new `KnowledgeAnalysisCoverageStore.appendDeferredRelationships` (dedupe, respects the 200/source cap, best effort) and calls `graphReporter` once per `runOnce` after a completed job. A report failure adds a `graph_report_failed` warning and does not fail the job.
- **Archive**: both tables are exported/imported, and `knowledge-graph-reports-v1` is now implemented. Import validates the snapshot reference, ownership and bounded JSON objects (report ≤64KB, detail ≤8KB). Absent tables still import with the `optional_table_absent` warning. Older tests that used these tables as the "unsupported optional" example now use `knowledge_semantic_summaries`.
- Public exports added in `src/index.ts`.

## TDD
RED confirmed for: reporter (module missing), archive (6 failures with src stashed), worker, materializer, store append and worker alias persistence. **Not observed RED for the migration tests** (written first, but the RED run was not captured).

## Tests
- `packages/core`: `tsc --noEmit` clean; full `vitest run` 72 files / 872 tests pass (was 71 / 847).
- `npm run test:knowledge:evaluation`: 25 pass.
- cli/mcp-server not re-run; they do not reference the changed APIs.

## Deviations / concerns
- Added a direct `project_id → knowledge_projects ON DELETE CASCADE` FK, absent from the spec DDL. Without it, live reports (NULL snapshot) would not cascade on project deletion.
- `failed` coverage is counted as unsupported.
- No read-surface `warnings[]` wiring (CLI/MCP status/neighborhood/path) yet. Only the service, worker refresh and archive are implemented.
- No src code writes graph snapshots yet, so live reports (snapshot null) are the common case.
- New archives always include report table files, so older readers that reject unknown tables may refuse them.
- Existing (pre-Task-6) sources show as legacyUnknown until re-analyzed, as intended.
- Pre-existing uncommitted `knowledge-search-evaluation/progress.md` was not committed.

## Review fix: ambiguity candidates scoped to originating source version
- Finding: `aliasCandidates` matched same-named symbols across the whole project, so candidate lists could include nodes from other sources.
- Fix: candidates now come only from `deterministic_symbol` nodes of the deferred relationship's own `source_version_id` (already restricted to the active source's latest version). Lookup mirrors the materializer: full trimmed reference first, then the part before `#` for `path#Name` references; the first alias with nodes wins. Bound (10), redaction (reference text never stored), project scoping and warning/review severity (`review` for ≥2 candidates, else `warning`) are unchanged.
- Tests (RED first: 3 failures, then GREEN): updated the mixed-source ambiguity test to keep candidates in the originating version; added a two-source (plus stale-version and foreign-project) same-name regression proving only originating-version candidates are stored; added a `path#Name` full/prefix alias test.
- Results: `KnowledgeGraphReporting.test.ts` 13/13; `packages/core` `tsc --noEmit` clean; full `vitest run` 72 files / 874 tests pass; `npm run test:knowledge:evaluation` run.
