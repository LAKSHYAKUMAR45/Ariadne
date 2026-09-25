# Task 5 report

## Scope
Implemented deterministic Lezer-backed Python and JavaScript/TypeScript analyzers for `@ariadne-dev/core`, plus shared parser helpers, fixtures, registry wiring, contract extensions, and lockfile/runtime dependency updates.

## Files changed
- `packages/core/package.json`
- `pnpm-lock.yaml`
- `packages/core/src/index.ts`
- `packages/core/src/knowledge/KnowledgeExtraction.ts`
- `packages/core/src/knowledge/KnowledgeExtractionStore.ts`
- `packages/core/src/knowledge/analyzers/AnalyzerRegistry.ts`
- `packages/core/src/knowledge/analyzers/MarkdownAnalyzer.ts`
- `packages/core/src/knowledge/analyzers/TextAnalyzer.ts`
- `packages/core/src/knowledge/analyzers/index.ts`
- `packages/core/src/knowledge/analyzers/LezerHelpers.ts`
- `packages/core/src/knowledge/analyzers/PythonAnalyzer.ts`
- `packages/core/src/knowledge/analyzers/JavaScriptAnalyzer.ts`
- `packages/core/test/knowledge/analyzers/PythonAnalyzer.test.ts`
- `packages/core/test/knowledge/analyzers/JavaScriptAnalyzer.test.ts`
- `packages/core/test/knowledge/fixtures/python/jcnr_device_sample.py`
- `packages/core/test/knowledge/fixtures/typescript/service.ts`

## Design notes
- Added Lezer runtime dependencies: `@lezer/common`, `@lezer/javascript`, `@lezer/python`.
- Extracted shared parser helpers for node text/span conversion, stable IDs, module naming, parse diagnostics, and header-signature handling.
- Extended deterministic extraction contracts additively with parser confidence, optional symbol metadata, and unresolved-target relationship fields while preserving existing `fromId`/`toId` support for Task 4 markdown/text analyzers.
- Python analyzer supports `.py` and `.pyi`; JavaScript analyzer supports `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts` with extension-driven dialect selection.
- Local resolution is intentionally in-file only. Ambiguous duplicate local names now stay unresolved rather than misresolving nondeterministically.
- Parser-confirmed relationships/symbols/sections are emitted with confidence `1`; unresolved external/cross-file targets keep `targetReference` with `targetSymbolId: null`.

## RED evidence
1. Added fixtures/tests first.
2. Initial failing run:
   - `pnpm --filter @ariadne-dev/core test -- PythonAnalyzer.test.ts JavaScriptAnalyzer.test.ts`
   - Failed because `PythonAnalyzer`/`JavaScriptAnalyzer` were missing and the registry still selected `text` / no analyzer for code files.

## GREEN evidence
- `pnpm --filter @ariadne-dev/core test -- PythonAnalyzer.test.ts JavaScriptAnalyzer.test.ts`
- `pnpm --filter @ariadne-dev/core test -- PythonAnalyzer.test.ts JavaScriptAnalyzer.test.ts Ingestors.test.ts`
- `pnpm --filter @ariadne-dev/core build`

## Improve / rulings
- Preserved exact original source offsets and one-based line/column spans through Task 4 `SourceText` utilities.
- Used parser-backed structure extraction only; no regex-only structural extraction was introduced.
- Added parser-recovery diagnostics for malformed-but-parseable input without failing deterministic extraction.
- Reviewer follow-up fixes:
  - import target references now preserve original imported symbols instead of local aliases/default names;
  - Python dotted/aliased imports are parsed from Lezer-confirmed structure;
  - ambiguous duplicate bare names no longer overwrite prior symbols during local resolution.
