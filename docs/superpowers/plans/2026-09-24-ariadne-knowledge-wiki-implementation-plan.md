# Ariadne Knowledge Wiki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first, source-grounded knowledge-wiki capability in Ariadne with hybrid SQLite + generated workspace storage, complete CLI/MCP/core coverage first, and UI adapters afterward.

**Architecture:** SQLite remains authoritative for structured knowledge state, provenance, jobs, reviews, graph metadata, and conversations. A generated `.ariadne/knowledge/` workspace provides Markdown/JSON/media exports and interoperability. The implementation is split into independently testable sub-projects: foundations, ingestion, generation, retrieval/graph, operations/research/chat, and adapters.

**Tech Stack:** TypeScript 5.5, Node.js 20+, pnpm workspace, better-sqlite3, SQLite migrations/WAL, Vitest, React 19, Vite, VS Code extension APIs, Express/Postgres sync conventions, MCP SDK, existing Ariadne core/CLI/MCP/VS Code/dashboard packages.

**Spec:** `docs/superpowers/plans/2026-09-24-ariadne-knowledge-wiki-plan.md`

## Global Constraints

- Preserve Ariadne's invariant: one shared core implementation with thin CLI, MCP, VS Code, and dashboard adapters.
- Keep SQLite authoritative for structured knowledge metadata; generated Markdown/JSON is an export and interoperability layer.
- Preserve all existing task, context, search, Graphify passthrough, MCP, CLI, and VS Code behavior.
- Keep deterministic capture, search, export, and task context usable without any LLM provider or network access.
- Redact secrets before persistence, indexing, provider calls, logs, or export.
- Treat imported documents, web pages, generated content, and skill instructions as untrusted input.
- Do not copy GPLv3 source code from `nashsu/llm_wiki`; reimplement compatible behavior independently.
- Add additive SQLite migrations and migration tests; never rewrite existing task records.
- Use content hashes and atomic versioning so failed generation cannot destroy the last known-good knowledge build.
- Every generated claim or inferred graph edge must carry provenance and confidence.
- Use existing package patterns, test setup, and changesets for published package changes.
- New core functionality targets 80%+ coverage; security, migrations, queue transitions, and archive validation require focused edge-case coverage.
- Do not add a graph database, vector database, daemon, or desktop runtime until measurements demonstrate that SQLite/core contracts are insufficient.

---

## Execution map

The plan is intentionally decomposed. Each sub-project produces a working,
reviewable increment:

1. **Foundations:** IDs, schema, project configuration, manifests, provenance.
2. **Sources:** source registry, policies, deterministic parsers, file watching.
3. **Generation:** queue, analysis/generation contracts, page versions, reviews.
4. **Retrieval:** search, native graph, communities, insights, optional embeddings.
5. **Operations:** deletion, research, chat, skills, generated outputs.
6. **Interfaces:** CLI and MCP contracts.
7. **VS Code:** knowledge panels and commands.
8. **Dashboard/sync/compatibility:** browser UI, optional API, migration/export.

Do not start a later sub-project until its preceding contracts and tests are
merged or explicitly accepted as stable.

---

## Sub-project 1: Knowledge foundations

### Task 1: Define stable knowledge identifiers and shared types

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeTypes.ts`
- Create: `packages/core/src/knowledge/KnowledgeIds.ts`
- Create: `packages/core/test/knowledge/KnowledgeTypes.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces `KnowledgeProjectId`, `KnowledgeSourceId`, `KnowledgePageId`,
  `KnowledgeJobId`, `KnowledgeReviewId`, and `KnowledgeGraphNodeId` branded
  string types.
- Produces `KnowledgePageType`, `KnowledgeSourceKind`, `KnowledgeJobStatus`,
  `KnowledgeReviewStatus`, `KnowledgeEdgeEvidence`, `KnowledgeProvenanceRef`,
  `KnowledgePageRecord`, and `KnowledgeSourceRecord`.
- Produces `createKnowledgeId(prefix: string, seed?: string): string` and
  `normalizeKnowledgePath(value: string): string`.

- [ ] **Step 1: Write failing tests** for deterministic IDs when a seed is
  supplied, random IDs when it is not, path normalization, and rejection of
  empty prefixes.
- [ ] **Step 2: Run the focused Vitest file** and verify it fails because the
  new module is absent.
- [ ] **Step 3: Implement the types and ID/path helpers** using existing Ariadne
  ID and path conventions; do not introduce a second UUID package.
- [ ] **Step 4: Re-run the focused tests** and verify deterministic output.
- [ ] **Step 5: Export the public types from `packages/core/src/index.ts`.**
- [ ] **Step 6: Commit** with `feat(core): define knowledge identifiers and types`.

### Task 2: Add additive knowledge schema migrations

**Files:**
- Create: `packages/core/src/knowledge/knowledgeSchema.ts`
- Create: `packages/core/src/knowledge/knowledgeMigrations.ts`
- Create: `packages/core/test/knowledge/knowledgeMigrations.test.ts`
- Modify: `packages/core/src/migrations.ts`
- Modify: `packages/core/src/schema.ts`

**Interfaces:**
- Produces `KNOWLEDGE_SCHEMA_VERSION`.
- Produces `applyKnowledgeMigrations(db: Database.Database): void`.
- Creates project, source, source-version, page, page-version, provenance,
  link, graph, job, job-event, review, research, conversation, message,
  output, and operation-log tables as described in the approved spec.

- [ ] **Step 1: Add migration tests** that open a fresh database, apply all
  migrations, assert every required table/index exists, and reopen the same
  database without errors.
- [ ] **Step 2: Add a regression test** proving existing task tables and
  `schema_meta` values are unchanged after knowledge migrations.
- [ ] **Step 3: Implement the migration in one transaction** with foreign keys,
  project/workspace scoping, timestamps, stable IDs, and indexes for source
  hashes, page types, job status, review status, and graph endpoints.
- [ ] **Step 4: Add migration registration** using the existing migration
  mechanism rather than a parallel database initializer.
- [ ] **Step 5: Run `pnpm --filter @ariadne-dev/core exec vitest run`** for
  migration and existing schema tests.
- [ ] **Step 6: Commit** with `feat(core): add knowledge schema migrations`.

### Task 3: Implement project configuration and manifests

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeProjectStore.ts`
- Create: `packages/core/src/knowledge/KnowledgeManifest.ts`
- Create: `packages/core/test/knowledge/KnowledgeProjectStore.test.ts`
- Create: `packages/core/test/knowledge/KnowledgeManifest.test.ts`

**Interfaces:**
- Produces `KnowledgeProjectStore.create`, `.get`, `.update`, `.archive`,
  `.list`.
- Produces `buildKnowledgeManifest(projectId): KnowledgeManifest`.
- Produces `writeKnowledgeManifest(root, manifest): void` and
  `readKnowledgeManifest(root): KnowledgeManifest`.

- [ ] **Step 1: Test project creation, update, archive, root association, and
  missing-project errors.**
- [ ] **Step 2: Test manifest round-tripping and rejection of mismatched
  project IDs or unsupported manifest versions.**
- [ ] **Step 3: Implement store methods using prepared SQL statements and
  existing workspace-root normalization.**
- [ ] **Step 4: Implement atomic manifest writes through a temporary file in
  the configured `.ariadne/knowledge/` directory.**
- [ ] **Step 5: Run focused tests and the complete core test suite.**
- [ ] **Step 6: Commit** with `feat(core): add knowledge project configuration`.

### Task 4: Implement provenance and operation logging

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeProvenance.ts`
- Create: `packages/core/src/knowledge/KnowledgeOperationLog.ts`
- Create: `packages/core/test/knowledge/KnowledgeProvenance.test.ts`
- Create: `packages/core/test/knowledge/KnowledgeOperationLog.test.ts`

**Interfaces:**
- Produces `recordKnowledgeProvenance(ref): void`,
  `listKnowledgeProvenance(targetId): KnowledgeProvenanceRef[]`.
- Produces `appendKnowledgeOperation(event): KnowledgeOperationEvent`,
  `listKnowledgeOperations(projectId, options)`.

- [ ] **Step 1: Test links to task, checkpoint, decision, file, commit, source,
  and page records.**
- [ ] **Step 2: Test operation entries never persist provider secrets and
  preserve success/failure/cancelled status.**
- [ ] **Step 3: Implement typed provenance rows with unique constraints and
  operation log append semantics.**
- [ ] **Step 4: Run focused and migration tests.**
- [ ] **Step 5: Commit** with `feat(core): add knowledge provenance logging`.

---

## Sub-project 2: Source ingestion

### Task 5: Add source registry, hashes, policy, and deterministic ingest

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeSourceStore.ts`
- Create: `packages/core/src/knowledge/SourcePolicy.ts`
- Create: `packages/core/src/knowledge/SourceIdentity.ts`
- Create: `packages/core/test/knowledge/KnowledgeSourceStore.test.ts`
- Create: `packages/core/test/knowledge/SourcePolicy.test.ts`

**Interfaces:**
- Produces `registerKnowledgeSource(input): KnowledgeSourceRecord`.
- Produces `computeSourceVersion(content): { hash: string; size: number }`.
- Produces `shouldIngestSource(path, policy): SourceDecision`.
- Produces source list, version list, deletion marking, and hash-based no-op
  detection.

- [ ] **Step 1: Test unchanged content returns `skip`, changed content creates
  a new source version, and deleted sources become stale rather than vanishing.**
- [ ] **Step 2: Test ignored paths, suspected secrets, oversized files,
  outside-root paths, binary policy, and `.ariadneignore` behavior.**
- [ ] **Step 3: Implement SHA-256 identity, normalized relative paths, and
  policy decisions using `Redactor`/existing ignore helpers where applicable.**
- [ ] **Step 4: Implement source/version persistence and explicit rejection
  reasons without reading rejected content into the database.**
- [ ] **Step 5: Run focused tests and existing redaction/file-capture tests.**
- [ ] **Step 6: Commit** with `feat(core): add knowledge source registry`.

### Task 6: Implement deterministic format adapters

**Files:**
- Create: `packages/core/src/knowledge/formats/PlainTextIngestor.ts`
- Create: `packages/core/src/knowledge/formats/MarkdownIngestor.ts`
- Create: `packages/core/src/knowledge/formats/CodeIngestor.ts`
- Create: `packages/core/src/knowledge/formats/TaskHistoryIngestor.ts`
- Create: `packages/core/src/knowledge/formats/IngestTypes.ts`
- Create: `packages/core/test/knowledge/formats/Ingestors.test.ts`

**Interfaces:**
- Produces `KnowledgeIngestor.supports(input): boolean`.
- Produces `KnowledgeIngestor.extract(input): Promise<ExtractedSource>`.
- Produces `ExtractedSource` with normalized text, metadata, source spans,
  headings, links, and provenance references.

- [ ] **Step 1: Write fixtures and failing tests** for Markdown headings/links,
  code symbols/paths, plain text, and Ariadne task entity extraction.
- [ ] **Step 2: Implement format dispatch and deterministic extraction** without
  LLM calls.
- [ ] **Step 3: Preserve source offsets and relative paths in every extracted
  span so citations can point back to evidence.**
- [ ] **Step 4: Add tests for Unicode, empty files, malformed Markdown, and
  path traversal attempts.**
- [ ] **Step 5: Run focused format tests.**
- [ ] **Step 6: Commit** with `feat(core): add deterministic knowledge ingestors`.

### Task 7: Add optional document/media adapters

**Files:**
- Create: `packages/core/src/knowledge/formats/DocumentIngestor.ts`
- Create: `packages/core/src/knowledge/formats/MediaIngestor.ts`
- Create: `packages/core/test/knowledge/formats/DocumentIngestor.test.ts`
- Create: `packages/core/test/knowledge/formats/MediaIngestor.test.ts`
- Modify: `packages/core/package.json`

**Interfaces:**
- Produces adapter interfaces for PDF, DOCX, PPTX, XLSX/ODS, EPUB/MOBI,
  image, audio, and video extraction.
- Each adapter returns `ExtractedSource` or a typed `unsupported`/`failed`
  result and never silently falls back to empty text.

- [ ] **Step 1: Add contract tests** with mocked adapter implementations so
  core behavior is testable without native document dependencies.
- [ ] **Step 2: Add optional dependency boundaries**; imports must not make
  core startup fail when an adapter package is not installed.
- [ ] **Step 3: Implement metadata-preserving dispatch and explicit errors.**
- [ ] **Step 4: Test unsupported format, parser failure, extracted media
  references, and oversized document behavior.**
- [ ] **Step 5: Run package tests without optional adapters installed and with
  the selected adapter set installed.**
- [ ] **Step 6: Commit** with `feat(core): add optional document ingestion adapters`.

### Task 8: Add folder import and source watcher

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeSourceScanner.ts`
- Create: `packages/core/src/knowledge/KnowledgeSourceWatcher.ts`
- Create: `packages/core/test/knowledge/KnowledgeSourceScanner.test.ts`
- Create: `packages/core/test/knowledge/KnowledgeSourceWatcher.test.ts`

**Interfaces:**
- Produces `scanKnowledgeSources(root, policy): Promise<SourceCandidate[]>`.
- Produces `KnowledgeSourceWatcher.start()` and `.stop()`.
- Emits normalized `created`, `changed`, `deleted`, and `renamed` events.

- [ ] **Step 1: Test recursive scanning, directory context, ignored paths, and
  stable ordering.**
- [ ] **Step 2: Test watcher debounce, create/change/delete, and stop behavior
  with fake timers and a temporary workspace.**
- [ ] **Step 3: Implement scanner using existing file/path conventions.**
- [ ] **Step 4: Implement watcher with debounce and explicit error events;
  watcher failures must not crash task capture.**
- [ ] **Step 5: Run watcher/scanner tests and concurrency tests.**
- [ ] **Step 6: Commit** with `feat(core): watch knowledge source roots`.

---

## Sub-project 3: Queue, analysis, generation, and review

### Task 9: Implement persistent knowledge queue

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeQueue.ts`
- Create: `packages/core/test/knowledge/KnowledgeQueue.test.ts`

**Interfaces:**
- Produces `enqueueKnowledgeJob(input): KnowledgeJobRecord`.
- Produces `claimKnowledgeJob(workerId): KnowledgeJobRecord | null`.
- Produces `completeKnowledgeJob`, `failKnowledgeJob`, `cancelKnowledgeJob`,
  `retryKnowledgeJob`, `recoverExpiredKnowledgeJobs`.
- Produces progress events with job ID, stage, completed units, and totals.

- [ ] **Step 1: Test all state transitions, invalid transitions, retry limits,
  cancellation, lease expiry, and duplicate source-version suppression.**
- [ ] **Step 2: Implement transactional claim/lease updates using SQLite
  timestamps and prepared statements.**
- [ ] **Step 3: Implement progress event persistence and polling.**
- [ ] **Step 4: Test two workers cannot claim the same job.**
- [ ] **Step 5: Run queue, migration, and concurrency tests.**
- [ ] **Step 6: Commit** with `feat(core): add persistent knowledge queue`.

### Task 10: Define provider and structured analysis contracts

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeProviders.ts`
- Create: `packages/core/src/knowledge/KnowledgeAnalysis.ts`
- Create: `packages/core/test/knowledge/KnowledgeProviders.test.ts`
- Create: `packages/core/test/knowledge/KnowledgeAnalysis.test.ts`

**Interfaces:**
- Produces `KnowledgeProviderRegistry`.
- Produces `KnowledgeAnalyzer.analyze(input): Promise<KnowledgeAnalysis>`.
- Produces `KnowledgeGenerator.generate(input): Promise<KnowledgeGeneration>`.
- Produces provider capabilities for chat, analysis, generation, embeddings,
  vision, transcription, and research.
- Produces no-provider deterministic behavior that returns an explicit
  `provider_required` result rather than silently generating empty content.

- [ ] **Step 1: Test provider registration, capability checks, timeout
  propagation, and missing-provider errors.**
- [ ] **Step 2: Test schema validation for entities, claims, relationships,
  contradictions, research gaps, and confidence values.**
- [ ] **Step 3: Implement provider-neutral interfaces and strict result
  validation.**
- [ ] **Step 4: Add redaction hooks around prompts, responses, and logs.**
- [ ] **Step 5: Run focused tests.**
- [ ] **Step 6: Commit** with `feat(core): define knowledge generation contracts`.

### Task 11: Implement page versions and atomic generation

**Files:**
- Create: `packages/core/src/knowledge/KnowledgePageStore.ts`
- Create: `packages/core/src/knowledge/KnowledgeGeneratorService.ts`
- Create: `packages/core/src/knowledge/KnowledgeRenderer.ts`
- Create: `packages/core/test/knowledge/KnowledgePageStore.test.ts`
- Create: `packages/core/test/knowledge/KnowledgeGeneratorService.test.ts`
- Create: `packages/core/test/knowledge/KnowledgeRenderer.test.ts`

**Interfaces:**
- Produces `createPageVersion`, `getCurrentPage`, `listPages`,
  `supersedePageVersion`, `markPageStale`.
- Produces `runKnowledgeGeneration(jobId): Promise<GenerationResult>`.
- Produces `renderKnowledgePage(page): string`.
- Produces atomic `index.md`, `overview.md`, `log.md`, `index.json`, and
  `manifest.json` updates.

- [ ] **Step 1: Test page version creation, current-version selection,
  supersession, stale state, and rollback on renderer failure.**
- [ ] **Step 2: Test frontmatter contains page ID, type, source IDs,
  provenance, confidence, generator version, and timestamp.**
- [ ] **Step 3: Implement page persistence and content-addressed generated
  files using temporary paths plus rename.**
- [ ] **Step 4: Implement index/overview/log rendering with stable ordering.**
- [ ] **Step 5: Test a failed generation leaves the prior version and indexes
  unchanged.**
- [ ] **Step 6: Run focused tests and archive/export tests.**
- [ ] **Step 7: Commit** with `feat(core): generate versioned knowledge pages`.

### Task 12: Implement review workflow

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeReview.ts`
- Create: `packages/core/test/knowledge/KnowledgeReview.test.ts`

**Interfaces:**
- Produces `createKnowledgeReview`, `listKnowledgeReviews`,
  `resolveKnowledgeReview`, `reopenKnowledgeReview`,
  `bulkResolveKnowledgeReviews`.
- Valid actions are `accept`, `reject`, `edit`, `merge`, `skip`, `research`,
  `create_task`, and `label`.

- [ ] **Step 1: Test valid/invalid action validation, evidence requirements,
  bulk resolution, reopening, and audit records.**
- [ ] **Step 2: Implement review state transitions with explicit actor/source.**
- [ ] **Step 3: Ensure review actions cannot execute arbitrary commands or
  arbitrary LLM-provided action names.**
- [ ] **Step 4: Run focused review and security tests.**
- [ ] **Step 5: Commit** with `feat(core): add knowledge review workflow`.

---

## Sub-project 4: Search and native graph

### Task 13: Generalize search across knowledge and Ariadne state

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeSearch.ts`
- Create: `packages/core/test/knowledge/KnowledgeSearch.test.ts`
- Modify: `packages/core/src/Search.ts`
- Modify: `packages/core/src/ContextBuilder.ts`

**Interfaces:**
- Produces `searchKnowledge(query, options): KnowledgeSearchResult[]`.
- Supports `knowledge`, `sources`, `tasks`, `hybrid`, and
  `read-sources-only` modes.
- Produces citations with page ID, source ID, path/URL, and source span.
- Preserves existing `searchWorkspace` and `buildContext` behavior.

- [ ] **Step 1: Add failing tests for each search mode, ranking, deduplication,
  source-only enforcement, and citation output.**
- [ ] **Step 2: Implement lexical search over indexed page/source/task fields
  without changing existing task search semantics.**
- [ ] **Step 3: Add graph expansion hooks and token-budgeted context assembly.**
- [ ] **Step 4: Test empty query, Unicode, stale pages, missing sources, and
  budget truncation.**
- [ ] **Step 5: Run all existing `Search` and `ContextBuilder` tests plus the
  new knowledge search tests.**
- [ ] **Step 6: Commit** with `feat(core): add hybrid knowledge search`.

### Task 14: Implement native graph storage and traversal

**Files:**
- Create: `packages/core/src/knowledge/graph/KnowledgeGraph.ts`
- Create: `packages/core/src/knowledge/graph/KnowledgeGraphScoring.ts`
- Create: `packages/core/src/knowledge/graph/KnowledgeGraphTraversal.ts`
- Create: `packages/core/test/knowledge/graph/KnowledgeGraph.test.ts`
- Create: `packages/core/test/knowledge/graph/KnowledgeGraphTraversal.test.ts`

**Interfaces:**
- Produces `upsertGraphNode`, `upsertGraphEdge`, `removeGraphEdge`,
  `getGraphNeighborhood`, `findGraphPath`, `scoreGraphEdge`.
- Edge records contain evidence type, weight, confidence, and provenance.
- Traversal supports directed/undirected options and maximum hop/budget limits.

- [ ] **Step 1: Test explicit links, shared-source edges, provenance edges,
  inferred edges, confidence, self-loop rejection, and endpoint validation.**
- [ ] **Step 2: Implement the weighted scoring table from the approved spec.**
- [ ] **Step 3: Implement bounded BFS/path traversal with deterministic ordering.**
- [ ] **Step 4: Test large-degree nodes, disconnected nodes, missing endpoints,
  cycles, and token/row budgets.**
- [ ] **Step 5: Run graph and migration tests.**
- [ ] **Step 6: Commit** with `feat(core): add native knowledge graph traversal`.

### Task 15: Add communities, bridge metrics, and insights

**Files:**
- Create: `packages/core/src/knowledge/graph/KnowledgeCommunities.ts`
- Create: `packages/core/src/knowledge/graph/KnowledgeInsights.ts`
- Create: `packages/core/test/knowledge/graph/KnowledgeCommunities.test.ts`
- Create: `packages/core/test/knowledge/graph/KnowledgeInsights.test.ts`

**Interfaces:**
- Produces `detectKnowledgeCommunities(graph): KnowledgeCommunity[]`.
- Produces `scoreCommunityCohesion`.
- Produces `findBridgeNodes`, `findSparseCommunities`,
  `findOrphanPages`, `findContradictions`, `findStalePages`.
- Persists insights with evidence and action options.

- [ ] **Step 1: Test deterministic community output on a fixture graph,
  cohesion scores, bridge nodes, sparse clusters, and orphan detection.**
- [ ] **Step 2: Implement a bounded Louvain-compatible/community algorithm
  or an approved graph library adapter; document the chosen algorithm.**
- [ ] **Step 3: Implement insight persistence and deduplication by graph
  snapshot plus insight fingerprint.**
- [ ] **Step 4: Test graph snapshot changes produce new or resolved insights.**
- [ ] **Step 5: Run focused graph tests.**
- [ ] **Step 6: Commit** with `feat(core): detect knowledge graph insights`.

### Task 16: Add optional embeddings and Graphify import

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeEmbeddings.ts`
- Create: `packages/core/src/knowledge/GraphifyImport.ts`
- Create: `packages/core/test/knowledge/KnowledgeEmbeddings.test.ts`
- Create: `packages/core/test/knowledge/GraphifyImport.test.ts`
- Modify: `packages/core/src/Graphify.ts`

**Interfaces:**
- Produces `EmbeddingProvider.embed(input): Promise<number[]>`.
- Produces `rankByEmbedding(query, candidates, provider)`.
- Produces `importGraphifyJson(input): GraphImportResult`.
- Existing `runGraphify` passthrough remains unchanged.

- [ ] **Step 1: Test provider absence, dimension mismatch, timeout, and
  deterministic lexical fallback.**
- [ ] **Step 2: Test Graphify nodes/edges import with endpoint validation,
  path normalization, and explicit inferred-edge labeling.**
- [ ] **Step 3: Implement adapters without making Python or an embedding
  service a required dependency.**
- [ ] **Step 4: Run existing Graphify tests and new adapter tests.**
- [ ] **Step 5: Commit** with `feat(core): add optional embeddings and graphify import`.

---

## Sub-project 5: Deletion, research, chat, skills, and outputs

### Task 17: Implement source deletion and stale reconciliation

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeReconciliation.ts`
- Create: `packages/core/test/knowledge/KnowledgeReconciliation.test.ts`

**Interfaces:**
- Produces `reconcileChangedSource(sourceId)`.
- Produces `reconcileDeletedSource(sourceId)`.
- Preserves shared pages while removing only deleted-source provenance.
- Emits stale-page and review insights where automatic cleanup is unsafe.

- [ ] **Step 1: Test source-specific page deletion, shared concept preservation,
  index cleanup, dead-link cleanup, and review creation for ambiguity.**
- [ ] **Step 2: Implement reconciliation in transactions with page-version
  safety and graph edge cleanup.**
- [ ] **Step 3: Test failure rollback and rerun idempotence.**
- [ ] **Step 4: Commit** with `feat(core): reconcile changed and deleted sources`.

### Task 18: Implement research provider contracts and workflow

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeResearch.ts`
- Create: `packages/core/src/knowledge/research/ResearchProviders.ts`
- Create: `packages/core/test/knowledge/KnowledgeResearch.test.ts`

**Interfaces:**
- Produces `createResearchRequest`, `confirmResearchRequest`,
  `cancelResearchRequest`, `runResearchRequest`.
- Supports Tavily, SerpApi, SearXNG, and generic provider adapters.
- Produces source records and a cited synthesis page after ingestion.

- [ ] **Step 1: Test confirmation requirement, provider timeouts, result
  normalization, URL validation, rate-limit errors, and cancellation.**
- [ ] **Step 2: Implement provider-neutral search contracts with no provider
  enabled by default.**
- [ ] **Step 3: Implement result ingestion through the ordinary source queue.**
- [ ] **Step 4: Link research to insights and optional child Ariadne tasks.**
- [ ] **Step 5: Run focused research/security tests.**
- [ ] **Step 6: Commit** with `feat(core): add governed knowledge research`.

### Task 19: Implement persistent knowledge chat

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeChat.ts`
- Create: `packages/core/test/knowledge/KnowledgeChat.test.ts`

**Interfaces:**
- Produces conversation/message CRUD.
- Produces `streamKnowledgeChat(input): AsyncIterable<KnowledgeChatEvent>`.
- Supports retrieval modes, citations, cancellation, regeneration, and
  save-to-page.

- [ ] **Step 1: Test conversation persistence, history limits, source-only
  retrieval, citations, cancellation, and regeneration.**
- [ ] **Step 2: Implement chat orchestration over `KnowledgeSearch`,
  `KnowledgeGraph`, provider tools, and task context.**
- [ ] **Step 3: Ensure streaming emits `meta`, `delta`, `citation`, `done`,
  `cancelled`, and `error` events exactly once where applicable.**
- [ ] **Step 4: Test provider failure and partial-stream handling.**
- [ ] **Step 5: Commit** with `feat(core): add cited knowledge chat`.

### Task 20: Add skills and generated output management

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeSkills.ts`
- Create: `packages/core/src/knowledge/KnowledgeOutputs.ts`
- Create: `packages/core/test/knowledge/KnowledgeSkills.test.ts`
- Create: `packages/core/test/knowledge/KnowledgeOutputs.test.ts`

**Interfaces:**
- Produces skill discovery, validation, enable/disable, and per-conversation
  selection.
- Produces confined output creation/listing/preview/deletion with provenance.
- Structured skill input requests never execute arbitrary actions.

- [ ] **Step 1: Test skill path precedence, malformed metadata, disabled
  skills, and explicit selection.**
- [ ] **Step 2: Test output path confinement, overwrite policy, MIME metadata,
  and cleanup.**
- [ ] **Step 3: Implement skill/output services using existing Ariadne skill
  template and redaction conventions.**
- [ ] **Step 4: Run focused security tests.**
- [ ] **Step 5: Commit** with `feat(core): add knowledge skills and outputs`.

### Task 21: Add export/import and Obsidian-compatible Markdown

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeArchive.ts`
- Create: `packages/core/test/knowledge/KnowledgeArchive.test.ts`
- Modify: `packages/core/src/Exporter.ts`

**Interfaces:**
- Produces `exportKnowledgeProject(options): ArchiveManifest`.
- Produces `importKnowledgeProject(archive, options): ImportResult`.
- Produces Markdown wikilinks/frontmatter export without requiring Obsidian.

- [ ] **Step 1: Test complete archive manifest, path traversal rejection,
  secret omission, version mismatch, and atomic import.**
- [ ] **Step 2: Implement archive export for metadata, pages, graph JSON,
  media, reviews, and configuration while excluding provider secrets.**
- [ ] **Step 3: Implement optional Obsidian-compatible `.obsidian` export and
  Markdown import as an adapter, not a core dependency.**
- [ ] **Step 4: Run archive, exporter, and security tests.**
- [ ] **Step 5: Commit** with `feat(core): add knowledge archive migration`.

---

## Sub-project 6: CLI and MCP

### Task 22: Add CLI knowledge command group

**Files:**
- Create: `packages/cli/src/knowledgeCommands.ts`
- Create: `packages/cli/test/knowledgeCommands.test.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**
- Adds `ariadne knowledge project`, `source`, `ingest`, `queue`, `page`,
  `search`, `graph`, `review`, `research`, `chat`, `export`, and `import`.
- Every command maps to a core service and returns structured JSON with
  `--json`; human output includes citations and actionable errors.

- [ ] **Step 1: Add parser/dispatch tests for every command group and invalid
  combinations.**
- [ ] **Step 2: Implement command handlers using existing `withTask` and
  workspace resolution patterns.**
- [ ] **Step 3: Add progress output for queue/research/chat operations and
  cancellation handling.**
- [ ] **Step 4: Test no-provider deterministic commands on an isolated temp
  workspace.**
- [ ] **Step 5: Add CLI documentation and a changeset if public package
  behavior changes.**
- [ ] **Step 6: Commit** with `feat(cli): expose knowledge workspace commands`.

### Task 23: Add MCP knowledge tools and resources

**Files:**
- Create: `packages/mcp-server/src/knowledgeTools.ts`
- Create: `packages/mcp-server/test/knowledgeTools.test.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/src/tools.ts`

**Interfaces:**
- Adds typed tools for project/source/queue/page/search/graph/review/research/
  chat/export/import operations.
- Adds read resources for current project overview, page content, graph
  snapshots, unresolved reviews, and queue status.

- [ ] **Step 1: Add handler tests for successful reads, validation errors,
  missing project/source/page IDs, and mutating tool authorization.**
- [ ] **Step 2: Implement tool registration using existing MCP schemas and
  error conversion conventions.**
- [ ] **Step 3: Add citation-bearing response shapes and bounded result limits.**
- [ ] **Step 4: Test concurrent read/write calls against SQLite.**
- [ ] **Step 5: Update MCP usage documentation and commit** with
  `feat(mcp): expose knowledge tools and resources`.

### Task 24: Add task/knowledge integration

**Files:**
- Create: `packages/core/src/knowledge/TaskKnowledgeProjection.ts`
- Create: `packages/core/test/knowledge/TaskKnowledgeProjection.test.ts`
- Modify: `packages/cli/src/currentTask.ts`
- Modify: `packages/mcp-server/src/tools.ts`

**Interfaces:**
- Produces explicit projection of task/checkpoint/decision/file/commit
  mutations into source/provenance records.
- Produces create/resume Ariadne task actions from knowledge insights.

- [ ] **Step 1: Test projection is idempotent and does not mutate original task
  records.**
- [ ] **Step 2: Implement explicit checkpoint/build triggers rather than
  making every passive capture perform an LLM call.**
- [ ] **Step 3: Add CLI/MCP commands to create or resume a task from an insight.**
- [ ] **Step 4: Run existing task, checkpoint, CLI, and MCP tests.**
- [ ] **Step 5: Commit** with `feat(core): link knowledge and task lifecycles`.

---

## Sub-project 7: VS Code integration

### Task 25: Add extension bridge messages and core client

**Files:**
- Create: `packages/vscode-extension/src/knowledgeClient.ts`
- Create: `packages/vscode-extension/src/knowledgeMessages.ts`
- Create: `packages/vscode-extension/test/knowledgeClient.test.ts`
- Create: `packages/vscode-extension/test/knowledgeMessages.test.ts`

**Interfaces:**
- Produces typed bridge requests for overview, search, page preview, graph,
  queue, review, and research.
- Uses the same core service contracts as CLI/MCP and exposes explicit loading,
  stale, empty, error, and success states.

- [ ] **Step 1: Test message validation and error normalization.**
- [ ] **Step 2: Implement extension-side client using existing webview bridge
  and workspace store cache.**
- [ ] **Step 3: Run extension tests.**
- [ ] **Step 4: Commit** with `feat(vscode): add knowledge bridge contracts`.

### Task 26: Add knowledge panels and commands

**Files:**
- Create: `packages/vscode-extension/webview-ui/src/panels/KnowledgeOverviewPanel.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/KnowledgeSearchPanel.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/KnowledgeGraphPanel.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/KnowledgeReviewPanel.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/KnowledgeActivityPanel.tsx`
- Create corresponding `*.test.tsx` files
- Modify: `packages/vscode-extension/webview-ui/src/App.tsx`
- Modify: `packages/vscode-extension/src/commands.ts`

**Interfaces:**
- Panels consume typed bridge responses and render citations, progress,
  review actions, graph insights, and page previews.

- [ ] **Step 1: Write component tests for loading, empty, success, stale,
  failure, cancellation, and responsive states.**
- [ ] **Step 2: Implement panels using existing Argon/theme and panel patterns.**
- [ ] **Step 3: Add commands for open overview, search, rebuild, queue status,
  and review actions.**
- [ ] **Step 4: Run webview unit tests and extension tests.**
- [ ] **Step 5: Run targeted Playwright/e2e coverage if configured.**
- [ ] **Step 6: Commit** with `feat(vscode): add knowledge workspace panels`.

---

## Sub-project 8: Dashboard, optional HTTP API, and compatibility

### Task 27: Add dashboard knowledge read/review views

**Files:**
- Create: `packages/dashboard/src/knowledge/KnowledgeOverviewPage.tsx`
- Create: `packages/dashboard/src/knowledge/KnowledgeSearchPage.tsx`
- Create: `packages/dashboard/src/knowledge/KnowledgeReviewsPage.tsx`
- Create corresponding tests
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/guards.ts`

- [ ] **Step 1: Test authenticated project boundaries, empty/loading/error
  states, citations, and review actions.**
- [ ] **Step 2: Implement pages using existing auth/provider/API patterns.**
- [ ] **Step 3: Add responsive/e2e tests for navigation and review resolution.**
- [ ] **Step 4: Run dashboard unit and e2e tests.**
- [ ] **Step 5: Commit** with `feat(dashboard): add knowledge views`.

### Task 28: Add optional loopback HTTP adapter

**Files:**
- Create: `packages/sync-server/src/routes/knowledge.ts`
- Create: `packages/sync-server/test/knowledgeRoutes.test.ts`
- Modify: `packages/sync-server/src/app.ts`

- [ ] **Step 1: Confirm MCP is insufficient for the intended browser/clipper
  integration before enabling this adapter.**
- [ ] **Step 2: Test loopback binding, token auth, read limits, mutating route
  validation, and secret absence in responses.**
- [ ] **Step 3: Implement only the stable core operations needed by browser
  or external adapters; do not duplicate business logic.**
- [ ] **Step 4: Run sync-server route/auth tests.**
- [ ] **Step 5: Commit** with `feat(sync): add optional knowledge loopback API`.

### Task 29: Add compatibility adapters and migration documentation

**Files:**
- Create: `docs/knowledge-wiki.md`
- Create: `docs/knowledge-migration.md`
- Modify: `README.md`
- Modify: `docs/05-USER-GUIDE.md`
- Modify: `packages/core/src/Graphify.ts`

- [ ] **Step 1: Document core-first setup, provider configuration, privacy,
  queue recovery, generated workspace layout, and CLI/MCP usage.**
- [ ] **Step 2: Document Graphify passthrough/import behavior and limitations.**
- [ ] **Step 3: Document Obsidian-compatible export/import without presenting
  Obsidian as a runtime requirement.**
- [ ] **Step 4: Add migration examples for existing Ariadne tasks and generated
  projects.**
- [ ] **Step 5: Run documentation link/lint checks if configured.**
- [ ] **Step 6: Commit** with `docs: document Ariadne knowledge workspace`.

---

## Cross-cutting validation gates

Run these after each sub-project:

```bash
pnpm --filter @ariadne-dev/core test
pnpm --filter @ariadne-dev/cli test
pnpm --filter @ariadne-dev/mcp-server test
pnpm --filter @ariadne-dev/vscode-extension test
pnpm --filter @ariadne-dev/dashboard test
```

Before release:

```bash
pnpm build
pnpm test
pnpm lint
```

Also run:

- migration upgrade from a representative pre-feature database;
- no-provider/offline smoke test;
- secret and ignored-file ingestion tests;
- queue crash/recovery test;
- source modification/deletion cascade test;
- archive export/import round trip;
- MCP and CLI parity checks;
- VS Code and dashboard end-to-end flows;
- performance fixtures for 10,000 deterministic sources and a large graph.

## Commit and review cadence

Each task ends in one focused commit. Do not combine schema, provider, UI, and
documentation changes into a single commit. After each sub-project:

1. run the focused tests;
2. run the affected package suite;
3. inspect the complete diff;
4. perform a security review of new input/provider/filesystem boundaries;
5. update the relevant documentation and changeset;
6. obtain review before starting the next sub-project.

## Plan self-review

### Spec coverage

- Project/source management: Tasks 1–8.
- Two-stage ingest/generation: Tasks 9–12.
- Search/vector/graph/communities/insights: Tasks 13–16.
- Deletion/watch/media: Tasks 7–8 and 17.
- Review system: Task 12.
- Deep research: Task 18.
- Persistent chat and generated outputs: Tasks 19–20.
- Skills: Task 20.
- Archive/Obsidian compatibility: Task 21 and Task 29.
- CLI/MCP: Tasks 22–24.
- VS Code/dashboard/API: Tasks 25–28.
- Security, privacy, and failure handling: global constraints plus every
  source/provider/archive/queue task.
- Testing and performance: task-level tests plus cross-cutting gates.

### Placeholder scan

The plan contains no `TBD`, `TODO`, or unspecified “add appropriate”
implementation steps. Any later design decision is isolated to the explicit
open decisions in the approved feature plan and must be resolved before the
affected task starts.

### Type consistency

All later tasks consume the stable ID, provenance, source, page, job, review,
provider, search, graph, archive, CLI, and MCP concepts introduced in earlier
tasks. Implementers must preserve the exact names in each task's Interfaces
section; changes require updating downstream task descriptions before coding.

