# Analyzer Coverage, Unsupported-File Diagnostics, and Dynamic/Generated Relationship Design

## Purpose

Make knowledge analysis coverage explicit instead of inferring it from missing
rows, failed jobs, or empty graph output. Ariadne should be able to tell the
operator, the worker, and later retrieval layers whether a source version was
fully analyzed, partially analyzed, intentionally unsupported, or deferred
because the relationship could only be inferred from generated or dynamic code.

## Scope

This slice adds:

- an explicit analyzer-resolution contract instead of `AnalyzerRegistry.require`
  being the only supported path;
- persistent per-source-version coverage records for supported, partial,
  unsupported, and failed analysis outcomes;
- standardized unsupported-file and partial-analysis diagnostics for code,
  document, and media inputs;
- a first-class representation for dynamic/generated-code relationship
  candidates that should not become fake graph edges;
- worker/status/archive/search-facing summaries that expose coverage without
  leaking source contents; and
- regression coverage for resolution, persistence, warnings, and compatibility.

The goal is observability and safe semantics, not broader language support by
itself.

Shared contracts are owned by `2026-09-29-knowledge-backlog-contracts-design.md`.
This slice **owns** the `coverage_only` job-result variant, the two tables below
(reserved global migration version 13, knowledge revision 9), and the worker
change that turns unsupported sources from failed jobs into completed
coverage-only jobs. It depends on the citation slice's versioned
`KnowledgeJobResult` envelope (migration 12).

## Non-goals

- No attempt to fully execute runtime code, import modules, or evaluate user
  programs to discover dynamic relationships.
- No remote analysis service, provider dependency, or background telemetry.
- No silent promotion of generated-code heuristics into authoritative graph
  facts.
- No storage of raw unsupported-file bytes, parser stack traces, or source
  excerpts inside diagnostics tables.
- No replacement of the existing deterministic extraction schema for sources
  that are already fully supported.

## Current state and gaps

Today the branch already has strong deterministic analyzers for Python,
JavaScript/TypeScript, Markdown, and plain text. Optional document/media
adapters return typed `unsupported` or `failed` results, and the worker emits
stable failure codes such as `unsupported_source`.

That still leaves three product gaps:

1. **Coverage is implicit.** There is no durable, project-scoped record that a
   source version was intentionally unsupported versus accidentally skipped.
2. **Unsupported diagnostics are fragmented.** `DocumentIngestor` and
   `MediaIngestor` produce useful typed results, but those outcomes do not flow
   into a shared coverage/status/archive contract.
3. **Generated or dynamic relationships vanish.** The graph materializer counts
   unresolved relationships, but Ariadne does not preserve why they were
   unresolved or whether they came from generated code, runtime indirection,
   manifests, or deferred external references.

## Proposed interfaces and data model

### 1. Analyzer resolution contract

Add an additive resolution path that callers can use before attempting a full
analysis:

```ts
export type AnalyzerCoverageStatus =
  | 'supported'
  | 'partial'
  | 'unsupported'
  | 'failed';

export type AnalyzerUnsupportedReason =
  | 'no_analyzer'
  | 'unknown_format'
  | 'adapter_missing'
  | 'binary_or_non_text'
  | 'size_limit_exceeded'
  | 'policy_rejected'
  | 'parser_failed';

export interface AnalyzerCoverageSummary {
  status: AnalyzerCoverageStatus;
  analyzerId: string | null;
  analyzerVersion: string | null;
  generatedCode: boolean;
  generatedReason: string | null;
  supportedFeatures: string[];
  missingFeatures: string[];
  warnings: ExtractionDiagnostic[];
  unsupportedReason?: AnalyzerUnsupportedReason;
}

export type AnalyzerResolution =
  | {
      kind: 'supported';
      analyzer: DeterministicAnalyzer;
      coverage: AnalyzerCoverageSummary;
    }
  | {
      kind: 'unsupported';
      coverage: AnalyzerCoverageSummary;
    };

export interface AnalyzerRegistry {
  resolve(input: AnalyzerSelectionInput): AnalyzerResolution;
  require(input: AnalyzerSelectionInput): DeterministicAnalyzer;
}
```

`require(...)` remains for legacy callers and internally delegates to
`resolve(...)`, throwing only when a caller explicitly asks for that behavior.

### 2. Coverage persistence

Add an additive project-scoped table:

```sql
CREATE TABLE knowledge_analysis_coverage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  status TEXT NOT NULL,
  analyzer_id TEXT,
  analyzer_version TEXT,
  generated_code INTEGER NOT NULL DEFAULT 0,
  generated_reason TEXT,
  unsupported_reason TEXT,
  supported_features_json TEXT NOT NULL,
  missing_features_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, source_version_id),
  FOREIGN KEY (project_id, source_version_id)
    REFERENCES knowledge_source_versions(project_id, id) ON DELETE CASCADE
);
```

This row exists for every analyze attempt, including intentionally unsupported
inputs. It becomes the authoritative explanation for analysis coverage. It is
upserted (one row per source version) when a source version is reanalyzed or
requeued, never duplicated.

### 3. Dynamic/generated relationship persistence

Add a bounded additive table for preserved-but-unmaterialized relationship
candidates:

```sql
CREATE TABLE knowledge_deferred_relationships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  source_symbol_id TEXT,
  target_symbol_id TEXT,
  target_reference TEXT,
  resolution_kind TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  confidence REAL NOT NULL,
  span_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, source_version_id, id),
  FOREIGN KEY (project_id, source_version_id)
    REFERENCES knowledge_source_versions(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, span_id)
    REFERENCES knowledge_source_spans(project_id, id) ON DELETE SET NULL
);
```

`resolution_kind` is constrained to:

- `dynamic_runtime`
- `generated_stub`
- `external_reference`
- `ambiguous_alias`
- `suppressed_policy`

These rows preserve evidence without asserting false graph certainty.

### 4. Additive extraction metadata

Extend `DeterministicExtraction` with additive fields:

```ts
export interface DeferredRelationshipCandidate {
  id: string;
  type: ExtractedRelationshipType;
  sourceSymbolId?: string | null;
  targetSymbolId?: string | null;
  targetReference?: string | null;
  resolutionKind:
    | 'dynamic_runtime'
    | 'generated_stub'
    | 'external_reference'
    | 'ambiguous_alias'
    | 'suppressed_policy';
  evidenceKind:
    | 'syntax'
    | 'manifest'
    | 'generated_marker'
    | 'naming'
    | 'comment'
    | 'import_side_effect';
  confidence: number;
  span?: KnowledgeSourceSpan | null;
  metadata?: ExtractedMetadata | null;
}

export interface DeterministicExtraction {
  // existing fields
  coverage?: AnalyzerCoverageSummary;
  deferredRelationships?: DeferredRelationshipCandidate[];
}
```

This is additive and keeps existing analyzers valid until upgraded.

## Worker and lifecycle behavior

1. The worker resolves the source through `AnalyzerRegistry.resolve(...)`.
2. Ariadne always writes a `knowledge_analysis_coverage` row, even when the
   source is unsupported.
3. Outcomes behave as follows:
   - **supported**: persist extraction, spans, graph materialization, pages,
     and coverage; complete with an `analyzed` result.
   - **partial**: persist extraction plus diagnostics and deferred
     relationships; complete with an `analyzed` result whose `coverageStatus`
     is `partial` and whose warnings carry the diagnostics.
   - **unsupported**: do not create fake extraction/page/graph rows; complete
     the job with a `coverage_only` result (below), the coverage row, and a
     bounded warning payload.
   - **failed**: preserve bounded redacted diagnostics and fail the job only
     for true processing problems such as corrupted content or unexpected
     parser exceptions.
4. Generated-code detection is advisory, not blocking. Examples include
   `@generated` markers, obvious lockfile/build outputs, or configured
   generated-path policies.
5. Dynamic/generated relationship candidates are persisted in
   `knowledge_deferred_relationships` and surfaced to graph completeness logic
   instead of being dropped.

This intentionally changes the semantic meaning of “unsupported” from “worker
crash” to “known coverage gap.”

### Unsupported job result: the `coverage_only` variant

Today `KnowledgeJobResult` requires `analyzerId`, `analyzerVersion`, and
`extractionId`, and an unsupported source throws
`KnowledgeWorkerUnsupportedJobError`, which fails the job with
`unsupported_source`. An unsupported source has no analyzer and no extraction, so
the result cannot be the `analyzed` shape. This slice resolves that with an
explicit variant rather than nullable fields on one type. The shared definition
(envelope owned by the citation slice) is:

```ts
export interface KnowledgeCoverageOnlyJobResult extends KnowledgeJobResultBase {
  resultKind: 'coverage_only';
  processingMode: 'deterministic';
  coverageStatus: 'unsupported';
  unsupportedReason: AnalyzerUnsupportedReason;
  analyzerId: null;
  analyzerVersion: null;
  extractionId: null;
}
```

Rules:

- The job completes (status `completed`) with `result_schema_version = 1`,
  `result_processing_mode = 'deterministic'`, and this payload. The coverage row
  (keyed by source version) is authoritative; the payload is a pointer plus a
  bounded warning list, so no coverage ID is embedded that could dangle after an
  archive import.
- No extraction, page, or graph rows are written. The worker does write the
  `metadata_only` search-index row (path/title) so unsupported files stay
  findable by path exactly as today. Freshness derives `fresh` from the completed
  job; the worker does not write freshness.
- `unsupported_source` remains a failure code only for unsupported **job kinds**
  (`KnowledgeWorkerUnsupportedJobError` for a non-`analyze` job). An unsupported
  **source** never raises it.
- `failed` coverage (corrupted content, unexpected parser exception) still
  fails the job and does not produce a `coverage_only` result.
- Legacy jobs already failed with `unsupported_source` for a source stay failed
  until requeued by the freshness slice's requeue API; the requeued run then
  completes as `coverage_only`.
- Counters: `KnowledgeWorkerRunResult` counts a coverage-only completion in
  `completed` and adds an additive `unsupportedCoverageCount`;
  `unknownCompletionCount` is unaffected.

## Unsupported diagnostics contract

Standardize these stable diagnostic codes across ingestors, analyzers, worker
warnings, CLI status, and archive payloads:

- `coverage_no_analyzer`
- `coverage_unknown_format`
- `coverage_adapter_missing`
- `coverage_binary_or_non_text`
- `coverage_size_limit_exceeded`
- `coverage_generated_code_detected`
- `coverage_partial_dynamic_relationships`
- `coverage_parser_failed`
- `coverage_policy_rejected`

Rules:

- Diagnostics must be human-readable but bounded.
- Diagnostics may include normalized path, MIME type, extension, byte-count
  bucket, analyzer ID/version, and reason code.
- Diagnostics must not include raw file contents, raw provider payloads,
  secrets, tokens, or absolute private paths outside the project's existing
  redaction boundary.

## Security and privacy constraints

- No source-content leakage: coverage rows store metadata, counts, reason
  codes, and redacted diagnostics only.
- No provider involvement: analyzer coverage must work completely offline.
- No runtime execution of untrusted code to “improve” relationship coverage.
- Generated-code detection must never weaken source-path or archive safety
  checks.
- Deferred relationship metadata must be sanitized through the same
  provenance/graph metadata rules already used elsewhere.

## Compatibility and migrations

- `knowledge_analysis_coverage` and `knowledge_deferred_relationships` are
  additive tables.
- Existing databases remain readable; sources without coverage rows are treated
  as `legacy_unknown` until reprocessed.
- **Archive class: required**, feature `knowledge-analysis-coverage-v1`, for both
  tables (see the umbrella spec). Both tables are exported in archive v2 in the
  order after `knowledge_source_spans`, validated for project ownership and
  same-archive references, and a v2 manifest declaring the feature is rejected if
  either table is missing. Older archives that lack them still import; their
  sources read as `legacy_unknown`. An explicit v1 export of a project with
  coverage rows fails closed (`manifest_version_incompatible`).
- Existing analyzers remain valid because `coverage` and
  `deferredRelationships` are optional additive fields.
- `KnowledgeWorkerRunResult` and status surfaces gain additive warning and
  count fields only.

Recommended rollout order:

1. reader/migration support (global migration 13) together with registration of
   both tables in the archive classification registry, which already exists
   because the archive framework lands first;
2. worker/status support, including the `coverage_only` writer;
3. analyzer and adapter adoption;
4. archive export/import of the new tables under manifest v2.

## TDD validation

Follow RED → GREEN → IMPROVE with focused tests for:

1. `AnalyzerRegistry.resolve(...)` returning supported vs unsupported outcomes
   deterministically.
2. `DocumentIngestor` and `MediaIngestor` outcomes mapping into unified
   coverage rows and warning codes.
3. Worker completion behavior for supported, partial, unsupported, and failed
   sources.
4. Generated-code detection staying advisory and never blocking safe
   deterministic extraction outright.
5. Deferred dynamic/generated relationships persisting without fake graph node
   creation.
6. Status/reporting surfacing coverage counts without storing or printing raw
   source content.
7. Archive round-trips preserving coverage/deferred-relationship rows, rejection
   of a v2 manifest that declares the feature but omits the tables, and fail-closed
   explicit v1 export.
8. `coverage_only` completion: job completes with `result_schema_version = 1`,
   no extraction/page/graph rows, a `metadata_only` search-index row, and
   `unknownCompletionCount` unchanged; unsupported job kinds still fail with
   `unsupported_source`.
9. Legacy databases reopening successfully with missing coverage rows.

Validation commands should include focused analyzer/worker/archive tests, the
full core suite/build, and the existing providerless synthetic acceptance tests.
