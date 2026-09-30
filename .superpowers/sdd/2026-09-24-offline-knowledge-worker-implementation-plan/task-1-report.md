# Task 1 Report: Evolve the knowledge schema and add extraction persistence

## Implementation
Implemented the schema-v2 extraction persistence foundation for `@ariadne-dev/core`.

### What changed
- Bumped `KNOWLEDGE_SCHEMA_VERSION` from `1` to `2`.
- Extended `knowledge_source_spans` with nullable line-aware coordinates:
  - `start_line`, `start_column`, `end_line`, `end_column`
- Extended `knowledge_extractions` with extraction identity and persisted payload fields:
  - `analyzer_id`, `analyzer_version`, `extraction_hash`, `result_json`, `diagnostics_json`, `completed_at`
- Extended `knowledge_jobs` with nullable `result_json`.
- Added unique analyzer identity index:
  - `idx_knowledge_extractions_analyzer`
- Added guarded additive migration logic for existing databases in `applyKnowledgeSchemaV2Migration()`.
- Added normalized deterministic extraction types and validation helpers in `KnowledgeExtraction.ts`.
- Added `offsetToPosition()` for one-based line/column conversion.
- Added `KnowledgeExtractionStore` with:
  - `save()` upsert semantics keyed by project/source/extractor/analyzer identity
  - stable extraction hashing from canonical JSON with sorted arrays
  - idempotent source-span persistence using deterministic span IDs
  - `getCurrent()` and `listSections()` read APIs
  - diagnostics sanitization via schema validation so extra fields are not persisted
- Exported the new types/helpers/store from `packages/core/src/index.ts`.

## Files changed
- Modified: `packages/core/src/knowledge/knowledgeSchema.ts`
- Modified: `packages/core/src/knowledge/knowledgeMigrations.ts`
- Added: `packages/core/src/knowledge/KnowledgeExtraction.ts`
- Added: `packages/core/src/knowledge/KnowledgeExtractionStore.ts`
- Modified: `packages/core/src/index.ts`
- Modified: `packages/core/test/knowledge/knowledgeMigrations.test.ts`
- Added: `packages/core/test/knowledge/KnowledgeExtractionStore.test.ts`

## RED/GREEN TDD evidence

### RED 1: migration test
Command:
```bash
pnpm --filter @ariadne-dev/core test -- knowledgeMigrations.test.ts
```
Relevant output:
```text
FAIL test/knowledge/knowledgeMigrations.test.ts
expected 1 to be 2
SqliteError: table knowledge_extractions has no column named analyzer_id
```

### GREEN 1: migration test
Command:
```bash
pnpm --filter @ariadne-dev/core test -- knowledgeMigrations.test.ts
```
Relevant output:
```text
✓ test/knowledge/knowledgeMigrations.test.ts (5 tests)
Test Files 53 passed (53)
Tests 392 passed (392)
```

### RED 2: extraction store test
Command:
```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeExtractionStore.test.ts
```
Relevant output:
```text
FAIL test/knowledge/KnowledgeExtractionStore.test.ts
Cannot find module '../../src/knowledge/KnowledgeExtractionStore.js'
```

### GREEN 2: focused extraction + migration validation
Command:
```bash
pnpm --filter @ariadne-dev/core test -- knowledgeMigrations.test.ts KnowledgeExtractionStore.test.ts
```
Relevant output:
```text
✓ test/knowledge/KnowledgeExtractionStore.test.ts (2 tests)
✓ test/knowledge/knowledgeMigrations.test.ts (5 tests)
Test Files 54 passed (54)
Tests 394 passed (394)
```

### Final validation
Build:
```bash
pnpm --filter @ariadne-dev/core build
```
Result:
```text
> tsc -p tsconfig.json
```

Full suite:
```bash
pnpm --filter @ariadne-dev/core test
```
Relevant output:
```text
Test Files 54 passed (54)
Tests 395 passed (395)
```

## Tests and results
- `pnpm --filter @ariadne-dev/core test -- knowledgeMigrations.test.ts` ✅
- `pnpm --filter @ariadne-dev/core test -- KnowledgeExtractionStore.test.ts` ✅
- `pnpm --filter @ariadne-dev/core test -- knowledgeMigrations.test.ts KnowledgeExtractionStore.test.ts` ✅
- `pnpm --filter @ariadne-dev/core build` ✅
- `pnpm --filter @ariadne-dev/core test` ✅

## Self-review
Reviewed the task diff after validation.

Checked for:
- migration additivity and idempotence on existing databases
- exact schema columns/index from the brief
- deterministic extraction hash stability through canonical JSON sorting
- duplicate-row prevention and update-in-place behavior in `save()`
- span deduplication with deterministic IDs
- sanitized diagnostics persistence without leaking extra diagnostic fields
- public core exports for later tasks

One improvement made during self-review:
- tightened internal store reads so `save()` re-reads by full extraction identity, avoiding ambiguity if multiple extractor kinds later share the same analyzer ID/version.

## Concerns
- `getCurrent(projectId, sourceVersionId, analyzerId, analyzerVersion)` intentionally does not take `extractorKind`, because the task brief fixed its signature. If future work persists multiple extractor kinds with the same analyzer identity for one source version, callers may need a kind-aware read API.
- This task establishes persistence/validation only; downstream worker, graph, and page-generation consumers still need to be wired in later tasks.

## Fix Round 1

### Changes
- Applied Ariadne shared line-preserving secret redaction at the `KnowledgeExtractionStore.save()` persistence boundary so `result_json` and `diagnostics_json` never store secret-like values in SQLite while preserving extraction IDs, spans, and persisted record structure.
- Added a contextual `KnowledgeExtractionStoreError` wrapper for malformed persisted `result_json` reads instead of leaking raw `SyntaxError`.
- Made `listSections()` skip legacy/incomplete migrated extraction rows whose v2 fields are still `NULL`.
- Preserved the exact public `getCurrent(projectId, sourceVersionId, analyzerId, analyzerVersion)` signature and added an explicit cross-kind analyzer-identity collision check in `save()` for the same project/source version.

### Files changed
- Modified: `packages/core/src/knowledge/KnowledgeExtractionStore.ts`
- Modified: `packages/core/test/knowledge/KnowledgeExtractionStore.test.ts`

### Test coverage added/amended
- `packages/core/test/knowledge/KnowledgeExtractionStore.test.ts`
  - verifies realistic GitHub/OpenAI-style secrets are redacted from both persisted `result_json` and `diagnostics_json`
  - verifies the extraction still persists with preserved section IDs and span coordinates
  - verifies legacy migrated rows with `NULL` v2 fields are skipped by `listSections()`
  - verifies cross-kind analyzer identity reuse is rejected for the same project/source version
  - verifies malformed persisted `result_json` throws a contextual `KnowledgeExtractionStore` error

### Commands

Focused regression suite:
```bash
pnpm --filter @ariadne-dev/core test -- knowledgeMigrations.test.ts KnowledgeExtractionStore.test.ts
```
Relevant output:
```text
✓ test/knowledge/knowledgeMigrations.test.ts (5 tests)
✓ test/knowledge/KnowledgeExtractionStore.test.ts (6 tests)
Test Files 54 passed (54)
Tests 398 passed (398)
```

Full core suite:
```bash
pnpm --filter @ariadne-dev/core test
```
Relevant output:
```text
✓ test/knowledge/KnowledgeExtractionStore.test.ts (6 tests)
Test Files 54 passed (54)
Tests 398 passed (398)
```

Core build:
```bash
pnpm --filter @ariadne-dev/core build
```
Relevant output:
```text
> tsc -p tsconfig.json
```
