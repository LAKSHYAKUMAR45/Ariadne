# Task 5 report: analyzer coverage and unsupported diagnostics

Status: DONE_WITH_CONCERNS

## Changes (packages/core)
- Migration 13 / knowledge revision 9: `knowledge_analysis_coverage` and `knowledge_deferred_relationships` (CHECK-constrained enums, project-scoped FKs, cascade from source versions).
- `analyzers/AnalyzerCoverage.ts`: deterministic coverage statuses, unsupported reasons, bounded diagnostics (8 x 280 chars), advisory generated-code detection, optional-ingest mapping.
- `AnalyzerRegistry.resolve()` (`require()` delegates to it; `require`-only registries still work in the worker).
- `KnowledgeAnalysisCoverageStore`: upsert/get/summarize plus validated, deduplicated, sanitized deferred relationships bounded to 200 per source version.
- `KnowledgeJobResult` / `KnowledgeQueue`: `coverage_only` variant integrated into the shared parser (NULL-version legacy payloads accept analyzed only; version 1 dispatches on `resultKind`); warnings bounded and redacted.
- `KnowledgeWorker`: unsupported/non-text sources complete successfully as coverage-only (`deterministic` mode, no extraction/page/graph rows, `metadata_only` search-index row, coverage row, one transaction). Unsupported job kinds still fail `unsupported_source`. Supported analysis persists coverage and deferred relationships atomically with the extraction; partial coverage (analyzer-reported or dynamic/generated deferred candidates) adds a warning. Analyzer failures record best-effort `failed`/`parser_failed` coverage without error text. `unsupportedCoverageCount` added to run results.
- Archive: both tables added to export/import (project ownership, source-version and span reference checks); `knowledge-analysis-coverage-v1` is now implemented. Explicit v1 export with coverage rows fails `manifest_version_incompatible`; a v2 manifest declaring the feature but omitting either table is rejected; rows without the declaration are rejected; older archives lacking the tables import (sources read as `legacy_unknown`).
- Public exports added in `src/index.ts`.

## Tests (all local SQLite, no network)
- New: `AnalyzerCoverage.test.ts` (23), `KnowledgeAnalysisCoverageStore.test.ts` (11); extended migrations, queue, worker (11 coverage cases), archive (7 cases). RED confirmed before implementation.
- `packages/core`: `tsc --noEmit` clean; `vitest run` 71 files / 845 tests pass; `npm run test:knowledge:evaluation` 25 pass.
- `packages/cli` 133 pass, `packages/mcp-server` 72 pass, both `tsc --noEmit` clean (against rebuilt core dist).

## Concerns / deviations
- The spec's deferred-span FK `ON DELETE SET NULL` cannot work on a composite FK with NOT NULL `project_id` (SQLite nulls every child column). Used `NO ACTION DEFERRABLE INITIALLY DEFERRED`, as `knowledge_search_index_fields` does.
- Hash-mismatch, missing-content, and oversized *supported* sources remain job failures; non-UTF-8 content is coverage-only (`binary_or_non_text`). (Oversized unsupported sources: see Review fix below.)
- Graph completeness (Task 6) does not yet consume deferred relationships; no CLI/MCP status surface for coverage was added (`unknownCompletionCount` untouched).
- Document/media ingestor outcomes are mapped only via the pure `coverageFromOptionalIngest`; the ingestors themselves are unchanged.
- Previously failed `unsupported_source` jobs stay failed until the Task 7 requeue.
- New archives always include (possibly empty) coverage table files, so readers predating this change may reject them (same class of concern as Task 4).
- Pre-existing uncommitted `.superpowers/sdd/2026-09-29-knowledge-search-evaluation/progress.md` was left untouched and uncommitted.

## Review fix: oversized unsupported sources

Finding: `source_too_large` from the loader failed the job even when the source has no analyzer, contradicting the coverage spec.

- `KnowledgeWorker.runAnalyzeJob` now catches `source_too_large`, resolves the analyzer from the stored source kind/path/MIME (`loadSourceSelection` now also returns `sourceKind`), and, only when unsupported, completes via `completeUnsupportedSource` with `unsupportedCoverage('size_limit_exceeded')` (`coverage_only`, `coverageStatus: 'unsupported'`, `unsupportedReason: 'size_limit_exceeded'`, warning `coverage_size_limit_exceeded`, `metadata_only` index row). Oversized sources with a supported analyzer, and all other loader errors (missing content, hash mismatch, path rejected), still fail; non-UTF-8 behavior unchanged.
- Tests (RED first: oversized Ruby failed with `source_too_large`): new oversized-unsupported regression and oversized-supported-still-fails case in `KnowledgeWorker.test.ts`.
- Output: `tsc --noEmit` clean; `vitest run` 71 files / 847 tests pass.
