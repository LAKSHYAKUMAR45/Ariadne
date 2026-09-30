# Offline-First Knowledge Worker Design

## Status

Approved design for resolving the knowledge-analysis queue blocker discovered
during the NAAS acceptance test.

## Context

Ariadne can register knowledge sources, enqueue analysis jobs, project tasks
into pages, import Graphify data, search stored metadata, review generated
pages, and export portable archives. The NAAS acceptance test demonstrated
that these surfaces work, but also exposed a missing execution layer:

- 58 `analyze` jobs remained queued indefinitely.
- The CLI can claim a job but cannot process it.
- Search falls back to matching source paths because no extracted content,
  spans, or generated source pages exist.
- Native graph traversal works, but imported Graphify edges lose relationship
  types and source provenance.
- Provider-profile storage exists, but the CLI has no safe provider
  configuration or execution path.

The existing analysis and generation interfaces validate structured provider
output, and `KnowledgeGeneratorService` can atomically persist rendered pages.
No service currently connects source versions, analyzers, graph persistence,
page generation, and queue completion.

## Goals

1. Process queued knowledge jobs reliably from the CLI and reusable core APIs.
2. Produce useful search, pages, citations, and graph data without requiring an
   external model.
3. Allow configured providers to enrich deterministic results without making
   them authoritative for source facts.
4. Preserve exact source-version and line-span provenance.
5. Make processing idempotent, resumable, project-scoped, observable, and safe.
6. Support future hosting by the sync server, VS Code, or a system service
   without duplicating processing logic.

## Non-Goals

- Building a general distributed job system.
- Persisting API keys or other provider secrets in SQLite.
- Requiring an LLM for baseline code or text indexing.
- Replacing the current queue schema with an external broker.
- Supporting every language parser in the first increment.
- Automatically accepting provider-generated claims without source evidence.

## Selected Approach

Implement an offline-first hybrid `KnowledgeWorker`.

Deterministic extraction is the guaranteed baseline and the authoritative
source for paths, symbols, structural relationships, and spans. Provider-backed
analysis and generation are optional enrichment stages. A missing, unavailable,
or invalid provider must not prevent deterministic source processing from
completing successfully.

This is preferred over a provider-only worker because Ariadne is local-first
and must remain useful without credentials or network access. It is preferred
over Copilot-driven queue processing because queue draining must work
unattended and independently of an interactive agent session.

## Architecture

### KnowledgeWorker

Add a core `KnowledgeWorker` service responsible for orchestration only. It
must:

- claim the next eligible job for a specified project;
- recover expired leases before claiming new work;
- renew the active lease during long operations;
- dispatch supported job kinds through registered handlers;
- emit durable progress events;
- observe cancellation between stages;
- complete jobs only after all required writes commit; and
- fail jobs with stable machine-readable failure codes.

The worker accepts its dependencies through explicit interfaces:

- `KnowledgeQueue`
- source-version loader
- deterministic analyzer registry
- extraction store
- native graph writer
- deterministic page builder
- `KnowledgeGeneratorService`
- optional provider enrichment service
- progress reporter

The core worker must not read process environment variables or vendor SDK
configuration directly. CLI or host adapters construct those dependencies.

### Project-Scoped Queue Claiming

Change queue claiming from workspace-global to project-scoped:

```ts
claim(projectId: string, workerId: string): KnowledgeJobRecord | null
```

The SQL selection and conditional update must both include `project_id`.
Existing callers must supply the project ID. This removes the current risk that
`knowledge queue claim <project-id>` processes a job belonging to another
project.

Lease renewal must verify both job ownership and running state. Expired jobs
are requeued through the existing recovery behavior before each drain cycle.

### Immutable Source-Version Loading

Jobs reference `source_version_id`. Processing must load that exact version,
not the current mutable workspace file.

The loader must:

1. resolve the source version and its project;
2. resolve and confine its recorded content path to approved Ariadne storage;
3. reject symlinks and path escapes;
4. enforce configured byte limits;
5. verify the stored content hash; and
6. return normalized content plus source metadata.

Hash mismatch, missing content, invalid confinement, or unsupported encoding are
permanent failures. The worker must not silently fall back to the current
source file.

### Deterministic Analyzer Registry

Introduce a registry selected by source kind, MIME type, and extension. The
first release supports:

- Python
- TypeScript/JavaScript
- Markdown
- plain text
- normalized text produced by existing document/media ingestors

The analyzer output uses a deterministic schema separate from provider prose:

```ts
interface DeterministicExtraction {
  analyzerId: string;
  analyzerVersion: string;
  sourceVersionId: string;
  title: string;
  summary: string;
  sections: ExtractedSection[];
  symbols: ExtractedSymbol[];
  relationships: ExtractedRelationship[];
  links: ExtractedLink[];
  diagnostics: ExtractionDiagnostic[];
}
```

Every section, symbol, relationship, and link must carry a source span when the
format supports positions. Spans use one-based line and column numbers with an
optional byte range.

#### Python Extraction

The Python analyzer extracts:

- module and import relationships;
- classes and inheritance;
- functions and methods;
- parameters and return annotations;
- decorators;
- docstrings;
- calls and symbol references that can be resolved within the file;
- assignment of simple constants; and
- exact definition and call-site spans.

The initial implementation may use a maintained parser library or a
well-isolated parser adapter, but its output must remain Ariadne-owned and
covered by fixtures. Parsing failures produce diagnostics and a text-only
fallback rather than an empty success.

#### TypeScript and JavaScript Extraction

The analyzer extracts imports/exports, classes, interfaces, functions, methods,
inheritance/implementation, calls, references, JSDoc, and definition spans.

#### Markdown and Text Extraction

Markdown extraction captures headings, heading hierarchy, paragraphs, lists,
code blocks, links, and wikilinks. Plain text is split into bounded,
line-addressable sections. Summaries are deterministic excerpts, not invented
prose.

### Extraction Persistence

Create an extraction store around `knowledge_extractions` and related span
tables. Persist:

- analyzer identity and version;
- normalized extraction JSON;
- source-version linkage;
- processing timestamp;
- warnings and diagnostics; and
- a deterministic extraction hash.

The idempotency key is:

```text
project_id + source_version_id + job_kind + analyzer_id + analyzer_version
```

Reprocessing an unchanged source version with the same analyzer version must
reuse or replace the same logical extraction without duplicating graph nodes,
page versions, or reviews.

Extraction persistence and graph updates occur in a database transaction.
Generated files and page versions continue to use the atomic staging behavior
in `KnowledgeGeneratorService`.

### Native Graph Materialization

Map deterministic symbols and relationships into `KnowledgeGraph`.

Nodes must preserve:

- stable identity derived from project, source version, symbol kind, qualified
  name, and definition span;
- node type;
- human-readable label and qualified name;
- source version and span provenance; and
- deterministic confidence of `1` for parser-confirmed facts.

Edges retain typed semantics such as:

- `imports`
- `exports`
- `defines`
- `contains`
- `inherits`
- `implements`
- `calls`
- `references`
- `links_to`

Each edge stores source evidence, relationship type, span provenance, and
confidence. Import adapters, including Graphify, must preserve known relation
types and provenance instead of converting every edge to `related_to`.
Unknown relation types may map to `related_to` while retaining the original
type in evidence metadata.

### Deterministic Pages

Generate baseline pages after deterministic extraction:

- one source page per source version;
- a symbol index for code sources;
- section headings and bounded excerpts;
- outbound and inbound graph links;
- diagnostics and parser warnings; and
- exact source citations.

The source page title, slug, and identity are stable across reruns. A new page
version is created only when rendered content changes.

The deterministic page builder emits a
`KnowledgeGenerationPayload` consumed by `KnowledgeGeneratorService`. It must
not write files directly.

### Search Indexing

Hybrid search must index:

- extracted sections and excerpts;
- symbol names and qualified names;
- deterministic source summaries;
- generated page content;
- task memory; and
- optional embeddings.

Results must include source-version IDs and exact spans. Path-only source
metadata remains a fallback but ranks below content and symbol matches.

The initial acceptance requirement is lexical and structural retrieval.
Embeddings remain optional.

### Optional Provider Enrichment

Provider enrichment runs after deterministic persistence.

An analyzer provider may add:

- natural-language summaries;
- source-backed claims;
- entity aliases;
- higher-level relationships;
- contradictions; and
- research gaps.

A generation provider may improve page prose and organization.

Provider output is untrusted and must pass the existing
`validateKnowledgeAnalysis` and `validateKnowledgeGeneration` contracts plus
these grounding requirements:

- every entity, claim, and relationship references known source versions;
- factual claims include at least one valid source span;
- relationship endpoints resolve to deterministic or already persisted nodes;
- no provider output can remove deterministic facts; and
- unsupported or ungrounded claims are rejected with a recorded diagnostic.

Provider timeout, absence, or invalid output records an enrichment warning and
still completes the job if deterministic processing succeeded.

### Provider Profiles and Secrets

Add a provider-profile service and CLI commands. Profiles persist only
non-secret configuration:

- profile name;
- provider kind;
- model;
- endpoint;
- capabilities;
- timeout;
- environment-variable names containing credentials; and
- enabled state.

Secret values are resolved by the host adapter from environment variables or a
future OS credential store. Secret values must never enter SQLite, job
payloads, exports, generated pages, logs, progress events, or exception text.

The first provider adapter should support OpenAI-compatible APIs. This covers
hosted compatible services and local servers such as Ollama or vLLM behind one
interface. Vendor-specific adapters can be added later.

Profiles require an explicit `test` operation before being enabled. Testing
must redact request and response diagnostics.

## CLI Design

Add:

```text
ariadne knowledge worker run <project-id> [--once|--watch]
  [--concurrency <n>] [--worker <id>] [--poll-ms <n>]

ariadne knowledge worker status <project-id>

ariadne knowledge provider add <project-id> <profile-name>
  --kind openai-compatible --endpoint <url> --model <model>
  --capabilities <csv> --api-key-env <name>

ariadne knowledge provider list <project-id>
ariadne knowledge provider test <project-id> <profile-name>
ariadne knowledge provider enable|disable <project-id> <profile-name>
ariadne knowledge provider remove <project-id> <profile-name>
```

`--once` drains currently eligible jobs and exits. `--watch` polls for new jobs
and recovers expired leases. Concurrency defaults to one and is bounded to
prevent unintentional resource exhaustion.

The existing `queue claim` command remains an inspection/debug surface but uses
project-scoped claiming. Normal users should run the worker rather than
manually claiming jobs.

## Job Lifecycle

For an `analyze` job:

1. Recover expired jobs for the project.
2. Claim the job using a project-scoped lease.
3. Load and verify the immutable source version.
4. Select and run the deterministic analyzer.
5. Persist extraction records and typed graph data transactionally.
6. Build and atomically generate deterministic pages.
7. Update search-visible records.
8. Run optional provider enrichment.
9. Create review candidates or insights only when their inputs changed.
10. Complete the job and clear the lease.

Progress events identify the stage and counts but must not contain full source
content or provider secrets.

## Failure Semantics

Stable failure codes include:

- `source_version_missing`
- `source_content_missing`
- `source_hash_mismatch`
- `source_path_rejected`
- `source_too_large`
- `unsupported_source`
- `parse_failed`
- `extraction_invalid`
- `graph_persist_failed`
- `generation_failed`
- `provider_timeout`
- `provider_invalid_response`
- `cancelled`

Transient provider and I/O failures may retry within configured limits.
Invalid paths, hash mismatches, unsupported formats, and validation failures are
permanent until the source or configuration changes.

If deterministic extraction and page generation succeed but enrichment fails,
the job completes with warnings. A separate enrichment job may be queued for a
later retry so baseline knowledge is never rolled back.

## Cancellation, Leases, and Concurrency

The worker checks cancellation:

- after source loading;
- after parsing;
- before database writes;
- before page generation; and
- before provider calls.

Long parser or provider operations receive an abort signal where supported.
Lease renewal occurs periodically at less than half the lease duration.
Failure to renew causes the worker to stop before committing further writes.

Multiple workers may process different jobs for the same project. Idempotency
and conditional queue transitions prevent duplicate durable output.

## Observability

`worker status` reports:

- queued, running, completed, failed, and cancelled counts;
- active workers and lease expiry;
- oldest queued job age;
- recent failure codes;
- deterministic versus enriched completion counts; and
- extraction/analyzer versions currently in use.

Command output and logs show identifiers, stages, counts, durations, and
redacted errors. They do not display source content or secret configuration.

## Integration Surfaces

### MCP

Expose worker status and bounded `run once` operations. Long-running watch mode
belongs to a host process, not an MCP request.

### VS Code

Show queue state, extraction progress, parser diagnostics, and enrichment
warnings. A project action may run the worker once.

### Dashboard

Admin-only knowledge views show worker health, queue counts, failures, and
provider-profile metadata. Mutations follow existing authorization and fresh
authentication requirements.

### Sync Server

The initial release does not synchronize knowledge data through task-memory
cloud sync. A later deployment may host the same core worker against a local
workspace database. Export/import remains the supported knowledge transfer
mechanism.

## Testing Strategy

Use test-driven development.

### Unit Tests

- project-scoped queue claim and conditional ownership;
- lease renewal and expiry recovery;
- source-version confinement and hash verification;
- Python extraction fixtures;
- TypeScript/JavaScript extraction fixtures;
- Markdown/text extraction fixtures;
- stable span and symbol identities;
- typed graph materialization;
- extraction idempotency;
- deterministic page rendering;
- provider-profile validation and redaction;
- provider fallback and invalid-response rejection;
- cancellation at every stage; and
- stable failure-code mapping.

### Integration Tests

- ingest to worker to extraction to graph to page to search;
- two projects with interleaved queues;
- concurrent workers;
- crash after extraction and before generation;
- rerun after analyzer-version change;
- last-good output preservation on failure;
- export/import of completed deterministic knowledge;
- optional local OpenAI-compatible test server; and
- MCP, VS Code, and dashboard adapters.

### NAAS Acceptance Test

Drain the existing 58 jobs for project
`project_01M3BMBTNR7N4MSWSTEAJHYFK3`, then rerun the ten independently
verified JCNR questions.

Acceptance criteria:

- all 58 jobs leave `queued`;
- no cross-project job is claimed;
- all supported sources have extraction records;
- search returns content excerpts rather than paths alone;
- at least 8 of 10 questions place a correct source in the top three;
- all factual results include exact source paths and line spans;
- graph paths retain relationship types and provenance;
- deterministic pages are generated without a provider;
- provider absence does not cause job failure;
- review and export flows include the generated pages and graph; and
- export checksums validate.

## Delivery Sequence

1. Project-scoped queue claim, lease renewal, and worker skeleton.
2. Immutable source-version loader and extraction persistence.
3. Python and Markdown/text deterministic analyzers.
4. Typed graph materialization and deterministic pages.
5. Search indexing with excerpts and spans.
6. TypeScript/JavaScript analyzer.
7. Provider profiles and OpenAI-compatible enrichment.
8. CLI, MCP, VS Code, and dashboard integration.
9. Full NAAS acceptance rerun and remediation.

Each increment must keep providerless operation functional and must preserve
existing task-memory behavior.

## Open Questions Resolved

- **Must a provider be configured?** No. Deterministic processing is required.
- **Are provider claims authoritative?** No. Deterministic source facts and
  validated provenance remain authoritative.
- **Where are secrets stored?** Outside SQLite, referenced by environment
  variable name.
- **Can a provider failure fail the whole job?** Not after deterministic
  output succeeds.
- **Does the worker read mutable source files?** No. It processes the immutable
  registered source version.
- **How are cross-project claims prevented?** Queue selection and update are
  both scoped by project ID.
- **What is the first provider protocol?** OpenAI-compatible HTTP.
