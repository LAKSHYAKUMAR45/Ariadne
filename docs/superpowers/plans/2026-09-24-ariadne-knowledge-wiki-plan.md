# Ariadne Knowledge Wiki — Full Capability Plan

**Date:** 2026-09-24  
**Status:** Planning only; no implementation included  
**Worktree:** `.worktrees/ariadne-knowledge-wiki`  
**Branch:** `feat/ariadne-knowledge-wiki-plan`

## 1. Executive summary

This plan adds the full capability set represented by
[`nashsu/llm_wiki`](https://github.com/nashsu/llm_wiki) as a first-class,
local-first feature of Ariadne.

Ariadne should not become a source-code copy or a second unrelated application.
The implementation should preserve Ariadne's central invariant:

> one shared core, with thin CLI, MCP, VS Code, and dashboard adapters.

The recommended architecture is **hybrid**:

- Ariadne's SQLite database remains authoritative for structured task state,
  generated knowledge metadata, provenance, review state, configuration, queue
  state, and chat/research records.
- A generated knowledge workspace contains portable Markdown, JSON, graph
  exports, media, and indexes. It is an output and interoperability layer,
  not an independently edited database.
- Human edits are accepted through explicit import/rebuild commands and are
  reconciled back into structured metadata where possible.

The initial implementation is **core-first**:

1. shared ingestion, knowledge synthesis, graph, retrieval, queue, review,
   provider, and export primitives;
2. CLI and MCP access;
3. VS Code integration;
4. dashboard and optional desktop-shell integration.

The plan deliberately replaces Obsidian as the product dependency. Markdown
remains supported as a portable format, but the primary user experience is
the Ariadne knowledge workspace and its existing surfaces.

## 2. Product goal

Ariadne currently preserves the state of active software work: tasks, goals,
checkpoints, decisions, todos, errors, commands, files, and commits. The
knowledge-wiki feature should turn that durable work history, repository
documentation, imported references, and optional web research into a
traceable, queryable, continuously maintained knowledge base.

The resulting system must support both directions:

- **Work to knowledge:** completed and active work produces durable concepts,
  architecture pages, decision records, failure patterns, and cross-task
  synthesis.
- **Knowledge to work:** agents and developers query that knowledge, inspect
  provenance, identify gaps, launch research, and create or resume Ariadne
  tasks from findings.

The feature is successful when an agent can answer questions such as:

- What is the current architecture and which decisions support it?
- Which tasks, commits, and source files establish this behavior?
- Where are the unresolved contradictions or knowledge gaps?
- What changed since the last knowledge build?
- Which concepts bridge otherwise separate areas of the repository?

## 3. Capability parity target

The following capabilities are in scope. They are grouped by the subsystem
that should own them rather than copied one-for-one from the reference UI.

### 3.1 Project and workspace management

- Create, open, rename, archive, export, import, and rebuild knowledge
  projects.
- Associate a project with one or more repository/workspace roots.
- Store project purpose, scope, language, schema, model configuration, and
  source policies.
- Preserve relative source paths and workspace identity across machines.
- Support complete project archive migration, including metadata, generated
  pages, graph exports, media, review items, and configuration without
  exporting secrets.
- Maintain an explicit project version and migration format.

### 3.2 Multi-format source ingestion

Support the reference repository's source categories through an extensible
ingestion interface:

- Markdown and plain text.
- Source code and repository documentation.
- PDF, including page and section provenance.
- DOCX, PPTX, XLSX/ODS, EPUB/MOBI.
- Images with vision captions and source references.
- Audio/video through an optional transcription adapter.
- Web pages and saved web clips.
- Recursive folders with directory context.
- Batches of URLs.
- Ariadne-native task history, checkpoints, decisions, errors, todos,
  commands, files, and commits.

Each source must receive:

- stable source ID;
- canonical path or URL;
- content hash;
- format and metadata;
- extraction status;
- source version;
- created/updated timestamps;
- privacy classification;
- links to the originating task/workspace where applicable.

Unchanged sources must be skipped using content hashes. Deletion must trigger
the same cascade/reconciliation lifecycle as the reference system.

### 3.3 Two-stage knowledge generation

Use two separate stages so analysis can be inspected and retried independently:

**Stage A — analysis**

- Extract entities, concepts, claims, events, decisions, relationships,
  contradictions, and candidate page types.
- Identify overlap with existing generated knowledge.
- Identify potential review items and research gaps.
- Produce structured JSON with source spans and confidence.

**Stage B — generation**

- Create or update pages.
- Update indexes and overview summaries.
- Add source references and stable page IDs.
- Add links between pages.
- Emit review items for ambiguous or consequential changes.
- Emit research topics and search queries for gaps.
- Record an operation log and model/provider metadata.

The stages must be idempotent, cancellable, retryable, and resumable. A
failed generation must not destroy the last known-good knowledge build.

### 3.4 Knowledge model and page types

The generated knowledge layer should support at least:

- `overview`: global project summary and current state;
- `concept`: durable technical or domain concept;
- `entity`: person, organization, system, repository, product, or component;
- `architecture`: system boundary, data flow, dependency, or protocol page;
- `decision`: decision record linked to Ariadne decisions and tasks;
- `source`: normalized summary of an imported source;
- `failure`: recurring error, incident, or troubleshooting pattern;
- `workstream`: cross-task area of ongoing work;
- `synthesis`: cross-source or cross-task analysis;
- `comparison`: structured comparison;
- `query`: saved answer or research result;
- `gap`: unresolved knowledge area;
- `review`: generated item awaiting human judgment.

Pages should use stable IDs and structured frontmatter/metadata:

```yaml
id: knowledge:concept:...
type: concept
title: ...
status: active
sources:
  - source:...
provenance:
  - task:...
  - checkpoint:...
  - file:...
  - commit:...
generated_at: ...
generator_version: ...
confidence: 0.0
```

Markdown is the portable rendering. SQLite stores the canonical page record,
relationships, versions, and provenance so search and reconciliation do not
depend on reparsing every file.

### 3.5 Indexes and navigation

Generate:

- `index.md`: page catalog with links, types, summaries, and update dates;
- `overview.md`: current high-level synthesis;
- `log.md`: append-only, parseable operation history;
- optional `schema.md`: page and provenance rules;
- optional `purpose.md`: project intent, scope, and key questions;
- machine-readable `index.json`;
- machine-readable `manifest.json`.

The product should also offer an Ariadne-native navigator through CLI, MCP,
VS Code, and dashboard instead of requiring an Obsidian vault.

### 3.6 Search and retrieval

Implement a layered retrieval pipeline:

1. deterministic lexical search over titles, aliases, content, metadata,
   provenance, tasks, files, commits, and raw sources;
2. optional vector search through a provider interface;
3. graph expansion from top results;
4. relevance scoring and deduplication;
5. token-budgeted context assembly;
6. citations containing page IDs and source locations.

The existing `Search.ts` and `ContextBuilder.ts` should be generalized rather
than bypassed. Existing task-context behavior must remain deterministic and
must work when knowledge indexing is disabled.

Search modes:

- `knowledge`: generated pages only;
- `sources`: original imported material only;
- `tasks`: Ariadne task history only;
- `hybrid`: all layers with provenance;
- `read-sources-only`: answer evidence may come only from raw sources;
- `deep`: broader graph and source expansion under a larger budget.

### 3.7 Knowledge graph

Ariadne may deviate from Graphify's current graph implementation. The plan
uses a dedicated core graph model that can ingest:

- explicit page links;
- source overlap;
- task/checkpoint/file/commit provenance;
- semantic relationships;
- contradiction and supersession edges;
- graph confidence and evidence type;
- community membership and bridge metrics.

Graphify remains an optional repository-analysis adapter and compatibility
integration, not the required graph engine.

The graph engine should provide:

- node and edge persistence;
- directed and undirected views;
- weighted relevance;
- two-hop expansion;
- shortest path and neighborhood traversal;
- community detection;
- cohesion scoring;
- bridge-node detection;
- sparse-community/knowledge-gap detection;
- surprising-connection suggestions;
- graph snapshots and incremental updates;
- JSON export and a stable query API.

Recommended initial scoring model, adapted from the reference project:

| Signal | Initial weight | Meaning |
|---|---:|---|
| Explicit link | 3.0 | A page directly references another |
| Shared source | 4.0 | Two pages derive from the same source |
| Provenance overlap | 3.0 | Pages share task/file/commit evidence |
| Adamic-Adar | 1.5 | Shared neighbors indicate relatedness |
| Type affinity | 1.0 | Same page type provides a small bonus |
| Semantic similarity | configurable | Optional embedding signal |

All inferred edges must retain evidence and confidence. The system must never
present an inferred edge as an explicit fact.

### 3.8 Graph insights

Generate actionable insight records:

- bridge nodes connecting multiple communities;
- sparse communities;
- orphan pages;
- contradictory claims;
- stale pages;
- missing source coverage;
- duplicate or near-duplicate pages;
- unresolved research gaps;
- rapidly changing concepts.

Each insight must link to graph nodes, source evidence, and an optional action:
review, merge, regenerate, research, or create task.

### 3.9 Persistent ingest queue

Implement a persistent queue in SQLite:

- pending, running, succeeded, failed, cancelled states;
- source-level and project-level jobs;
- deterministic ordering;
- retry count and backoff;
- crash recovery;
- cancellation;
- progress events;
- resumable stage boundaries;
- concurrency limits by provider;
- queue inspection and retry commands;
- no duplicate generation for the same source version.

The queue is the boundary between file watchers/import commands and LLM work.
It must not block normal task capture.

### 3.10 Source watching and synchronization

Add optional recursive watching for configured source roots:

- detect create, modify, rename, and delete;
- debounce bursts;
- reuse content hashes;
- enqueue ingest/delete jobs;
- preserve directory context;
- respect `.ariadneignore` and privacy policies;
- expose status and errors;
- never capture secrets or ignored files.

Repository task data remains captured through existing Ariadne mechanisms.
Knowledge indexing observes it through an explicit projection/update pipeline
so passive task capture remains reliable if the LLM provider is unavailable.

### 3.11 Human review system

Review records should support:

- unresolved/resolved/reopened states;
- predefined actions: accept, reject, edit, merge, skip, research, create
  task, label;
- generated rationale and evidence;
- suggested search queries;
- source/page/task references;
- bulk resolution;
- audit trail;
- no arbitrary LLM-provided action execution.

Review is asynchronous. It must not block ingestion or make an LLM-generated
claim authoritative without an explicit policy allowing auto-acceptance.

### 3.12 Deep research

Provide an optional research pipeline:

- generate domain-aware research topics from purpose, overview, graph gaps,
  and selected evidence;
- generate multiple editable search queries;
- support Tavily, SerpApi, SearXNG, and a generic provider interface;
- fetch and normalize results;
- ingest results as ordinary sources;
- synthesize a cited research page;
- link results to the initiating gap/insight/task;
- require confirmation before external searches;
- enforce provider timeouts, rate limits, and redaction;
- support local/offline mode with research disabled.

Research must be represented as an Ariadne task or child task when it creates
substantial work, preserving the task-memory model.

### 3.13 Chat and answer generation

Add a knowledge-aware chat service rather than a second chat product:

- persistent conversations;
- rename/delete/create;
- configurable history depth;
- hybrid or source-only retrieval;
- page/source citations;
- graph and task tools;
- optional web research tool;
- streaming response events;
- cancellation and timeout;
- regenerate last answer;
- save answer as a query/synthesis page;
- export generated workspace files;
- Mermaid and math rendering delegated to existing UI capabilities or safe
  renderers;
- thinking/reasoning display only when the provider explicitly emits it and
  policy permits showing it.

The shared core should expose a provider-neutral agent contract. CLI/MCP/VS
Code/dashboard adapters decide how conversations are presented.

### 3.14 Agent skills

Support local/project/user skill discovery:

- scan configured `SKILL.md` locations;
- validate metadata;
- enable/disable skills;
- select a skill for a conversation;
- expose skill instructions only when selected;
- provide structured input requests;
- record skill use in the operation log;
- prevent skills from bypassing Ariadne approval and redaction policies.

This should integrate with Ariadne's existing skill-template and MCP
architecture rather than copying the reference app's runtime wholesale.

### 3.15 Media and generated outputs

Support:

- extracted source images;
- generated captions;
- local media references;
- image preview/lightbox in UI adapters;
- generated Markdown, HTML, diagrams, and other workspace files;
- output provenance and cleanup;
- safe path confinement to the project workspace.

Binary content must be stored outside SQLite with hashes and metadata.

### 3.16 Local API and MCP

Expose a local, token-protected API only if it provides value beyond the
existing MCP server. The preferred order is:

1. shared core service contracts;
2. MCP tools/resources;
3. optional loopback HTTP adapter for browser extensions and external tools.

Planned MCP capabilities:

- project list/get/configure;
- source list/import/rescan/delete;
- queue status/cancel/retry;
- page list/read/write/rebuild;
- search by mode;
- graph neighborhood/path/explain;
- insights and reviews;
- resolve review items;
- start/cancel research;
- chat;
- export/import;
- create/resume/link Ariadne tasks.

All read tools should support citation/provenance output. Mutating tools
should require explicit names and validate paths, IDs, and policy.

### 3.17 Chrome/web clipper

Treat a browser clipper as a later adapter, not a prerequisite for the core.
The core contract must support a clip payload:

- URL;
- title;
- extracted Markdown;
- selected metadata;
- capture timestamp;
- target project;
- optional screenshot/media references.

The first adapter can be a CLI/MCP URL import. A browser extension can be
added without changing the ingestion model.

### 3.18 Internationalization and provider configuration

Provider configuration must support:

- OpenAI-compatible endpoints;
- Anthropic;
- Google;
- Ollama/local models;
- custom HTTP providers;
- separate chat, analysis, generation, embedding, vision, and transcription
  model selections;
- custom headers with secret storage;
- timeout/retry settings;
- language preference;
- model capability declarations.

Secrets must remain in environment variables or a platform secret store and
must never enter project exports, task captures, logs, or generated pages.

## 4. Ariadne reuse and required extensions

### Reuse directly

- `TaskStore`, migrations, and SQLite/WAL handling.
- `ContextBuilder` token budgeting and ranking interfaces.
- `Search` as the task-search foundation.
- `Graphify.ts` as an optional repository graph adapter.
- `Exporter` patterns and source-linked Markdown rendering.
- `Redactor` for commands, URLs, provider payloads, and research logs.
- `GitWatcher`, file capture, workspace identity, and cross-workspace registry.
- existing CLI command routing.
- MCP server tool/resource registration.
- VS Code webview bridge and panels.
- dashboard API/auth/session conventions.
- existing cloud-sync model for future project/knowledge synchronization.

### Extend or introduce

- `KnowledgeStore`: structured pages, page versions, provenance, aliases,
  relationships, source records, graph snapshots, insights, reviews, queue,
  project config, and conversations.
- `SourceIngestor` and format-specific adapters.
- `KnowledgeAnalyzer` and `KnowledgeGenerator` provider contracts.
- `IngestQueue`.
- `KnowledgeSearch` and hybrid retrieval.
- `KnowledgeGraph`.
- `ResearchService`.
- `ReviewService`.
- `KnowledgeExporter` and archive importer.
- `KnowledgeProject`/configuration service.
- provider registry and capability negotiation.

Do not overload `TaskStore` with document/wiki concerns. Use shared IDs and
foreign-key-like provenance references between the two domains.

## 5. Proposed data model

The schema should be introduced through additive migrations. Suggested tables:

### Project and configuration

- `knowledge_projects`
- `knowledge_project_roots`
- `knowledge_settings`
- `knowledge_provider_profiles`
- `knowledge_schema_versions`

### Sources and extraction

- `knowledge_sources`
- `knowledge_source_versions`
- `knowledge_source_assets`
- `knowledge_source_spans`
- `knowledge_extractions`

### Pages and provenance

- `knowledge_pages`
- `knowledge_page_versions`
- `knowledge_page_sources`
- `knowledge_page_provenance`
- `knowledge_page_aliases`
- `knowledge_page_links`

### Graph and analysis

- `knowledge_graph_nodes`
- `knowledge_graph_edges`
- `knowledge_graph_snapshots`
- `knowledge_communities`
- `knowledge_insights`

### Operations

- `knowledge_jobs`
- `knowledge_job_events`
- `knowledge_reviews`
- `knowledge_review_actions`
- `knowledge_research_runs`
- `knowledge_research_results`
- `knowledge_conversations`
- `knowledge_messages`
- `knowledge_outputs`
- `knowledge_operation_log`

Every table needs workspace/project scoping, timestamps, stable IDs, and
retention/export semantics. Large content should use content-addressed files
with metadata rows rather than unbounded SQLite blobs.

## 6. Generated workspace format

Recommended default:

```text
.ariadne/
  state.db
  knowledge/
    manifest.json
    index.json
    graph.json
    graph/
      snapshots/
    pages/
      concepts/
      entities/
      architecture/
      decisions/
      failures/
      workstreams/
      sources/
      synthesis/
      queries/
    sources/
      metadata/
      extracted/
      media/
    exports/
    log.md
    index.md
    overview.md
    schema.md
    purpose.md
```

The exact directory can be configurable, including a project-level directory
outside `.ariadne`, but the default should keep generated state clearly
separate from source files and make it easy to ignore generated artifacts.

Obsidian compatibility should be an export option:

- emit Markdown links and optional frontmatter;
- optionally generate `.obsidian` configuration;
- never require Obsidian for search, graph, review, or chat.

Potential replacements for the primary UI:

- existing VS Code panels for developers;
- existing dashboard for browser access and operations;
- generated static HTML/Markdown export for portable browsing;
- optional future desktop shell only after core/API contracts stabilize.

## 7. API and surface plan

### Core package

Add typed service interfaces and implementations in `packages/core`:

- project lifecycle;
- source ingestion;
- queue;
- page CRUD/versioning;
- search/retrieval;
- graph traversal/analysis;
- reviews;
- research;
- chat/provider abstraction;
- export/import.

All interfaces should be usable without an LLM provider for deterministic
operations.

### CLI

Proposed command groups:

```text
ariadne knowledge project ...
ariadne knowledge source add|list|rescan|remove ...
ariadne knowledge ingest ...
ariadne knowledge queue status|cancel|retry ...
ariadne knowledge page list|show|rebuild|export ...
ariadne knowledge search ...
ariadne knowledge graph path|neighbors|explain|insights ...
ariadne knowledge review list|resolve|reopen ...
ariadne knowledge research ...
ariadne knowledge chat ...
ariadne knowledge export|import ...
```

Short aliases should be considered only after the long forms are stable.

### MCP

Expose the same operations as explicit typed tools/resources. Avoid exposing
raw SQL, arbitrary filesystem reads, unrestricted shell execution, or provider
secrets.

### VS Code

Initial panels:

- Knowledge overview;
- source and ingest queue activity;
- search results with citations;
- page preview;
- graph/insights;
- review queue;
- research confirmation/progress.

The extension should remain a thin adapter over core/MCP-style service calls.

### Dashboard

Add project/knowledge pages only after the core contract and MCP surface are
stable. Reuse existing auth, API guards, task pages, operations logging, and
responsive layout patterns.

## 8. Graph implementation decision

### Recommendation

Implement a native `KnowledgeGraph` in TypeScript backed by SQLite tables and
exportable JSON. Use Graphify as:

- a repository/code extraction adapter;
- a compatibility command for existing users;
- an optional external graph build for large codebases;
- a migration source for graph data where useful.

### Why not make Graphify the complete foundation?

- Ariadne needs task/checkpoint/file/commit provenance edges that are not
  naturally represented by a codebase-only graph.
- The graph must be incrementally updated from SQLite events.
- The graph must support review, confidence, contradictions, and source
  citations.
- A native engine avoids a Python runtime dependency for ordinary Ariadne use.
- Existing Graphify output can still be imported or linked.

### Algorithmic phases

1. Explicit edge extraction from page links and provenance.
2. Weighted relevance calculation.
3. Optional semantic edge generation.
4. Community detection.
5. Cohesion/bridge/gap analysis.
6. Snapshot and insight persistence.

For the first implementation, use a well-tested JavaScript graph library only
if it materially reduces risk; otherwise implement bounded traversal and
scoring over indexed SQLite rows. Avoid introducing a graph database until
measurements show SQLite is insufficient.

## 9. Security, privacy, and trust model

- Redact secrets before persistence, indexing, provider calls, or export.
- Apply `.gitignore`, `.ariadneignore`, file-size, binary, and workspace-root
  policies before ingestion.
- Never send ignored or suspected-secret files to an LLM.
- Keep external research disabled by default until configured.
- Bind optional HTTP API to loopback only.
- Require a token for API/MCP bridges.
- Validate project IDs, source paths, URLs, archive entries, and generated
  output paths.
- Confine generated files to the configured workspace.
- Treat imported documents, web pages, and generated content as untrusted
  instructions; they are evidence, not authority.
- Do not execute commands, skills, or review actions solely because an
  ingested document requested it.
- Store provider credentials outside SQLite and scrub them from diagnostics.
- Make every generated claim traceable to evidence or explicitly label it as
  inferred/ambiguous.
- Add export redaction and archive validation tests.

## 10. Failure handling and operational behavior

- Provider unavailable: deterministic capture, indexing, and task memory
  continue; queued LLM jobs remain pending or retryable.
- Parser failure: source becomes `failed` with a user-visible reason and
  retry action; prior generated pages remain intact.
- Partial generation: commit page versions atomically at the job boundary.
- Crash during job: recover `running` jobs to `pending` after a lease timeout.
- Stale source: mark dependent pages stale and surface an insight.
- Deleted source: remove only source-specific pages; preserve shared concepts
  with updated provenance.
- Conflicting page edits: create a review item rather than silently overwrite.
- Corrupt archive: reject before writing any project state.
- Search/index lag: expose index status and return last-known results with
  freshness metadata.
- Long-running chat/research: support cancellation and bounded timeouts.

## 11. Testing strategy

### Unit tests

- source identity and hashing;
- path/privacy policy;
- format parsers;
- frontmatter and Markdown rendering;
- provenance mapping;
- page version merge;
- queue transitions/retry/recovery;
- graph scoring/traversal/community metrics;
- search ranking and token budgets;
- review action validation;
- provider adapters and timeout handling;
- archive manifest and migration validation.

### Integration tests

- ingest source -> analysis -> generation -> page/index/graph update;
- incremental no-op ingest for unchanged sources;
- source modification and deletion cascade;
- task mutation -> knowledge projection;
- search with page/source/task citations;
- review resolution and page regeneration;
- research result -> source ingest -> synthesis page;
- MCP tool/resource behavior;
- CLI commands against an isolated workspace;
- concurrent SQLite readers/writers and queue workers.

### UI tests

- VS Code panels render loading, empty, progress, success, failure, and
  stale states;
- dashboard auth and project boundaries;
- citations open the correct source/page/task;
- review actions require confirmation where appropriate;
- graph interaction selects/highlights insights;
- responsive layouts;
- accessibility for dialogs, tables, tree navigation, and progress states.

### End-to-end scenarios

1. Import a repository and docs, generate knowledge, search a concept, inspect
   provenance, and resume the related task.
2. Modify a source, verify incremental rebuild and stale-page handling.
3. Delete a source, verify cascade cleanup while shared concepts survive.
4. Discover a graph gap, approve research, ingest results, and resolve review.
5. Export/import a project on another workspace and rebuild indexes.
6. Run with no model configured and verify deterministic features remain usable.
7. Attempt secret/ignored-file ingestion and verify rejection/redaction.

Target 80%+ coverage for new core code, with higher coverage for migrations,
security boundaries, queue state transitions, and export/import.

## 12. Delivery phases

### Phase 0 — contracts and foundations

- Freeze capability matrix and compatibility policy.
- Add schema/migration strategy.
- Define IDs, provenance, project manifest, page metadata, and provider
  interfaces.
- Add feature flag/configuration with the feature disabled by default.
- Define deterministic operation log and event hooks.

**Exit:** contracts reviewed; existing Ariadne tests remain green.

### Phase 1 — project, source, and export foundation

- Implement project lifecycle and settings.
- Implement source registry, hashing, policies, and format adapter interface.
- Add Markdown/plain-text/code/task-history ingestion.
- Implement generated workspace manifest/index/overview/log.
- Implement export/import skeleton.

**Exit:** deterministic sources produce traceable pages and portable archives.

### Phase 2 — queue and two-stage generation

- Implement persistent queue and recovery.
- Add analysis and generation provider contracts.
- Add structured extraction result schema.
- Add page versioning and atomic generation.
- Add review records and operation events.

**Exit:** provider-backed generation is resumable, retryable, and auditable.

### Phase 3 — search and native graph

- Generalize search across pages, sources, tasks, and provenance.
- Add optional embeddings/vector provider.
- Implement native graph, scoring, traversal, communities, bridge nodes,
  cohesion, and insights.
- Import/link Graphify output where useful.

**Exit:** hybrid search and graph queries return citations and confidence.

### Phase 4 — review, deletion, watching, and media

- Add source watcher and folder import.
- Add deletion cascade and stale-page reconciliation.
- Add images/media metadata and optional vision/transcription adapters.
- Add complete review workflow and bulk actions.

**Exit:** corpus changes remain synchronized without destructive surprises.

### Phase 5 — research and chat

- Add research provider interfaces and confirmation workflow.
- Add persistent conversations, streaming, citations, and save-to-page.
- Add agent tools, generated outputs, skill discovery, and structured inputs.

**Exit:** knowledge-aware chat can search, explain, research, and create
  traceable outputs without bypassing policy.

### Phase 6 — CLI and MCP

- Expose stable commands and typed tools/resources.
- Add task/knowledge cross-links and task creation from insights.
- Add local HTTP adapter only where browser/extension integration requires it.

**Exit:** all core features are usable without VS Code.

### Phase 7 — VS Code and dashboard

- Add overview, source activity, search, page preview, graph, insight,
  review, and research panels.
- Add dashboard project and knowledge views.
- Add API guards, permissions, and operational telemetry.

**Exit:** existing Ariadne users can discover and operate knowledge features
  in familiar surfaces.

### Phase 8 — migration, compatibility, and polish

- Add Obsidian export/import compatibility.
- Add Graphify compatibility/import documentation.
- Add optional browser clipper.
- Add localization and provider UX.
- Performance test large repositories and source corpora.
- Document backup, recovery, privacy, and upgrade behavior.

**Exit:** release candidate with migration and rollback procedures.

## 13. Proposed package/file boundaries

Likely additions:

```text
packages/core/src/knowledge/
  KnowledgeProjectStore.ts
  KnowledgeSourceStore.ts
  KnowledgePageStore.ts
  KnowledgeGraph.ts
  KnowledgeSearch.ts
  KnowledgeQueue.ts
  KnowledgeReview.ts
  KnowledgeResearch.ts
  KnowledgeExporter.ts
  KnowledgeProviders.ts
  KnowledgeTypes.ts
  ingest/
  providers/
  formats/
  graph/
  render/
  migrations/

packages/cli/src/knowledge/
packages/mcp-server/src/knowledge/
packages/vscode-extension/src/knowledge/
packages/vscode-extension/webview-ui/src/panels/Knowledge*
packages/dashboard/src/knowledge/
```

These are targets, not a mandate to create every file. Keep modules focused
and reuse existing package patterns.

## 14. Migration and compatibility

### Existing Ariadne data

- Existing tasks remain unchanged.
- A project bootstrap command creates knowledge metadata.
- Existing tasks/checkpoints/files/commits are projected as sources and
  provenance without rewriting their original records.
- Existing exports remain valid.

### Existing Graphify usage

- Preserve `ariadne graphify` passthrough.
- Add an adapter/import path for graphify JSON where practical.
- Do not make Graphify installation mandatory for knowledge features.

### Obsidian

- Provide Markdown export with wikilinks/frontmatter.
- Provide optional import of compatible Markdown pages.
- Treat imported pages as sources or reviewed pages until reconciled.
- Do not add Obsidian runtime/configuration to the core.

### Reference-project data

Do not copy GPLv3 source code or implementation details into Ariadne's MIT
codebase. Reimplement interfaces and behavior independently, and document
compatibility at the feature level.

## 15. Performance and scale targets

Initial targets:

- open/search existing task data with no measurable regression;
- deterministic ingest of 10,000 text/code files without an LLM;
- incremental rebuild processes only changed sources;
- queue progress visible within one second of job state changes;
- lexical search returns within 250 ms for a medium workspace;
- graph neighborhood/path queries return within 500 ms for a medium graph;
- no UI blocks on parsing, indexing, graph clustering, research, or generation;
- bounded memory use for large documents and media;
- all expensive operations cancellable.

Measure before introducing LanceDB, a graph database, Rust, or a new daemon.

## 16. Open decisions to resolve before implementation

1. Which source formats are required in the first release versus adapters
   staged later?
2. Which LLM providers are officially supported at launch?
3. Should task history be auto-indexed continuously or only on checkpoint/
   explicit build?
4. What is the default generated workspace location and gitignore policy?
5. Is a local HTTP API required in the first release, or is MCP sufficient?
6. Which dashboard/VS Code panels are launch-critical?
7. Should external research be enabled per project, per workspace, or globally?
8. What is the retention policy for raw imported sources and research results?
9. Which generated page changes can be auto-accepted?
10. What corpus size should trigger background clustering or a no-cluster mode?

Recommended defaults:

- task-history projection on checkpoint and explicit build;
- generated knowledge ignored by default, with explicit export;
- MCP first, loopback HTTP second;
- external research disabled by default;
- no auto-acceptance for contradictions or destructive deletion;
- deterministic features available without a provider;
- SQLite first, external databases only after measurements.

## 17. Definition of done for the full feature

The feature is complete when:

- all capability groups in §3 have a tested core contract;
- a project can ingest supported source types with content hashes and
  provenance;
- two-stage generation creates versioned, cited pages and indexes;
- queue recovery, cancellation, retry, and deletion behavior are tested;
- hybrid search and graph traversal provide source/task citations;
- insights and reviews are actionable and auditable;
- research and chat are optional, policy-bound, and cancellable;
- CLI and MCP expose the complete core surface;
- VS Code and dashboard provide the agreed launch experience;
- export/import and Obsidian-compatible Markdown work;
- existing Ariadne task workflows remain backward compatible;
- security, redaction, migration, and failure tests pass;
- documentation explains setup, providers, privacy, recovery, and limitations.

## 18. Recommended implementation order

Do not start by building the graph visualization or chat UI. Start with:

1. IDs, provenance, project manifest, and migrations.
2. Source registry, hashing, policy, and deterministic ingestion.
3. Page/version/index rendering.
4. Persistent queue and provider contracts.
5. Search and native graph APIs.
6. Reviews, deletion, and stale reconciliation.
7. Research/chat/skills.
8. CLI/MCP.
9. VS Code/dashboard.
10. Compatibility exports, clipper, and polish.

This order ensures every later surface consumes stable, testable contracts and
that the system remains useful even when no LLM or external service is
configured.
