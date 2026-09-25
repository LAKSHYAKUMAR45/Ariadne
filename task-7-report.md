# Task 7 Report — Fix Round 2

## Scope
Applied Task 7 round-2 fixes in `packages/core` only:

- `KnowledgeGeneratorService`
- `KnowledgeSearch`
- focused Task 7 regressions

No worker/provider/adapter/CLI/MCP/VS Code/dashboard codepaths were changed.

## RED
Initial focused RED command:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/DeterministicPageBuilder.test.ts test/knowledge/KnowledgeGeneratorService.test.ts test/knowledge/KnowledgeSearch.test.ts
```

Initial failure recorded before implementation:

- `searchKnowledge > skips extraction rows when persisted spans overflow the bounded lookup window`
  - search still treated an overflowed extraction as content-backed, returned a span-backed citation, and exposed extraction metadata instead of falling back safely

Additional round-2 regressions added during the fix cover:

- spanless/path-like extraction-title matches staying metadata-ranked
- UTF-8 byte query caps for Unicode-heavy input
- two-connection SQLite unchanged-version dedupe without the public `beforePersist` hook
- task/graph expansion redaction on returned search context
- symlinked `log.md` rejection during generation

## GREEN
Focused Task 7 command:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/DeterministicPageBuilder.test.ts test/knowledge/KnowledgeGeneratorService.test.ts test/knowledge/KnowledgeSearch.test.ts
```

Result:

- pass (`3` files / `33` tests)

Full core tests:

```bash
pnpm --filter @ariadne-dev/core test
```

Result:

- pass (`62` files / `501` tests)

Core build:

```bash
pnpm --filter @ariadne-dev/core build
```

Result:

- pass (`tsc -p tsconfig.json`)

## Fix summary

### 1. Spanless extraction metadata no longer masquerades as content

- extraction fields only receive content rank when they are backed by a persisted span
- spanless extraction title/summary matches remain searchable, but are classified as metadata
- repeated path-like source-title matches can no longer outrank true symbol/section hits solely by lexical repetition
- exact citation requirements still hold for content-ranked matches

### 2. Persisted span loading is SQL-bounded and overflow-safe

- persisted span loading now uses SQL `LIMIT MAX+1` instead of loading every row then slicing
- overflow is detected explicitly
- overflowed extraction rows are skipped as extraction-backed content so search does not emit partial or misleading citations
- metadata fallback behavior is preserved when the source path/title still matches

### 3. Query caps now enforce UTF-8 bytes

- query rejection now checks `Buffer.byteLength(normalizedQuery, 'utf8')`
- the prior length guard remains in place as a cheap code-unit bound
- added Unicode-heavy regression coverage

### 4. Public test-only hook removed; dedupe invariant documented via two connections

- removed the public `beforePersist` hook from `KnowledgeGeneratorServiceOptions`
- replaced that coverage with an on-disk two-connection SQLite regression that exercises the transactional compare-and-insert invariant directly
- documented in the test that SQLite serializes writers, so the invariant is validated across independent connections rather than forced simultaneous writes

### 5. Search redaction and generation path hardening

- task-mode search results now redact returned task titles and match text before surfacing or budgeting them
- graph expansion titles/text are redacted before returning or budgeting them
- generation revalidates the output-root/log path against symlinks before reading `log.md`
- file commit staging now revalidates the output root and staged target parents against the workspace root before writes/renames

## Migration ruling

No schema migration was required for this round.

Ruling: unchanged-generation safety remains enforced through transactional compare-and-insert behavior rather than new SQLite columns or indexes.

## Security / audit notes

- SQL remained parameterized; no string-interpolated query inputs were introduced
- project scoping remains enforced on page/source/span lookups
- search results now redact titles/snippets/graph expansions/task matches before return and context budgeting
- persisted-span overflow no longer yields misleading content-backed citations
- generation now rejects symlinked `log.md` inputs and revalidates output-root paths before staging writes

## Files changed

- `packages/core/src/knowledge/KnowledgeGeneratorService.ts`
- `packages/core/src/knowledge/KnowledgeSearch.ts`
- `packages/core/test/knowledge/KnowledgeGeneratorService.test.ts`
- `packages/core/test/knowledge/KnowledgeSearch.test.ts`
- `task-7-report.md`

## Remaining concerns

- `searchKnowledge()` still scores all active pages/sources in JavaScript after loading them with `.all()`. The new per-item caps bound extraction payload handling, but very large projects may still want SQL-side prefiltering or a persisted index in a future task.
