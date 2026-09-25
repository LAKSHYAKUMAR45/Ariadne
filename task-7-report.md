# Task 7 Report — Deterministic Pages and Content-Backed Search

## Scope
Implemented Task 7 in `packages/core`:
- deterministic source-page payload builder
- unchanged-content page-version reuse
- extraction-backed source search with bounded snippets and exact span coordinates
- additive provenance/rendering/export updates
- focused RED/GREEN tests and core build validation

## Design decisions
1. **Deterministic source pages**
   - Added `DeterministicPageBuilder` to build providerless `KnowledgeGenerationPayload` values from persisted deterministic extractions.
   - Page IDs are stable from `projectId + sourceId + sourceVersionId`.
   - Slugs preserve a readable source-path prefix while always retaining the source-version suffix.
   - Rendering uses escaped inline Markdown plus fenced excerpts so source-derived text cannot break page structure.
   - Builder summaries are bounded before persistence to avoid unbounded metadata leakage.

2. **Version reuse without rollback regressions**
   - `KnowledgeGeneratorService` now renders a reuse candidate against the current page version metadata and reuses that version only when markdown hash, summary, and canonicalized source-version IDs are unchanged.
   - File staging/rollback remains atomic; reused pages still participate in staged output generation.
   - Reused pages are reactivated in `knowledge_pages` so stale pages do not remain stale after deterministic regeneration.
   - Public compatibility is preserved: `KnowledgeGenerationResult.pages` still returns `KnowledgePageVersion[]`; additive `pageResults` exposes `reused` flags explicitly.

3. **Search ranking/snippets/citations**
   - Source search now reads the latest valid extraction row for the current source version and scores:
     - symbol qualified name: 10
     - symbol name: 8
     - section title: 7
     - page title: 6
     - section text: 5
     - page summary: 3
     - source path/url/content path: 2
   - Snippets are bounded to 180 chars and centered on the best lexical hit.
   - Exact span coordinates are sourced only from persisted `knowledge_source_spans` rows.
   - Malformed/legacy extraction rows are safely ignored, falling back to metadata-only source results.

4. **Provenance persistence/rendering**
   - Renderer frontmatter now emits additive source-version/offset/line metadata when finite.
   - `KnowledgePageStore` now round-trips persisted span metadata and only associates `source_span_id` values that belong to the referenced source.

## RED evidence
Command:
```bash
pnpm --filter @ariadne-dev/core test -- DeterministicPageBuilder.test.ts KnowledgeGeneratorService.test.ts KnowledgeSearch.test.ts
```
Initial RED result:
- missing `DeterministicPageBuilder` module
- duplicate unchanged page versions were still created
- source search still ranked path-only metadata above extraction-backed matches
- malformed extraction rows were not yet handled safely in search setup/implementation

## GREEN evidence
Command:
```bash
pnpm --filter @ariadne-dev/core test -- DeterministicPageBuilder.test.ts KnowledgeGeneratorService.test.ts KnowledgeSearch.test.ts
```
Final result:
- pass (`vitest` matched and passed 62 files / 487 tests in this workspace configuration)

Command:
```bash
pnpm --filter @ariadne-dev/core build
```
Final result:
- pass (`tsc -p tsconfig.json`)

## Review rulings
- **TypeScript Reviewer**: final pass, no remaining issues after compatibility/reuse fixes.
- **Security Reviewer**: final pass, no remaining issues after Markdown escaping, bounded summaries, and span-source validation fixes.

## Files changed
- `packages/core/src/knowledge/DeterministicPageBuilder.ts`
- `packages/core/src/knowledge/KnowledgeGeneratorService.ts`
- `packages/core/src/knowledge/KnowledgePageStore.ts`
- `packages/core/src/knowledge/KnowledgeRenderer.ts`
- `packages/core/src/knowledge/KnowledgeSearch.ts`
- `packages/core/src/index.ts`
- `packages/core/test/knowledge/DeterministicPageBuilder.test.ts`
- `packages/core/test/knowledge/KnowledgeGeneratorService.test.ts`
- `packages/core/test/knowledge/KnowledgeSearch.test.ts`
- `task-7-report.md`

## Rulings / non-goals kept
- Did not modify worker/provider/CLI/MCP/VS Code/dashboard codepaths.
- Did not widen search across projects; all extraction/span lookups remain project-scoped.
- Did not expose raw extraction JSON or unbounded source blobs in results.
