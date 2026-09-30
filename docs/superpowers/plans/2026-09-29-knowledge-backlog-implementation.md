# Knowledge Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved deterministic knowledge-worker backlog while preserving offline-first behavior, project isolation, provenance, privacy, and bounded resource use.

**Architecture:** Land the shared archive/settings/migration contracts first, then implement the search and evidence pipeline in dependency order. Each slice owns its tables and public contracts, uses additive migrations, has focused regression tests, and falls back explicitly rather than returning success-shaped partial data.

**Tech Stack:** TypeScript, SQLite via better-sqlite3, Vitest, existing Ariadne core/CLI/MCP/dashboard/VS Code packages.

**Spec:** `docs/superpowers/specs/2026-09-29-knowledge-backlog-contracts-design.md` and the slice specifications in `docs/superpowers/specs/2026-09-29-*-design.md`

## Global Constraints

- Offline by default; no network/provider calls except explicit synthesis/summary opt-in with warning-only fallback.
- Every new query and table operation is project-scoped.
- No raw source contents, prompts, provider responses, secrets, or absolute private paths are persisted.
- New schema changes are additive and use reserved global migrations 11 through 18.
- Derived indexes/vectors are rebuilt after archive import and never exported.
- Host-local `host.*` settings are never exported, imported, logged, or echoed.
- Use RED → GREEN → IMPROVE and run focused tests before broader suites.
- Do not access SSH, nodem2, deployment systems, real providers, or mutate `/home/lkumar/atom`.

---

### Task 1: Archive compatibility and host-local settings

**Files:**
- Modify: `packages/core/src/knowledge/KnowledgeArchive.ts`
- Modify: `packages/core/test/knowledge/KnowledgeArchive.test.ts`
- Modify: `packages/core/src/knowledge/knowledgeSchema.ts` only for shared constants if required
- Test: archive import/export regression tests

**Interfaces:**
- Produces archive version 2 manifest/omission behavior, explicit table classification, host-setting filtering, optional columns, and `ImportResult.postImport`.
- Consumers rely on derived-table omission and host-local preservation.

- [ ] Write failing tests for archive v2 classification, `host.*` omission/rejection, derived rebuild reporting, and provider-reference redaction.
- [ ] Run the focused archive tests and verify the new tests fail.
- [ ] Implement the explicit allowlist/classification registry and versioned manifest compatibility without dynamic SQL identifiers.
- [ ] Run focused archive tests until green, then add malformed archive and replace-existing coverage.
- [ ] Run the archive migration tests and commit `feat(knowledge): add archive compatibility contracts`.

### Task 2: Materialized deterministic search index

**Files:**
- Create: `packages/core/src/knowledge/KnowledgeSearchIndex.ts`
- Create: `packages/core/test/knowledge/KnowledgeSearchIndex.test.ts`
- Modify: `packages/core/src/migrations.ts`
- Modify: `packages/core/src/knowledge/KnowledgeWorker.ts`
- Modify: `packages/core/src/knowledge/KnowledgeSearch.ts`
- Modify: `packages/core/test/knowledge/KnowledgeSearch.test.ts`
- Modify: `packages/core/test/knowledge/knowledgeMigrations.test.ts`

**Interfaces:**
- `KnowledgeSearchIndex.replaceForSourceVersion`, `markSourceStale`, `rebuildProject`, `getStatus`, and `findCandidates`.
- `searchKnowledge` merges indexed candidates with explicit per-source fallback candidates.

- [ ] Add migration and index lifecycle tests first.
- [ ] Verify focused tests fail.
- [ ] Implement bounded redacted field materialization and project-scoped candidate lookup.
- [ ] Wire worker replacement and search fallback without changing public search types.
- [ ] Test partial indexes, pending versions, metadata-only indexes, redaction, rollback, and parity.
- [ ] Run core search/migration tests and commit `feat(knowledge): add bounded search index`.

### Task 3: Top-one confidence and ambiguity

**Files:**
- Modify: `packages/core/src/knowledge/KnowledgeSearch.ts`
- Modify: `packages/core/test/knowledge/KnowledgeSearch.test.ts`
- Modify: search result types and consumers only where additive metadata is required.

- [ ] Add failing tests for near ties, shared structural roles, insufficient intent, stable alternatives, and no false ambiguity.
- [ ] Implement deterministic pre-semantic confidence metadata and bounded alternatives.
- [ ] Verify ranking, citation, and evaluation behavior remain unchanged except for additive metadata.
- [ ] Commit `feat(knowledge): report deterministic search ambiguity`.

### Task 4: Citation context and legacy result envelopes

**Files:**
- Modify: `packages/core/src/knowledge/KnowledgeChat.ts`
- Modify: `packages/core/src/knowledge/KnowledgeQueue.ts`
- Modify: `packages/core/src/knowledge/knowledgeMigrations.ts`
- Modify: `packages/core/src/migrations.ts`
- Modify: related core tests and archive schemas.

- [ ] Add failing dual-read/dual-write tests for `MessagePayloadV2`, citation context, legacy payloads, and `result_schema_version`.
- [ ] Implement tolerant parsing and additive V2 writing with reference-only persistence.
- [ ] Add migration 12 and versioned analyzed job-result parsing.
- [ ] Verify malformed legacy payloads remain explicit `legacy_unknown`.
- [ ] Commit `feat(knowledge): version citations and job results`.

### Task 5: Analyzer coverage and unsupported diagnostics

**Files:**
- Create or modify analyzer coverage service and tests per approved spec.
- Modify: `packages/core/src/knowledge/KnowledgeWorker.ts`
- Modify: queue/job result tests and migration tests.

- [ ] Add failing tests for supported, partial, unsupported, generated, and deferred relationship cases.
- [ ] Implement migrations 13, coverage-only result writing, bounded diagnostics, and deferred relationship persistence.
- [ ] Verify unsupported sources complete as coverage-only while unsupported job kinds still fail.
- [ ] Commit `feat(knowledge): record analyzer coverage`.

### Task 6: Graph completeness and ambiguity reporting

**Files:**
- Create graph report/ambiguity service and focused tests.
- Modify graph materialization and worker integration.
- Modify migration and archive classification tests.

- [ ] Add failing completeness, unsupported-count, ambiguity, and project-isolation tests.
- [ ] Implement migration 14 and deterministic report generation without source snippets.
- [ ] Verify reports are optional/recomputable and do not alter graph evidence semantics.
- [ ] Commit `feat(knowledge): add graph completeness reports`.

### Task 7: Freshness, watcher recovery, and requeue

**Files:**
- Create freshness/recovery service and tests.
- Modify `packages/core/src/knowledge/KnowledgeSourceWatcher.ts`
- Modify `packages/core/src/knowledge/KnowledgeQueue.ts`
- Modify worker/status integration and migration tests.

- [ ] Add failing tests for changed files, missing files, watcher restart, stale leases, retry backoff, and same-source requeue.
- [ ] Implement migration 15, `requeueAnalyze`, durable freshness state, and recovery diagnostics.
- [ ] Verify unique job identity remains intact and requeue is an explicit state transition.
- [ ] Commit `feat(knowledge): add freshness recovery and requeue`.

### Task 8: Safe worker concurrency

**Files:**
- Create `KnowledgeHostSettingsStore` and tests.
- Modify worker/queue/CLI status and tests.
- Modify archive tests for host-local settings.

- [ ] Add failing tests for validated concurrency, lease renewal, cancellation, and no duplicate claims.
- [ ] Implement host-local settings and bounded worker parallelism with transactional claims.
- [ ] Verify invalid settings fail fast and CLI reports actual active leases.
- [ ] Commit `feat(knowledge): add bounded worker concurrency`.

### Task 9: Hybrid local semantic retrieval

**Files:**
- Create local semantic index/model service and tests.
- Modify `KnowledgeSearch.ts`, search index hooks, settings store, migrations, and archive rebuild reporting.

- [ ] Add failing tests for explicit enablement, lexical expansion, zero-lexical rescue within bounded candidates, confidence preservation, redaction, invalidation, and rebuild locking.
- [ ] Implement migration 16 and local deterministic semantic projection without provider dependencies.
- [ ] Verify lexical-only fallback and no unbounded scan.
- [ ] Commit `feat(knowledge): add bounded local semantic retrieval`.

### Task 10: Cross-file answer synthesis and provider summaries

**Files:**
- Create synthesis and summary services/tests per their specs.
- Modify `KnowledgeChat.ts`, provider policy integration, archive payload validation, and docs.

- [ ] Add failing deterministic synthesis, provenance, ambiguity propagation, provider capability, timeout, malformed-response, and warning-only fallback tests.
- [ ] Implement reference-only persisted synthesis and migration 17 summaries.
- [ ] Verify provider requests are opt-in, non-streaming, bounded, and never required for deterministic answers.
- [ ] Commit `feat(knowledge): add provenance-preserving synthesis`.

### Task 11: Relevance analytics and regression persistence

**Files:**
- Create analytics/feedback service and tests.
- Modify search/chat integration, settings store, migrations, archive omission tests, and evaluation docs.

- [ ] Add failing opt-in, opaque-ID, count-only, salt, ambiguity, and archive privacy tests.
- [ ] Implement migration 18 and regression-run persistence with no prompts, paths, snippets, or source contents.
- [ ] Verify disabled-by-default behavior and deterministic regression thresholds.
- [ ] Commit `feat(knowledge): add privacy-preserving search analytics`.

### Task 12: Cross-surface integration and final validation

**Files:**
- Modify CLI, MCP, VS Code, dashboard, docs, and integration tests only where new additive capabilities require exposure.
- Modify `task-10-report.md` and relevant knowledge documentation.

- [ ] Add failing integration tests for status, run-once, search confidence/citations, archive rebuild warnings, and deterministic fallback.
- [ ] Implement surface wiring with stable JSON envelopes and redacted diagnostics.
- [ ] Run focused tests for every changed package.
- [ ] Run full core and CLI suites/builds, synthetic NAAS evaluation, and package-level integration tests.
- [ ] Run TypeScript review and security review for archive/import/provider changes.
- [ ] Record a final Ariadne checkpoint and summarize the completed commits and validations.
