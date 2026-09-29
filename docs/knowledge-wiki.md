# Ariadne knowledge workspace

The knowledge workspace is Ariadne's **core-first, local-first** knowledge
surface. It stores project configuration, source metadata and versions,
generated Markdown pages, provenance, review decisions, a native graph, and
bounded work queues in the same `.ariadne/state.db` used for task history.
The CLI and MCP server are adapters over this shared core; they do not keep
separate knowledge stores.

> **Status:** project/source/page/search/graph/review/queue storage and the
> archive exporter are implemented. Provider-backed research and chat are
> explicit integration points, not turnkey hosted features. The CLI currently
> has no persisted provider configuration, so those commands fail with a
> provider-required result rather than making an implicit network call. MCP
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
- the current CLI does not persist provider credentials or profiles;
- the MCP knowledge adapter queues research/chat requests and does not invoke a
  network provider itself.

Do not put provider keys in project files or exported archives. Provider
profiles are stored as a dedicated table for future/configured integrations,
but archive export omits `configuration_json` and includes only redacted
profile metadata. Provider setup UX and durable credential management remain
**in progress**.

## CLI workflow

Build the workspace from source, then use the knowledge command tree:

```bash
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/cli build

ariadne knowledge project create "Ariadne wiki" --roots src,docs
ariadne knowledge source scan <project-id> docs
ariadne knowledge ingest file <project-id> docs/02-ARCHITECTURE.md
ariadne knowledge page list <project-id>
ariadne knowledge search <project-id> "workspace scope"
ariadne knowledge graph neighborhood <project-id> <node-id>
ariadne knowledge review list <project-id> --status pending
```

Useful command groups are `project`, `source`, `ingest`, `queue`, `page`,
`search`, `graph`, `review`, `research`, `chat`, `export`, and `import`.
Use `--json` for scripting. Mutating MCP calls require `confirm=true`; the CLI
uses its normal local command authorization.

`knowledge research` and `knowledge chat send` are visible commands, but they
are active/in-progress surfaces until a provider is registered by the caller.
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
