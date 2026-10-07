# Ariadne knowledge workspace

The knowledge workspace is Ariadne's **core-first, local-first** knowledge
surface. It stores project configuration, source metadata and versions,
generated Markdown pages, provenance, review decisions, a native graph, and
bounded work queues in the same `.ariadne/state.db` used for task history.
The CLI and MCP server are adapters over this shared core; they do not keep
separate knowledge stores.

> **Status:** project/source/page/search/graph/review/queue storage and the
> archive exporter are implemented. Provider-backed research and chat are
> explicit integration points, not turnkey hosted features. CLI worker provider
> profiles are implemented, but do not enable research/chat execution; those
> commands fail with a provider-required result rather than making an implicit
> network call. MCP
> queues research/chat work but does not execute a provider in its adapter.

## Workspace model

A knowledge project is scoped to one workspace root and may declare relative
source roots. The core records:

- **Projects** — active or archived collections with a workspace root and roots.
- **Sources** — files, URLs, task history, web clips, or manual sources, with
  content hashes and version history.
- **Pages** — typed Markdown pages (`overview`, `concept`, `entity`,
  `architecture`, `decision`, `source`, `failure`, `workstream`, `synthesis`,
  `comparison`, `query`, `gap`, and `review`) with versioned content.
- **Provenance** — source/page/task/checkpoint/decision/file/commit references
  attached to generated page versions.
- **Graph** — typed nodes and edges with bounded neighborhoods, paths,
  evidence, confidence, and provenance.
- **Reviews and jobs** — auditable review actions and bounded queued work.

Task history can be projected into a source and page with provenance:

```bash
ariadne knowledge project create "Ariadne wiki" --roots src,docs
ariadne knowledge project list
ariadne knowledge project-task <task-id> --project <project-id> --trigger checkpoint
```

The task projection is deterministic and redacts task text and sensitive-looking
paths before they are written to the knowledge store. It is a projection, not a
replacement for the task database.

## Provider setup and capability boundaries

The core provider registry is vendor-neutral. A provider declares one or more
capabilities: `chat`, `analysis`, `generation`, `embeddings`, `vision`,
`transcription`, or `research`. Provider calls have explicit capability checks,
optional timeouts, abort signals, and shared secret redaction.

The no-provider path is intentional:

- source scanning, ingestion, page storage, lexical search, graph traversal,
  reviews, task projection, export, and import work offline;
- embeddings are optional; search falls back to lexical ranking when no
  embedding provider is supplied;
- research requires an explicitly supplied research provider and consent;
- chat requires an explicitly supplied chat provider;
- the CLI stores worker profile metadata and environment-variable names, not
  credential values; those profiles do not wire research/chat execution;
- the MCP knowledge adapter queues research/chat requests and does not invoke a
  network provider itself.

Do not put provider keys in project files or exported archives. Provider
profiles are stored in a dedicated table for configured worker integrations.
Current portable archive export omits the entire provider-profile table.
Use the CLI `knowledge provider` commands described in
[knowledge-worker.md](knowledge-worker.md); public named-host transport and
turnkey research/chat execution remain incomplete.

## Answer synthesis and semantic summaries

Core exposes two deterministic-first services. The summary-building operations
remain core-only; CLI/MCP do not expose a command that creates or refines
summaries:

- `KnowledgeAnswerSynthesizer` turns search results into cross-file answers with
  sections (Answer, Supporting evidence, Open questions / ambiguity), per-claim
  citations, and reference-only evidence. Ambiguity from search is propagated as
  `ambiguous_evidence`/`insufficient_exact_spans` warnings. Chat uses it only when
  a caller passes `synthesis` options; other chat behavior is unchanged. The
  persisted `MessagePayloadV2.synthesis` block stores claims, citations, and
  warnings only, never prompts, responses, or excerpts.
- `KnowledgeSemanticSummaryStore` builds grounded source-version, page-version, and
  project summaries (migration 17, `knowledge_semantic_summaries`).

Provider assistance is optional. It uses only an existing reviewed provider
profile with the `generation` capability, chosen by explicit profile, then the
`host.provider.synthesis_profile` / `host.provider.summary_profile` setting (no
default profile is guessed). Requests are single-shot, bounded, and non-streaming; responses are
strictly validated and every claim or bullet must cite known evidence. Any
failure (`no_profile`, `profile_disabled`, `capability_missing`, `missing_credentials`, `timeout`,
`unsafe_endpoint`, `provider_error`, `invalid_response`) falls back to the
deterministic result with exactly one bounded warning.

## Cross-surface status and search confidence

The existing CLI worker status command and MCP `knowledge_worker_status` tool
include additive, project-scoped operational summaries:

- **Coverage** reports supported, partial, unsupported, failed, legacy-unknown,
  and deferred-relationship counts. It does not return analyzer diagnostics or
  source text.
- **Graph** reports node and edge counts.
- **Synthesis** reports summary counts by deterministic, provider-refined, and
  fallback-warning strategy.
- **Analytics** reports only whether opt-in analytics is enabled; query,
  feedback, and regression rows are not exposed in status.

CLI search JSON retains the core result fields, including confidence,
ambiguity details, and citations; human output prints confidence when it is
available and the citation references. MCP search keeps its existing
`{ data, citations }` result shape and includes confidence/citations in the
bounded result context. The dashboard search page validates and renders the
optional confidence/ambiguity fields alongside its existing citation list.

The VS Code extension implements a confirmed worker run-once palette command,
whose notification includes a warning count without diagnostic text. Other
knowledge palette actions open the task panel, but its current dispatcher
does not implement the corresponding knowledge requests. The dashboard has
knowledge overview/search/review UI components, including citation and
confidence rendering, but the standalone sync server does not mount their
knowledge API routes. Do not treat either set of frontend affordances as a
complete operational knowledge interface. Use CLI/MCP for local processing,
status, and retrieval.

Archive import returns a `derived_data_rebuild_required` warning and names the
local search-index and semantic-model rebuild targets. The CLI displays these
warnings in human mode as well as JSON. Worker execution and semantic-summary
generation retain their deterministic path when optional providers are
unavailable; provider assistance does not become a prerequisite for local
processing.

## CLI workflow

Build the workspace from source, then use the knowledge command tree:

```bash
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/cli build

ariadne knowledge project create "Ariadne wiki" --roots src,docs
ariadne knowledge source scan <project-id> docs
ariadne knowledge ingest file <project-id> docs/02-ARCHITECTURE.md
ariadne knowledge worker run <project-id> --once
ariadne knowledge page list <project-id>
ariadne knowledge search <project-id> "workspace scope"
ariadne knowledge graph neighborhood <project-id> <node-id>
ariadne knowledge review list <project-id> --status pending
```

Useful command groups are `project`, `source`, `ingest`, `queue`, `page`,
`search`, `graph`, `review`, `research`, `chat`, `export`, and `import`.
Use `--json` for scripting. Mutating MCP calls require `confirm=true`; the CLI
uses its normal local command authorization.

`knowledge research` and `knowledge chat send` are visible commands, but their
CLI provider-backed execution is not wired by adding worker profiles.
They return a clear provider-required error instead of silently falling back to
an unconfigured service.

## MCP usage

Start the MCP server with its working directory set to the target workspace:

```json
{
  "mcpServers": {
    "ariadne": {
      "command": "node",
      "args": ["/absolute/path/to/Ariadne/packages/mcp-server/dist/index.js"],
      "cwd": "/absolute/path/to/project"
    }
  }
}
```

Knowledge tools include:

- `knowledge_project_list`, `knowledge_project_create`,
  `knowledge_project_archive`;
- `knowledge_source_list`, `knowledge_source_get`,
  `knowledge_source_register`;
- `knowledge_queue_list`, `knowledge_queue_enqueue`,
  `knowledge_queue_cancel`;
- `knowledge_worker_status`, `knowledge_worker_run_once`;
- `knowledge_page_list`, `knowledge_page_get`, `knowledge_page_create`;
- `knowledge_search`, `knowledge_graph_neighborhood`,
  `knowledge_graph_path`;
- `knowledge_review_list`, `knowledge_review_resolve`;
- `knowledge_research`, `knowledge_chat`;
- `knowledge_export`, `knowledge_import`.

Read results are bounded and returned with citations. Writes require
`confirm=true`. `knowledge_export` writes/updates the project manifest in the
workspace knowledge directory; `knowledge_import` validates and reads that
manifest without importing untrusted content through the MCP adapter.

## Graphify compatibility

Graphify remains a separate tool. Ariadne's `graphify` CLI/MCP wrappers invoke
the installed `graphify` binary and do not reimplement Graphify's indexing or
query engine:

```bash
uv tool install graphifyy
ariadne graphify update .
ariadne graphify query "how does authentication work"
```

An existing Graphify JSON export can be imported into the native Ariadne graph:

```bash
ariadne knowledge graph import-graphify <project-id> graphify.json
```

The importer validates the Graphify shape, creates project-scoped nodes and
edges, preserves supported evidence/confidence, and reports rejected edges.
This is a compatibility bridge, not a claim that Ariadne and Graphify share a
database or graph format.

## Exporting to Markdown and Obsidian

Export is an explicit filesystem operation:

```bash
ariadne knowledge export <project-id> knowledge-export --obsidian
```

The directory contains `manifest.json`, project/table JSON data, rendered page
Markdown, `graph.json`, and—when `--obsidian` is supplied—`.obsidian/app.json`.
Rendered page links use Obsidian wiki-link syntax. The archive has checksums,
rejects unsafe paths, requires the CLI target id to match the manifest project
id exactly, and can be imported into another Ariadne workspace:

```bash
ariadne knowledge import <project-id> knowledge-export
# use --replace only when intentionally replacing the same project id
```

Provider configuration values are omitted from the export. Obsidian support is
an export format/configuration option, not a live two-way sync or an Obsidian
plugin. File watching, automatic vault synchronization, and conflict
resolution are **not implemented**.

## Privacy and trust boundaries

The knowledge workspace is local by default. `.ariadne/state.db` is the source
of truth and is gitignored by default. Nothing is sent to a provider or remote
service unless an integrating caller explicitly supplies a provider or uses an
opt-in network feature.

Before storing or exporting content, Ariadne:

- hashes source/page versions for change detection;
- scopes project operations to the configured workspace root;
- redacts known secret-shaped values in projected/provider-bound text;
- rejects sensitive-looking projected paths such as `.env`, token, credential,
  and password paths;
- validates archive checksums and rejects path traversal;
- keeps provider configuration values out of exported archives.

Source files and generated pages can still contain sensitive information that
does not match a known pattern. Review sources, pages, and export destinations
before sharing them. An export is a copy outside SQLite and should be handled
with the same care as the source material.
