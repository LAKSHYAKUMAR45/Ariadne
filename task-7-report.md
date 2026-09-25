# Task 7 Report — FIX ALL

## Scope
Applied the Task 7 FIX ALL remediation only in `packages/core`:

- `DeterministicPageBuilder`
- `KnowledgeGeneratorService`
- `KnowledgeSearch`
- focused Task 7 tests

No worker/provider/adapter/CLI/MCP/VS Code/dashboard codepaths were changed.

## RED
Command:

```bash
pnpm --filter @ariadne-dev/core test -- DeterministicPageBuilder.test.ts KnowledgeGeneratorService.test.ts KnowledgeSearch.test.ts
```

Initial RED failures reproduced all blocker classes added in this pass:

- fabricated top-level provenance bounds (`startOffset: 0`, `line 1:1`) instead of real extraction span bounds
- unchanged generation race creating a second semantic page version after an interleaved identical generation
- path-only metadata outranking extraction-backed source matches under repeated-path adversarial input
- extraction-backed snippets returning unredacted / wrong-match excerpts instead of redacted source-backed text

## GREEN
Focused Task 7 command:

```bash
pnpm --filter @ariadne-dev/core test -- DeterministicPageBuilder.test.ts KnowledgeGeneratorService.test.ts KnowledgeSearch.test.ts
```

Result:

- pass (`62` files / `495` tests in this workspace Vitest configuration)

Full core tests:

```bash
pnpm --filter @ariadne-dev/core test
```

Result:

- pass (`62` files / `495` tests)

Core build:

```bash
pnpm --filter @ariadne-dev/core build
```

Result:

- pass (`tsc -p tsconfig.json`)

## Fix summary

### 1. Race-safe unchanged generation

- moved page-version decision and creation into a single `BEGIN IMMEDIATE` persistence window
- re-checks the current page version immediately before persist, so an interleaved identical generation reuses the already-current version instead of creating a duplicate semantic version
- preserves rollback semantics: filesystem commit still rolls back on failure before DB commit completes
- added a deterministic regression via `beforePersist` that interleaves a second identical generation between preparation and persistence
- hardened job ownership by:
  - issuing per-service-instance worker IDs
  - claiming/renewing a lease before persistence
  - guarding completion/failure updates on worker + lease ownership

### 2. Rank classes for extraction-backed search

- introduced explicit source search rank classes:
  - extraction-backed matches
  - metadata/path-only fallback matches
- source-vs-source ordering now compares rank class before score/tie-breaks, preventing repeated-path metadata from beating real extraction content
- preserved existing modes and deterministic tie-breaks

### 3. Exact top-level provenance only

- top-level deterministic-page provenance now derives min/max bounds from real extracted spans only
- when no real span exists, coordinate fields are omitted instead of fabricated
- no more claims over unextracted source regions

### 4. Secret-safe search snippets

- reused the shared repository redactor at the extraction indexing/search boundary
- bounded snippets now come from redacted extraction text
- page/source titles, summaries, citation paths/URLs/labels, and context-fed metadata are also redacted before results are returned or budgeted
- citations still reference exact persisted source spans; only human-readable text is redacted
- regression coverage includes API-key/token/password/AWS-key-style content

### 5. Search CPU / memory bounds

- added conservative caps for:
  - query length and query terms
  - extraction JSON bytes
  - symbols, sections, searchable fields, persisted spans, and result candidates
- oversized/malformed legacy extraction rows now safely fall back to metadata-only source results instead of crashing the whole search
- replaced repeated span scans with O(1) keyed lookups
- avoided repeated extraction parsing within a query via per-query caching

## Migration ruling

No schema migration was required for this FIX ALL pass.

Ruling: concurrency safety is enforced with a transactional compare-and-insert flow in `KnowledgeGeneratorService` rather than new SQLite columns/indexes. That kept Task 7 surgical while still eliminating duplicate unchanged semantic versions and preserving atomic rollback behavior.

## Security / audit notes

- SQL remained parameterized; no new string-interpolated query inputs were introduced
- project scoping remains enforced on page/source/span lookups
- Markdown/provenance output no longer invents source coverage
- search excerpts/context no longer re-expose secrets stored inside extraction JSON or result metadata
- output writes now symlink-check target parent paths before backup/rename
- rollback cleanup still removes staged outputs when persistence fails
- final **Security Reviewer** signoff: no remaining scoped issues

## Files changed

- `packages/core/src/knowledge/DeterministicPageBuilder.ts`
- `packages/core/src/knowledge/KnowledgeGeneratorService.ts`
- `packages/core/src/knowledge/KnowledgeSearch.ts`
- `packages/core/test/knowledge/DeterministicPageBuilder.test.ts`
- `packages/core/test/knowledge/KnowledgeGeneratorService.test.ts`
- `packages/core/test/knowledge/KnowledgeSearch.test.ts`
- `task-7-report.md`

## Remaining concerns

- `beforePersist` is an additive deterministic test hook on `KnowledgeGeneratorServiceOptions`; it is intentionally small, but still public API surface.
- Search caps are conservative and deterministic, but very large extraction corpora may still warrant a persisted search index in a future task if recall/performance trade-offs become visible.
