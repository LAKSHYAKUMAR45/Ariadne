# Offline-First Knowledge Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain Ariadne knowledge analysis queues into deterministic, cited pages, typed graph data, and content-backed search results without requiring an external model, while supporting optional provider enrichment.

**Architecture:** A reusable core `KnowledgeWorker` claims project-scoped jobs, loads immutable source versions, runs deterministic format analyzers, persists normalized extractions and spans, materializes typed graph relationships, and delegates atomic page writes to `KnowledgeGeneratorService`. Host adapters configure optional OpenAI-compatible enrichment, but deterministic output remains the successful baseline when providers are absent or fail.

**Tech Stack:** TypeScript 5.5, Node.js 20+, SQLite via `better-sqlite3`, Vitest, Commander, MCP SDK/Zod, React 19, VS Code extension APIs, Lezer parsers (`@lezer/common`, `@lezer/python`, `@lezer/javascript`), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-24-offline-knowledge-worker-design.md`

## Global Constraints

- Deterministic processing must work without credentials or network access.
- Process the immutable registered source version; never fall back to the current mutable source file.
- Queue selection and conditional claim updates must both be scoped by project ID.
- Provider output is untrusted, validated, source-grounded enrichment and cannot remove deterministic facts.
- Provider failure after deterministic success records a warning and does not fail the source job.
- API keys and secret values must never be stored in SQLite, job payloads, archives, generated pages, logs, or progress events.
- Preserve the last good pages and graph until replacement writes commit atomically.
- Every persisted extraction, citation, node, and edge must retain source-version provenance; exact spans are required where parsers expose positions.
- New and changed TypeScript code must pass build/type-check and targeted tests before broader suites.
- Use TDD for every task: failing test, minimal implementation, passing test, refactor only after green.

---

## File Structure

### Core files to create

- `packages/core/src/knowledge/KnowledgeExtraction.ts` — normalized deterministic extraction types, validators, offsets, and line/column helpers.
- `packages/core/src/knowledge/KnowledgeExtractionStore.ts` — idempotent extraction and span persistence.
- `packages/core/src/knowledge/KnowledgeSourceVersionLoader.ts` — confined immutable content loading and hash verification.
- `packages/core/src/knowledge/analyzers/AnalyzerRegistry.ts` — analyzer selection by extension/MIME.
- `packages/core/src/knowledge/analyzers/TextAnalyzer.ts` — plain text section extraction.
- `packages/core/src/knowledge/analyzers/MarkdownAnalyzer.ts` — headings, sections, links, wikilinks, and code blocks.
- `packages/core/src/knowledge/analyzers/PythonAnalyzer.ts` — Lezer-backed Python symbols and relationships.
- `packages/core/src/knowledge/analyzers/JavaScriptAnalyzer.ts` — Lezer-backed JavaScript/TypeScript symbols and relationships.
- `packages/core/src/knowledge/analyzers/index.ts` — analyzer exports and default registry.
- `packages/core/src/knowledge/KnowledgeGraphMaterializer.ts` — extraction-to-native-graph mapping.
- `packages/core/src/knowledge/DeterministicPageBuilder.ts` — source/symbol page payload construction.
- `packages/core/src/knowledge/KnowledgeWorker.ts` — queue orchestration, leases, progress, cancellation, and result semantics.
- `packages/core/src/knowledge/KnowledgeProviderProfiles.ts` — non-secret profile persistence and validation.
- `packages/core/src/knowledge/providers/OpenAICompatibleProvider.ts` — optional HTTP enrichment adapter.

### Core files to modify

- `packages/core/src/knowledge/knowledgeSchema.ts`
- `packages/core/src/knowledge/knowledgeMigrations.ts`
- `packages/core/src/knowledge/KnowledgeQueue.ts`
- `packages/core/src/knowledge/KnowledgeGeneratorService.ts`
- `packages/core/src/knowledge/KnowledgeSearch.ts`
- `packages/core/src/knowledge/GraphifyImport.ts`
- `packages/core/src/knowledge/graph/KnowledgeGraph.ts`
- `packages/core/src/knowledge/KnowledgeTypes.ts`
- `packages/core/src/index.ts`
- `packages/core/package.json`
- `pnpm-lock.yaml`

### Adapter files to modify

- `packages/cli/src/knowledgeCommands.ts`
- `packages/cli/test/knowledgeCommands.test.ts`
- `packages/mcp-server/src/knowledgeTools.ts`
- `packages/mcp-server/test/knowledgeTools.test.ts`
- `packages/vscode-extension/src/extension.ts`
- `packages/vscode-extension/test/extension.test.ts`
- `packages/dashboard/src/api/types.ts`
- `packages/dashboard/src/api/guards.ts`
- `packages/dashboard/src/knowledge/KnowledgeOverviewPage.tsx`
- `packages/dashboard/src/knowledge/KnowledgePages.test.tsx`
- `packages/dashboard/e2e/fixtures.ts`
- `packages/dashboard/e2e/knowledge.spec.ts`

### Documentation and acceptance artifacts

- `.github/skills/ariadne/SKILL.md`
- `.github/agents/ariadne.agent.md`
- `docs/knowledge-worker.md`
- `packages/core/test/knowledge/fixtures/python/jcnr_device_sample.py`
- `packages/core/test/knowledge/fixtures/typescript/service.ts`
- `packages/core/test/knowledge/fixtures/markdown/architecture.md`
- `packages/core/test/knowledge/KnowledgeWorker.naas.test.ts` — opt-in fixture-driven acceptance scoring, not dependent on `/home/lkumar/atom`.

---

### Task 1: Evolve the knowledge schema and add extraction persistence

**Files:**
- Modify: `packages/core/src/knowledge/knowledgeSchema.ts`
- Modify: `packages/core/src/knowledge/knowledgeMigrations.ts`
- Create: `packages/core/src/knowledge/KnowledgeExtraction.ts`
- Create: `packages/core/src/knowledge/KnowledgeExtractionStore.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/knowledge/knowledgeMigrations.test.ts`
- Create: `packages/core/test/knowledge/KnowledgeExtractionStore.test.ts`

**Interfaces:**
- Produces:
  - `KnowledgeSourcePosition`
  - `KnowledgeSourceSpan`
  - `ExtractedSection`
  - `ExtractedSymbol`
  - `ExtractedRelationship`
  - `DeterministicExtraction`
  - `validateDeterministicExtraction(value: unknown): DeterministicExtraction`
  - `offsetToPosition(content: string, offset: number): KnowledgeSourcePosition`
  - `KnowledgeExtractionStore.save(input: SaveKnowledgeExtractionInput): KnowledgeExtractionRecord`
  - `KnowledgeExtractionStore.getCurrent(projectId: string, sourceVersionId: string, analyzerId: string, analyzerVersion: string): KnowledgeExtractionRecord | null`
  - `KnowledgeExtractionStore.listSections(projectId: string, sourceVersionId: string): KnowledgeExtractionSectionRecord[]`

- [ ] **Step 1: Write migration tests for extraction identity and line-aware spans**

Add assertions that a migrated database contains:

```ts
expect(columns(db, 'knowledge_extractions')).toEqual(expect.arrayContaining([
  'analyzer_id',
  'analyzer_version',
  'extraction_hash',
  'result_json',
  'diagnostics_json',
  'completed_at',
]));
expect(columns(db, 'knowledge_source_spans')).toEqual(expect.arrayContaining([
  'start_line',
  'start_column',
  'end_line',
  'end_column',
]));
expect(columns(db, 'knowledge_jobs')).toContain('result_json');
```

Also assert the unique index prevents two rows with the same
`project_id/source_version_id/extractor_kind/analyzer_id/analyzer_version`.

- [ ] **Step 2: Run the migration test and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- knowledgeMigrations.test.ts
```

Expected: FAIL because the new columns and index do not exist.

- [ ] **Step 3: Add additive schema version 2 migration**

Set `KNOWLEDGE_SCHEMA_VERSION = 2`. Keep `KNOWLEDGE_SCHEMA_SQL` valid for new
databases and add guarded `ALTER TABLE` operations for existing databases.
Use nullable migration columns for backward compatibility, then enforce
required fields in `KnowledgeExtractionStore`.

Create:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_extractions_analyzer
ON knowledge_extractions(
  project_id,
  source_version_id,
  extractor_kind,
  analyzer_id,
  analyzer_version
);
```

- [ ] **Step 4: Run the migration test and verify success**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- knowledgeMigrations.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing extraction validator and store tests**

Cover:

```ts
const extraction: DeterministicExtraction = {
  analyzerId: 'python-lezer',
  analyzerVersion: '1',
  sourceVersionId,
  title: 'jcnr_device.py',
  summary: 'Python module with one class.',
  sections: [{
    id: 'section:1',
    kind: 'code',
    title: 'JCNRDevice',
    text: 'class JCNRDevice:',
    span: { startOffset: 0, endOffset: 17, startLine: 1, startColumn: 1, endLine: 1, endColumn: 18 },
  }],
  symbols: [],
  relationships: [],
  links: [],
  diagnostics: [],
};
```

Assert:

- invalid offsets, duplicate IDs, missing source IDs, and unknown relationship
  endpoints are rejected;
- `save()` inserts source spans and one extraction;
- a second identical `save()` returns the same logical record;
- changed extraction JSON updates the existing row instead of duplicating it;
- diagnostics persist without source content leakage.

- [ ] **Step 6: Run the store tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeExtractionStore.test.ts
```

Expected: FAIL because the files and exports do not exist.

- [ ] **Step 7: Implement normalized extraction types, validation, and persistence**

Use exact discriminants:

```ts
export type ExtractedSymbolKind =
  | 'module' | 'class' | 'interface' | 'type' | 'enum'
  | 'function' | 'method' | 'property' | 'constant';

export type ExtractedRelationshipType =
  | 'imports' | 'exports' | 'defines' | 'contains'
  | 'inherits' | 'implements' | 'calls' | 'references' | 'links_to';
```

Compute `extraction_hash` from stable JSON with sorted arrays. Store full
normalized JSON in `result_json`. Insert one `knowledge_source_spans` row for
every unique span and expose their IDs in store records.

- [ ] **Step 8: Run extraction and migration tests**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- knowledgeMigrations.test.ts KnowledgeExtractionStore.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/knowledge/knowledgeSchema.ts \
  packages/core/src/knowledge/knowledgeMigrations.ts \
  packages/core/src/knowledge/KnowledgeExtraction.ts \
  packages/core/src/knowledge/KnowledgeExtractionStore.ts \
  packages/core/src/index.ts \
  packages/core/test/knowledge/knowledgeMigrations.test.ts \
  packages/core/test/knowledge/KnowledgeExtractionStore.test.ts
git commit -m "feat(knowledge): persist deterministic extractions"
```

---

### Task 2: Make queue ownership project-scoped and renewable

**Files:**
- Modify: `packages/core/src/knowledge/KnowledgeQueue.ts`
- Modify: `packages/core/test/knowledge/KnowledgeQueue.test.ts`
- Modify: `packages/cli/src/knowledgeCommands.ts`
- Modify: `packages/cli/test/knowledgeCommands.test.ts`
- Modify: `packages/mcp-server/src/knowledgeTools.ts`
- Modify: `packages/mcp-server/test/knowledgeTools.test.ts`

**Interfaces:**
- Changes:
  - `claim(projectId: string, workerId: string): KnowledgeJobRecord | null`
  - `complete(jobId: string, workerId?: string, result?: KnowledgeJobResult): KnowledgeJobRecord`
- Produces:
  - `renewLease(jobId: string, workerId: string): KnowledgeJobRecord`
  - `recoverExpiredKnowledgeJobs(projectId?: string): string[]`
  - `getQueueStatus(projectId: string): KnowledgeQueueStatus`

`KnowledgeJobResult` is persisted in `knowledge_jobs.result_json` and includes:

```ts
export interface KnowledgeJobResult {
  processingMode: 'deterministic' | 'enriched';
  analyzerId: string;
  analyzerVersion: string;
  extractionId: string;
  pageVersionIds: string[];
  graphNodeCount: number;
  graphEdgeCount: number;
  warnings: Array<{ code: string; message: string }>;
}
```

- [ ] **Step 1: Write failing cross-project and lease-renewal tests**

Create two projects, enqueue the older job in project A and a newer job in
project B, then assert:

```ts
expect(queue.claim('project_b', 'worker-b')?.projectId).toBe('project_b');
expect(queue.list('project_a')[0].status).toBe('queued');
```

After claiming, advance the clock and assert `renewLease()` moves
`leaseExpiresAt` forward only for the owning worker. Add status assertions for
queued/running/failed counts and oldest queued age.

- [ ] **Step 2: Run queue tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeQueue.test.ts
```

Expected: FAIL due to the old `claim(workerId)` signature.

- [ ] **Step 3: Implement project-scoped claim and lease renewal**

Both statements must include project scope:

```sql
SELECT * FROM knowledge_jobs
WHERE project_id = @projectId AND status = 'queued'
ORDER BY requested_at, id
LIMIT 1
```

```sql
UPDATE knowledge_jobs
SET status = 'running', worker_id = @workerId,
    lease_expires_at = @leaseExpiresAt,
    started_at = COALESCE(started_at, @now)
WHERE id = @id AND project_id = @projectId AND status = 'queued'
```

`renewLease()` must require `status='running'` and matching `worker_id`.

- [ ] **Step 4: Update CLI and MCP queue callers**

Change `knowledge queue claim <project-id>` to pass the positional project ID.
Update MCP tests so no tool can claim or mutate a job from another project.

- [ ] **Step 5: Run targeted core, CLI, and MCP tests**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeQueue.test.ts
pnpm --filter @ariadne-dev/cli test -- knowledgeCommands.test.ts
pnpm --filter @ariadne-dev/mcp-server test -- knowledgeTools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/knowledge/KnowledgeQueue.ts \
  packages/core/test/knowledge/KnowledgeQueue.test.ts \
  packages/cli/src/knowledgeCommands.ts \
  packages/cli/test/knowledgeCommands.test.ts \
  packages/mcp-server/src/knowledgeTools.ts \
  packages/mcp-server/test/knowledgeTools.test.ts
git commit -m "fix(knowledge): scope queue leases to projects"
```

---

### Task 3: Load and verify immutable source versions

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeSourceVersionLoader.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/knowledge/KnowledgeSourceVersionLoader.test.ts`

**Interfaces:**
- Consumes: `KnowledgeSourceVersionRecord`
- Produces:

```ts
export interface LoadedKnowledgeSourceVersion {
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceKind: KnowledgeSourceKind;
  sourcePath: string | null;
  contentPath: string;
  contentHash: string;
  mimeType: string | null;
  byteLength: number;
  content: string;
}

export class KnowledgeSourceVersionLoadError extends Error {
  readonly code:
    | 'source_version_missing'
    | 'source_content_missing'
    | 'source_hash_mismatch'
    | 'source_path_rejected'
    | 'source_too_large'
    | 'unsupported_source';
}

export function loadKnowledgeSourceVersion(
  db: Database.Database,
  input: { projectId: string; sourceVersionId: string; maxBytes?: number },
): LoadedKnowledgeSourceVersion;
```

- [ ] **Step 1: Write failing loader security and immutability tests**

Use a temporary workspace and register version 1, then mutate the original
source file. Assert the loader returns version 1 content from its registered
content path. Also cover:

- missing version;
- missing stored content;
- hash mismatch;
- path traversal;
- symlink component;
- byte limit;
- invalid UTF-8/binary input.

- [ ] **Step 2: Run the loader test and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeSourceVersionLoader.test.ts
```

Expected: FAIL because the loader does not exist.

- [ ] **Step 3: Implement confined loading**

Reuse `KnowledgePathSecurity` helpers and `realpathSync`. Hash with SHA-256.
The approved root is the registered project workspace plus the Ariadne source
storage location already used by `KnowledgeSourceStore`; do not accept an
arbitrary job payload path.

- [ ] **Step 4: Run loader and existing source-store security tests**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeSourceVersionLoader.test.ts KnowledgeSourceStore.test.ts SourcePolicy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/knowledge/KnowledgeSourceVersionLoader.ts \
  packages/core/src/index.ts \
  packages/core/test/knowledge/KnowledgeSourceVersionLoader.test.ts
git commit -m "feat(knowledge): load immutable source versions"
```

---

### Task 4: Add deterministic text and Markdown analyzers

**Files:**
- Create: `packages/core/src/knowledge/analyzers/AnalyzerRegistry.ts`
- Create: `packages/core/src/knowledge/analyzers/TextAnalyzer.ts`
- Create: `packages/core/src/knowledge/analyzers/MarkdownAnalyzer.ts`
- Create: `packages/core/src/knowledge/analyzers/index.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/knowledge/analyzers/TextAnalyzer.test.ts`
- Create: `packages/core/test/knowledge/analyzers/MarkdownAnalyzer.test.ts`
- Create: `packages/core/test/knowledge/fixtures/markdown/architecture.md`

**Interfaces:**
- Produces:

```ts
export interface DeterministicAnalyzer {
  readonly id: string;
  readonly version: string;
  supports(input: AnalyzerSelectionInput): boolean;
  analyze(input: AnalyzerInput): Promise<DeterministicExtraction>;
}

export class AnalyzerRegistry {
  register(analyzer: DeterministicAnalyzer): void;
  require(input: AnalyzerSelectionInput): DeterministicAnalyzer;
}

export function createDefaultAnalyzerRegistry(): AnalyzerRegistry;
```

- [ ] **Step 1: Write failing text analyzer tests**

Assert bounded sections, normalized newlines, exact offsets/line positions,
stable IDs, and a deterministic excerpt summary:

```ts
expect(result.sections[0]).toMatchObject({
  kind: 'paragraph',
  text: 'First paragraph.',
  span: { startLine: 1, startColumn: 1 },
});
```

- [ ] **Step 2: Write failing Markdown analyzer tests**

Fixture coverage:

- nested headings;
- paragraphs;
- fenced code blocks;
- Markdown links;
- wikilinks;
- duplicate heading names with stable unique IDs;
- exact spans.

Expected relationships include `contains` for heading hierarchy and `links_to`
for links.

- [ ] **Step 3: Run analyzer tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- TextAnalyzer.test.ts MarkdownAnalyzer.test.ts
```

Expected: FAIL because analyzers do not exist.

- [ ] **Step 4: Implement analyzers without provider calls**

Use deterministic parsing only. Cap a plain-text section at 2,000 characters
or 80 lines, whichever comes first. Summaries are the first non-empty bounded
section, truncated to 280 characters with no invented text.

- [ ] **Step 5: Run analyzer tests**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- TextAnalyzer.test.ts MarkdownAnalyzer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/knowledge/analyzers \
  packages/core/src/index.ts \
  packages/core/test/knowledge/analyzers \
  packages/core/test/knowledge/fixtures/markdown
git commit -m "feat(knowledge): analyze text and markdown offline"
```

---

### Task 5: Add deterministic Python and TypeScript/JavaScript analyzers

**Files:**
- Modify: `packages/core/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/core/src/knowledge/analyzers/PythonAnalyzer.ts`
- Create: `packages/core/src/knowledge/analyzers/JavaScriptAnalyzer.ts`
- Modify: `packages/core/src/knowledge/analyzers/index.ts`
- Create: `packages/core/test/knowledge/analyzers/PythonAnalyzer.test.ts`
- Create: `packages/core/test/knowledge/analyzers/JavaScriptAnalyzer.test.ts`
- Create: `packages/core/test/knowledge/fixtures/python/jcnr_device_sample.py`
- Create: `packages/core/test/knowledge/fixtures/typescript/service.ts`

**Interfaces:**
- Consumes: `DeterministicAnalyzer`, `DeterministicExtraction`
- Produces:
  - `PythonAnalyzer`
  - `JavaScriptAnalyzer`

- [ ] **Step 1: Add parser dependencies**

Add runtime dependencies:

```json
"@lezer/common": "^1.2.3",
"@lezer/javascript": "^1.5.1",
"@lezer/python": "^1.1.18"
```

Run:

```bash
pnpm install
```

Expected: lockfile updates successfully.

- [ ] **Step 2: Write failing Python analyzer tests**

The fixture must include imports, a class, inheritance, methods, decorators,
docstrings, annotations, a call, a reference, and constants. Assert:

```ts
expect(symbols).toContainEqual(expect.objectContaining({
  kind: 'class',
  name: 'JCNRDevice',
  qualifiedName: 'jcnr_device.JCNRDevice',
}));
expect(relationships).toContainEqual(expect.objectContaining({
  type: 'calls',
  sourceSymbolId: methodId,
  targetReference: 'JCNRFabricInterface',
}));
```

Assert every parser-confirmed record has confidence `1` and a valid span.

- [ ] **Step 3: Write failing JavaScript/TypeScript analyzer tests**

Cover ES imports/exports, interfaces, classes, `implements`, methods,
functions, calls, and references. Parse `.ts` and `.tsx` with TypeScript/JSX
dialects.

- [ ] **Step 4: Run code analyzer tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- PythonAnalyzer.test.ts JavaScriptAnalyzer.test.ts
```

Expected: FAIL because analyzers are not implemented.

- [ ] **Step 5: Implement Lezer tree walkers**

Keep each analyzer below approximately 400 lines by extracting shared cursor
helpers into:

`packages/core/src/knowledge/analyzers/LezerHelpers.ts`

Required helpers:

```ts
export function nodeText(content: string, node: SyntaxNode): string;
export function nodeSpan(content: string, node: SyntaxNode): KnowledgeSourceSpan;
export function stableSymbolId(sourceVersionId: string, kind: string, qualifiedName: string, span: KnowledgeSourceSpan): string;
```

When a reference target cannot be resolved within the file, set
`targetReference` and leave `targetSymbolId` null. Do not invent cross-file
resolution.

- [ ] **Step 6: Run code analyzer and existing ingestor tests**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- PythonAnalyzer.test.ts JavaScriptAnalyzer.test.ts Ingestors.test.ts
pnpm --filter @ariadne-dev/core build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml \
  packages/core/src/knowledge/analyzers \
  packages/core/test/knowledge/analyzers \
  packages/core/test/knowledge/fixtures/python \
  packages/core/test/knowledge/fixtures/typescript
git commit -m "feat(knowledge): extract code structure offline"
```

---

### Task 6: Materialize typed graph data and preserve Graphify semantics

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeGraphMaterializer.ts`
- Modify: `packages/core/src/knowledge/graph/KnowledgeGraph.ts`
- Modify: `packages/core/src/knowledge/GraphifyImport.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/knowledge/KnowledgeGraphMaterializer.test.ts`
- Modify: `packages/core/test/knowledge/GraphifyImport.test.ts`
- Modify: `packages/core/test/knowledge/graph/KnowledgeGraph.test.ts`

**Interfaces:**
- Consumes: `DeterministicExtraction`, `KnowledgeExtractionRecord`
- Produces:

```ts
export interface KnowledgeGraphMaterializationResult {
  nodeIds: string[];
  edgeIds: string[];
  unresolvedRelationships: number;
}

export class KnowledgeGraphMaterializer {
  materialize(input: {
    projectId: string;
    sourceId: string;
    sourceVersionId: string;
    extraction: DeterministicExtraction;
  }): KnowledgeGraphMaterializationResult;
}
```

- [ ] **Step 1: Write failing stable-node and provenance tests**

Assert:

- repeated materialization does not duplicate nodes or edges;
- node identity is stable across process runs;
- `calls`, `imports`, `inherits`, and `contains` remain distinct edge types;
- edge provenance includes source ID, path, start line, end line, confidence;
- unresolved external references do not produce fake endpoint nodes unless they
  are explicitly represented as `external_reference` nodes.

- [ ] **Step 2: Write failing Graphify preservation tests**

Use Graphify-shaped input containing `relation`, `source_file`,
`source_location`, `context`, and inferred status. Assert imported edges retain
the relation as `edgeType` and convert source location to provenance where
possible.

- [ ] **Step 3: Run graph tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeGraphMaterializer.test.ts GraphifyImport.test.ts KnowledgeGraph.test.ts
```

Expected: FAIL because materialization does not exist and Graphify metadata is
not mapped into native provenance.

- [ ] **Step 4: Implement graph materialization**

Derive stable IDs with `createKnowledgeId('graph-node', seed)`, where seed is:

```text
projectId:sourceVersionId:symbolKind:qualifiedName:startOffset:endOffset
```

Use evidence `explicit_link` for parser-confirmed edges and
`semantic_relationship` for inferred/provider edges. Store source line
provenance in the existing edge evidence JSON.

- [ ] **Step 5: Improve Graphify import**

Resolve relation type in this order:

```ts
value.edgeType ?? value.relation ?? value.type ?? value.label ?? 'related_to'
```

Map `source_location` values such as `L216` and `L216-L227` into
`KnowledgeProvenanceRef`. Preserve unknown original metadata in import results
for diagnostics.

- [ ] **Step 6: Run graph tests**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeGraphMaterializer.test.ts GraphifyImport.test.ts KnowledgeGraph.test.ts KnowledgeGraphTraversal.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/knowledge/KnowledgeGraphMaterializer.ts \
  packages/core/src/knowledge/graph/KnowledgeGraph.ts \
  packages/core/src/knowledge/GraphifyImport.ts \
  packages/core/src/index.ts \
  packages/core/test/knowledge/KnowledgeGraphMaterializer.test.ts \
  packages/core/test/knowledge/GraphifyImport.test.ts \
  packages/core/test/knowledge/graph/KnowledgeGraph.test.ts
git commit -m "feat(knowledge): materialize typed source graph"
```

---

### Task 7: Generate deterministic pages and content-backed search

**Files:**
- Create: `packages/core/src/knowledge/DeterministicPageBuilder.ts`
- Modify: `packages/core/src/knowledge/KnowledgeGeneratorService.ts`
- Modify: `packages/core/src/knowledge/KnowledgeSearch.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/knowledge/DeterministicPageBuilder.test.ts`
- Modify: `packages/core/test/knowledge/KnowledgeGeneratorService.test.ts`
- Modify: `packages/core/test/knowledge/KnowledgeSearch.test.ts`

**Interfaces:**
- Consumes: `DeterministicExtraction`, `KnowledgeGenerationPayload`
- Produces:

```ts
export interface DeterministicPageBuildInput {
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  sourcePath: string | null;
  extraction: DeterministicExtraction;
}

export function buildDeterministicPagePayload(
  input: DeterministicPageBuildInput,
): KnowledgeGenerationPayload;
```

- [ ] **Step 1: Write failing deterministic page tests**

Assert the generated source page includes:

- source path and analyzer version;
- summary excerpt;
- headings/sections;
- symbol table;
- typed outgoing relationships;
- diagnostics;
- path and line citations;
- stable slug and page ID input;
- no new version when rendered content is unchanged.

- [ ] **Step 2: Write failing content-search tests**

Persist an extraction containing `allocate_index_for_sg` and assert:

```ts
const results = searchKnowledge('allocate security group index', {
  db,
  projectId: PROJECT_ID,
  mode: 'hybrid',
});
expect(results[0]).toMatchObject({
  kind: 'source',
  snippet: expect.stringContaining('allocate_index_for_sg'),
});
expect(results[0].citations[0].span).toMatchObject({
  startOffset: expect.any(Number),
  endOffset: expect.any(Number),
});
```

Also assert path-only metadata ranks below a matching section or symbol.
Extend `KnowledgeSearchCitation.span` to return `startLine`, `startColumn`,
`endLine`, and `endColumn` alongside offsets.

- [ ] **Step 3: Run page/search tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- DeterministicPageBuilder.test.ts KnowledgeGeneratorService.test.ts KnowledgeSearch.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement deterministic page payload construction**

Render Markdown from normalized facts only. Use source provenance:

```ts
provenance: [{
  kind: 'source',
  id: input.sourceId,
  path: input.sourcePath ?? undefined,
  startLine: 1,
  endLine: extractionLastLine,
  confidence: 1,
}]
```

Set `generatorVersion` to
`deterministic:<analyzerId>:<analyzerVersion>`.

- [ ] **Step 5: Avoid duplicate unchanged page versions**

Before creating a new version, compare rendered content hash with the current
page version. Reuse the current version when hashes match. Add this behavior to
`KnowledgeGeneratorService` without changing atomic file rollback semantics.

- [ ] **Step 6: Index extraction sections and symbols**

Extend source search rows with extraction JSON. Build bounded snippets around
matched section/symbol text and attach their persisted spans. Weight fields:

```text
symbol qualified name: 10
symbol name: 8
section title: 7
section text: 5
page title: 6
page summary: 3
source path: 2
```

- [ ] **Step 7: Run page/search tests**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- DeterministicPageBuilder.test.ts KnowledgeGeneratorService.test.ts KnowledgeSearch.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/knowledge/DeterministicPageBuilder.ts \
  packages/core/src/knowledge/KnowledgeGeneratorService.ts \
  packages/core/src/knowledge/KnowledgeSearch.ts \
  packages/core/src/index.ts \
  packages/core/test/knowledge/DeterministicPageBuilder.test.ts \
  packages/core/test/knowledge/KnowledgeGeneratorService.test.ts \
  packages/core/test/knowledge/KnowledgeSearch.test.ts
git commit -m "feat(knowledge): generate cited offline pages"
```

---

### Task 8: Implement the reusable KnowledgeWorker

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeWorker.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/knowledge/KnowledgeWorker.test.ts`

**Interfaces:**
- Consumes all interfaces from Tasks 1–7.
- Produces:

```ts
export interface KnowledgeWorkerOptions {
  workerId: string;
  leaseRenewIntervalMs?: number;
  maxSourceBytes?: number;
  now?: () => string;
  signal?: AbortSignal;
  enrich?: KnowledgeEnrichmentService;
}

export interface KnowledgeWorkerRunResult {
  projectId: string;
  claimed: number;
  completed: number;
  failed: number;
  cancelled: number;
  warnings: KnowledgeWorkerWarning[];
}

export class KnowledgeWorker {
  runOnce(projectId: string): Promise<KnowledgeWorkerRunResult>;
  runWatch(projectId: string, options?: { pollMs?: number }): Promise<void>;
  processJob(jobId: string): Promise<KnowledgeJobRecord>;
}
```

- [ ] **Step 1: Write failing happy-path worker integration test**

Register a Python source, enqueue `analyze`, call `runOnce`, then assert:

- job completed;
- extraction persisted;
- typed graph nodes/edges exist;
- deterministic source page exists;
- search returns content and a span;
- progress stages equal:

```ts
['loading', 'analyzing', 'persisting', 'graph', 'generating', 'completed']
```

- [ ] **Step 2: Write failing error/cancellation/idempotency tests**

Cover:

- unsupported job kind → `unsupported_source`;
- source hash mismatch → permanent failure;
- parser diagnostic fallback → completed with warning;
- cancellation between stages → cancelled;
- lease renewal failure → stop before further writes;
- rerun unchanged version → no duplicate extraction/page/graph;
- provider enrichment rejection → completed deterministic job with warning;
- provider contradictions/research gaps create bounded pending reviews or
  insights once, and an idempotent rerun does not duplicate them;
- two projects → no cross-project processing.

- [ ] **Step 3: Run worker tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeWorker.test.ts
```

Expected: FAIL because the worker does not exist.

- [ ] **Step 4: Implement staged orchestration**

The `analyze` handler executes:

```ts
const loaded = sourceLoader.load(...);
const analyzer = analyzers.require(...);
const extraction = await analyzer.analyze(...);
const saved = extractionStore.save(...);
graphMaterializer.materialize(...);
const payload = buildDeterministicPagePayload(...);
await generator.runKnowledgeGeneration(job.id, payload);
await enrichment.enrich(...); // optional, warning-only after baseline success
queue.complete(job.id, workerId, result);
```

If `KnowledgeGeneratorService` currently reads payload only from the job row,
add a narrowly scoped `replaceRunningJobPayload(jobId, workerId, payload)`
queue method or a generator overload. Do not mutate queued jobs owned by
another worker.

- [ ] **Step 5: Add lease timer and cancellation checks**

Renew at `min(leaseDuration / 3, leaseRenewIntervalMs)`. Clear the timer in a
`finally` block. Check `signal.aborted` and current queue status before every
durable stage.

- [ ] **Step 6: Map errors to stable failure codes**

Implement one exhaustive mapper:

```ts
export function knowledgeWorkerFailure(error: unknown): {
  code: KnowledgeWorkerFailureCode;
  message: string;
  retryable: boolean;
};
```

Redact the message before queue persistence.

- [ ] **Step 7: Run worker and related integration tests**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeWorker.test.ts KnowledgeQueue.test.ts KnowledgeGeneratorService.test.ts KnowledgeSearch.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/knowledge/KnowledgeWorker.ts \
  packages/core/src/index.ts \
  packages/core/test/knowledge/KnowledgeWorker.test.ts \
  packages/core/src/knowledge/KnowledgeQueue.ts \
  packages/core/src/knowledge/KnowledgeGeneratorService.ts
git commit -m "feat(knowledge): process analysis jobs offline"
```

---

### Task 9: Add optional provider profiles and OpenAI-compatible enrichment

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeProviderProfiles.ts`
- Create: `packages/core/src/knowledge/providers/OpenAICompatibleProvider.ts`
- Modify: `packages/core/src/knowledge/KnowledgeAnalysis.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/knowledge/KnowledgeProviderProfiles.test.ts`
- Create: `packages/core/test/knowledge/OpenAICompatibleProvider.test.ts`
- Modify: `packages/core/test/knowledge/KnowledgeAnalysis.test.ts`

**Interfaces:**
- Produces:

```ts
export interface KnowledgeProviderProfile {
  id: string;
  projectId: string;
  providerKind: 'openai-compatible';
  profileName: string;
  endpoint: string;
  model: string;
  capabilities: KnowledgeProviderCapability[];
  timeoutMs: number;
  apiKeyEnv: string | null;
  enabled: boolean;
}

export interface KnowledgeEnrichmentService {
  enrich(input: KnowledgeEnrichmentInput): Promise<KnowledgeEnrichmentResult>;
}

export class KnowledgeProviderProfileStore {
  create(input: CreateKnowledgeProviderProfileInput): KnowledgeProviderProfile;
  list(projectId: string): KnowledgeProviderProfile[];
  get(projectId: string, profileName: string): KnowledgeProviderProfile | null;
  setEnabled(projectId: string, profileName: string, enabled: boolean): KnowledgeProviderProfile;
  remove(projectId: string, profileName: string): boolean;
  test(projectId: string, profileName: string, environment: NodeJS.ProcessEnv): Promise<KnowledgeProviderTestResult>;
}
```

- [ ] **Step 1: Write failing profile validation/redaction tests**

Assert:

- only HTTP(S) endpoints are accepted;
- profile names are project-unique;
- `apiKeyEnv` stores a variable name, never its value;
- archives omit profile secret configuration;
- listing profiles never reads or returns environment values;
- disabled profiles are not selected.

- [ ] **Step 2: Write failing provider adapter tests**

Use a local `http.createServer` fixture. Verify:

- OpenAI-compatible `/chat/completions` request shape;
- timeout/abort behavior;
- response JSON parsing;
- structured analysis validation;
- ungrounded source IDs/spans are rejected;
- HTTP and response excerpts are redacted;
- missing API-key environment variable produces an explicit provider warning.

- [ ] **Step 3: Run provider tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeProviderProfiles.test.ts OpenAICompatibleProvider.test.ts KnowledgeAnalysis.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement profile store**

Keep `configuration_json` limited to:

```json
{
  "endpoint": "http://127.0.0.1:11434/v1",
  "model": "model-name",
  "capabilities": ["analysis", "generation"],
  "timeoutMs": 60000,
  "apiKeyEnv": "ARIADNE_KNOWLEDGE_API_KEY",
  "enabled": true
}
```

Reject configuration keys outside this schema.

- [ ] **Step 5: Implement optional enrichment**

Build prompts only from bounded deterministic extraction content. Require the
provider response to use the existing analysis/generation JSON contracts.
Validate source IDs and spans against the deterministic extraction before
merging. Return warnings instead of throwing after deterministic completion.

- [ ] **Step 6: Run provider and worker fallback tests**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeProviderProfiles.test.ts OpenAICompatibleProvider.test.ts KnowledgeAnalysis.test.ts KnowledgeWorker.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/knowledge/KnowledgeProviderProfiles.ts \
  packages/core/src/knowledge/providers/OpenAICompatibleProvider.ts \
  packages/core/src/knowledge/KnowledgeAnalysis.ts \
  packages/core/src/index.ts \
  packages/core/test/knowledge/KnowledgeProviderProfiles.test.ts \
  packages/core/test/knowledge/OpenAICompatibleProvider.test.ts \
  packages/core/test/knowledge/KnowledgeAnalysis.test.ts
git commit -m "feat(knowledge): add optional provider enrichment"
```

---

### Task 10: Expose worker and provider management through the CLI

**Files:**
- Modify: `packages/cli/src/knowledgeCommands.ts`
- Modify: `packages/cli/test/knowledgeCommands.test.ts`
- Modify: `.github/skills/ariadne/SKILL.md`
- Modify: `.github/agents/ariadne.agent.md`
- Create: `docs/knowledge-worker.md`

**Interfaces:**
- Consumes: `KnowledgeWorker`, `KnowledgeProviderProfileStore`
- Produces CLI commands:
  - `knowledge worker run <project-id> --once`
  - `knowledge worker run <project-id> --watch`
  - `knowledge worker status <project-id>`
  - `knowledge provider add/list/test/enable/disable/remove`

- [ ] **Step 1: Write failing CLI worker tests**

In a temporary workspace:

1. create project;
2. write and ingest a Python source;
3. run `worker run <id> --once --json`;
4. assert one job completed;
5. search by a symbol/body term;
6. assert a content snippet and span citation;
7. run again and assert `claimed: 0`.

Also assert `--watch` rejects use with `--json` in tests unless a bounded
test-only abort signal is injected.

- [ ] **Step 2: Write failing provider command tests**

Assert:

- add/list stores non-secret metadata;
- `--api-key-env` accepts a name;
- passing a literal `--api-key` is an unknown option;
- test reports missing environment variable without revealing values;
- enable/disable/remove require an existing project/profile.

- [ ] **Step 3: Run CLI tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/cli test -- knowledgeCommands.test.ts
```

Expected: FAIL because commands are absent.

- [ ] **Step 4: Implement CLI worker construction**

Add a helper in `knowledgeCommands.ts`:

```ts
function createCliKnowledgeWorker(
  db: Database.Database,
  projectId: string,
  options: CliWorkerOptions,
): KnowledgeWorker;
```

The helper reads only environment variable names specified by enabled
profiles. `--once` drains eligible jobs and exits. `--watch` handles SIGINT
with an `AbortController`.

- [ ] **Step 5: Implement status and provider commands**

Status output includes counts, active leases, oldest queued age, recent
failure codes, analyzer versions, and deterministic/enriched totals.

- [ ] **Step 6: Update skill, agent, and operator documentation**

Document:

- when to run `worker run --once`;
- offline deterministic guarantees;
- optional provider profile setup;
- environment-only secret handling;
- queue status and retry workflow;
- export/import remains knowledge transfer;
- the corrected project-scoped queue claim behavior.

- [ ] **Step 7: Run CLI tests and help verification**

Run:

```bash
pnpm --filter @ariadne-dev/cli test -- knowledgeCommands.test.ts
pnpm --filter @ariadne-dev/cli build
node packages/cli/dist/index.js knowledge worker --help
node packages/cli/dist/index.js knowledge provider --help
```

Expected: tests/build pass and both help trees list the documented commands.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/knowledgeCommands.ts \
  packages/cli/test/knowledgeCommands.test.ts \
  .github/skills/ariadne/SKILL.md \
  .github/agents/ariadne.agent.md \
  docs/knowledge-worker.md
git commit -m "feat(cli): run offline knowledge workers"
```

---

### Task 11: Wire MCP, VS Code, and dashboard observability

**Files:**
- Modify: `packages/mcp-server/src/knowledgeTools.ts`
- Modify: `packages/mcp-server/test/knowledgeTools.test.ts`
- Modify: `packages/vscode-extension/src/extension.ts`
- Modify: `packages/vscode-extension/package.json`
- Modify: `packages/vscode-extension/test/extension.test.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/guards.ts`
- Modify: `packages/dashboard/src/knowledge/KnowledgeOverviewPage.tsx`
- Modify: `packages/dashboard/src/knowledge/KnowledgePages.test.tsx`
- Modify: `packages/dashboard/e2e/fixtures.ts`
- Modify: `packages/dashboard/e2e/knowledge.spec.ts`

**Interfaces:**
- MCP tools:
  - `knowledge_worker_status`
  - `knowledge_worker_run_once`
- VS Code command:
  - `ariadne.knowledgeWorkerRunOnce`
- Dashboard fields:

```ts
export interface KnowledgeWorkerSummary {
  queued: number;
  running: number;
  failed: number;
  oldestQueuedAt: string | null;
  activeWorkerCount: number;
  deterministicCompleted: number;
  enrichedCompleted: number;
}
```

- [ ] **Step 1: Write failing MCP tests**

Assert:

- status is read-only and bounded;
- run-once requires `confirm=true`;
- run-once processes only the requested project;
- MCP cannot start unbounded watch mode;
- errors are returned as sanitized tool errors.

- [ ] **Step 2: Write failing VS Code command tests**

Register `ariadne.knowledgeWorkerRunOnce`. Assert it opens the selected
workspace database, selects an active project, runs once, refreshes the panel,
and shows completed/failed counts. Preserve the existing informational commands
until their panels consume real status.

- [ ] **Step 3: Write failing dashboard tests**

Extend project responses with worker summary and assert the overview shows:

- queued jobs;
- running jobs;
- failed jobs;
- oldest queue age;
- active worker count;
- deterministic/enriched completion counts.

Verify admin-only route behavior remains unchanged and member task access is
unaffected.

- [ ] **Step 4: Run adapter tests and verify failure**

Run:

```bash
pnpm --filter @ariadne-dev/mcp-server test -- knowledgeTools.test.ts
pnpm --filter ariadne-vscode test -- extension.test.ts
pnpm --filter @ariadne-dev/dashboard test -- KnowledgePages.test.tsx
```

Expected: FAIL.

- [ ] **Step 5: Implement bounded adapter surfaces**

MCP and VS Code construct the same core worker as CLI. Dashboard remains an
observability surface; do not add provider secret entry fields.

If the production admin API is not implemented in this branch, keep dashboard
changes fixture/type compatible and document the required server response
shape rather than inventing a client-side worker.

- [ ] **Step 6: Run adapter tests and dashboard E2E**

Run:

```bash
pnpm --filter @ariadne-dev/mcp-server test -- knowledgeTools.test.ts
pnpm --filter ariadne-vscode test -- extension.test.ts
pnpm --filter @ariadne-dev/dashboard test -- KnowledgePages.test.tsx
pnpm --filter @ariadne-dev/dashboard test:e2e -- knowledge.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/src/knowledgeTools.ts \
  packages/mcp-server/test/knowledgeTools.test.ts \
  packages/vscode-extension/src/extension.ts \
  packages/vscode-extension/package.json \
  packages/vscode-extension/test/extension.test.ts \
  packages/dashboard/src/api/types.ts \
  packages/dashboard/src/api/guards.ts \
  packages/dashboard/src/knowledge/KnowledgeOverviewPage.tsx \
  packages/dashboard/src/knowledge/KnowledgePages.test.tsx \
  packages/dashboard/e2e/fixtures.ts \
  packages/dashboard/e2e/knowledge.spec.ts
git commit -m "feat(knowledge): expose worker health"
```

---

### Task 12: Add repeatable accuracy scoring and rerun NAAS acceptance

**Files:**
- Create: `packages/core/test/knowledge/KnowledgeWorker.naas.test.ts`
- Create: `packages/core/test/knowledge/fixtures/naas/questions.json`
- Create: `packages/core/test/knowledge/fixtures/naas/task-managers/`
- Modify: `docs/knowledge-worker.md`
- Modify: `docs/superpowers/specs/2026-09-24-offline-knowledge-worker-design.md` only if implementation reveals a necessary clarified invariant

**Interfaces:**
- Produces:

```ts
export interface KnowledgeAccuracyQuestion {
  id: string;
  query: string;
  expectedPaths: string[];
  expectedSymbols: string[];
}

export interface KnowledgeAccuracyReport {
  questionCount: number;
  top1PathHits: number;
  top3PathHits: number;
  spanCitationHits: number;
  typedGraphEvidenceHits: number;
}
```

- [ ] **Step 1: Create redistributable NAAS-shaped fixtures**

Do not copy proprietary full source files into Ariadne. Build small synthetic
fixtures that preserve the tested structures:

- `JCNRDevice.add_fabric_interface`
- gNMI flags and endpoint helper
- `JCNRTopology.construct_topology`
- HBR credentials and SSH jump host
- configlet cleanup/retry
- deployment uninstall/install verification
- use-case loader failure teardown
- pytest bootstrap defaults

The fixtures must be original minimal test code, not copied source.

- [ ] **Step 2: Write the failing accuracy test**

For ten questions, ingest fixtures, run the worker, search, and calculate:

```ts
expect(report.questionCount).toBe(10);
expect(report.top3PathHits).toBeGreaterThanOrEqual(8);
expect(report.spanCitationHits).toBe(10);
expect(report.typedGraphEvidenceHits).toBeGreaterThanOrEqual(8);
```

Also assert every queued supported job becomes completed or explicitly failed;
none remain queued/running.

- [ ] **Step 3: Run the synthetic accuracy test**

Run:

```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeWorker.naas.test.ts
```

Expected before final tuning: FAIL with measured misses, not infrastructure
errors.

- [ ] **Step 4: Tune deterministic ranking using fixture evidence**

Only adjust documented weights or tokenization. Do not add question-specific
keywords or path exceptions. Re-run until the general scoring thresholds pass.

- [ ] **Step 5: Run the real NAAS workspace acceptance**

From `/home/lkumar/atom`:

```bash
node /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/cli/dist/index.js \
  knowledge worker run project_01M3BMBTNR7N4MSWSTEAJHYFK3 --once --json
```

Then verify:

```bash
node /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/cli/dist/index.js \
  knowledge queue list project_01M3BMBTNR7N4MSWSTEAJHYFK3 --json
```

Expected:

- all 58 original jobs leave `queued`;
- supported sources complete;
- unsupported sources fail explicitly with stable codes;
- search snippets contain source content;
- citations contain spans;
- graph edges retain typed relationships/provenance;
- deterministic pages appear in page list;
- export checksums validate.

Re-run the ten questions recorded in Ariadne task
`01M3BMBFP26N22P91M017FSQ6R` and record the top-one/top-three outcomes.

- [ ] **Step 6: Run targeted and full validation**

Run:

```bash
pnpm --filter @ariadne-dev/core test
pnpm --filter @ariadne-dev/cli test
pnpm --filter @ariadne-dev/mcp-server test
pnpm --filter ariadne-vscode test
pnpm --filter @ariadne-dev/dashboard test
pnpm build
pnpm test
```

Expected: all commands pass.

- [ ] **Step 7: Update Ariadne task memory**

From `/home/lkumar/atom`, record:

```bash
ariadne decision "Use deterministic extraction as the authoritative knowledge baseline" \
  -r "The worker now drains queues without providers and optional enrichment cannot replace grounded source facts."
ariadne todo done 01M3BMJH2CD9RZVRR9A9KVHYC3
ariadne checkpoint "<real acceptance counts and accuracy metrics>" -l milestone
```

Resolve the earlier queue-worker error only after the real 58-job project is
successfully drained.

- [ ] **Step 8: Commit**

```bash
git add packages/core/test/knowledge/KnowledgeWorker.naas.test.ts \
  packages/core/test/knowledge/fixtures/naas \
  docs/knowledge-worker.md
git commit -m "test(knowledge): verify offline worker accuracy"
```

---

## Final Review Gate

- [ ] Review the complete branch diff against
  `docs/superpowers/specs/2026-09-24-offline-knowledge-worker-design.md`.
- [ ] Run a TypeScript-focused code review for async correctness, validation,
  error propagation, redaction, and package boundaries.
- [ ] Run a security review because the feature handles workspace files,
  provider endpoints, environment-based credentials, and external responses.
- [ ] Run a silent-failure review for provider fallbacks, parser diagnostics,
  lease renewal, cancellation, and page-generation rollback.
- [ ] Confirm no secrets, provider responses, full source content, or private
  paths appear in logs, progress events, tests, docs, or exports.
- [ ] Confirm the feature worktree is clean and all commits remain on
  `feat/ariadne-knowledge-wiki-plan`.
