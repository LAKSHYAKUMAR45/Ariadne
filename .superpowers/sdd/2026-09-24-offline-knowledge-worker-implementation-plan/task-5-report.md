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

## Task 5 review blockers — RED -> GREEN

### RED
Added failing coverage first for:
- mixed JS/TS default+named imports with exact specifier spans and alias metadata;
- export lists, `as default`, named re-exports, named default declarations, and anonymous default function/class declarations;
- Python and JS/TS parameter/local shadowing to prove unresolved targets stay unresolved;
- unsupported-extension registry behavior;
- malformed-but-parseable TS export syntax without fabricated parser-confirmed export facts;
- CR-only Python span coverage.

Failing reproduction before implementation:

```bash
pnpm --filter @ariadne-dev/core test -- AnalyzerRegistry.test.ts PythonAnalyzer.test.ts JavaScriptAnalyzer.test.ts
```

Observed failures:
- anonymous default JS export symbols/relationships missing;
- JS calls incorrectly resolved to top-level symbols through parameter/local shadowing;
- Python calls incorrectly resolved through parameter shadowing.

### GREEN
Passing validation after the fixes:

```bash
pnpm exec vitest run \
  test/knowledge/analyzers/AnalyzerRegistry.test.ts \
  test/knowledge/analyzers/PythonAnalyzer.test.ts \
  test/knowledge/analyzers/JavaScriptAnalyzer.test.ts \
  test/knowledge/formats/Ingestors.test.ts

pnpm --filter @ariadne-dev/core build
```

Results:
- 19/19 focused Task 5 + Ingestors tests passed.
- `@ariadne-dev/core` build passed.

Reviewer follow-up RED coverage added for:
- namespace-only imports without fabricated default imports;
- `export { default as Foo } from 'pkg'`;
- JS nested block / `for`-loop shadowing precision;
- TS value-space parameter names not suppressing type-space references;
- Python `from ... import X as Y` alias shadowing without falsely shadowing `X`.

Final validation after those fixes:

```bash
pnpm exec vitest run \
  test/knowledge/analyzers/AnalyzerRegistry.test.ts \
  test/knowledge/analyzers/PythonAnalyzer.test.ts \
  test/knowledge/analyzers/JavaScriptAnalyzer.test.ts \
  test/knowledge/formats/Ingestors.test.ts

pnpm --filter @ariadne-dev/core test
pnpm --filter @ariadne-dev/core build
```

Final results:
- 33/33 focused Task 5 + Ingestors tests passed.
- 451/451 `@ariadne-dev/core` tests passed.
- `@ariadne-dev/core` build passed.

Additional reviewer RED coverage added for:
- Python tuple assignment / loop-unpacking shadow bindings;
- Python chained assignment target shadow bindings;
- class-body imports and comma-separated bare imports shadowing later Python references;
- TS nested block-local type aliases not suppressing safe outer-block resolutions;
- JS mixed default+namespace imports plus `import { default as Foo }` metadata/target extraction.

Final revalidation after those fixes:

```bash
pnpm exec vitest run \
  test/knowledge/analyzers/AnalyzerRegistry.test.ts \
  test/knowledge/analyzers/PythonAnalyzer.test.ts \
  test/knowledge/analyzers/JavaScriptAnalyzer.test.ts \
  test/knowledge/formats/Ingestors.test.ts

pnpm --filter @ariadne-dev/core test
pnpm --filter @ariadne-dev/core build
```

Final results:
- 39/39 focused Task 5 + Ingestors tests passed.
- 457/457 `@ariadne-dev/core` tests passed.
- `@ariadne-dev/core` build passed.

### IMPROVE
- JS import relationships now emit one deterministic relationship per binding, including mixed default+named imports, with exact binding spans and metadata for import kind / imported name / local alias.
- JS export extraction now covers export lists, alias/default specifiers, supported named re-exports, named default declarations, and anonymous default function/class declarations without inventing non-source-backed identities.
- Local target resolution now uses conservative scope bindings for JS/TS and Python so shadowed names stay unresolved when safety is not provable.
- Python scope binding collection now covers tuple/multi-target assignment, chained assignment, loop destructuring, and bare-import bindings, while class-body sequential resolution treats prior imports as local shadows.
- TS type-reference resolution now tracks block-local type-space shadowing per block so safe outer resolutions remain intact after nested aliases/interfaces.
- JS import extraction now covers mixed default+namespace bindings even when Lezer recovers imperfectly for that syntax shape, and preserves `default` as the original imported name for `import { default as Foo }`.
- Anonymous default class spans intentionally stop at the parser-confirmed declaration header because Lezer exposes the body separately for that syntax shape; this preserves exact parser-backed evidence instead of inventing a wider declaration span.

## Improve / rulings
- Preserved exact original source offsets and one-based line/column spans through Task 4 `SourceText` utilities.
- Used parser-backed structure extraction only; no regex-only structural extraction was introduced.
- Added parser-recovery diagnostics for malformed-but-parseable input without failing deterministic extraction.
- Reviewer follow-up fixes:
  - import target references now preserve original imported symbols instead of local aliases/default names;
  - Python dotted/aliased imports are parsed from Lezer-confirmed structure;
  - ambiguous duplicate bare names no longer overwrite prior symbols during local resolution.
