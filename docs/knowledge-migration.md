# Knowledge migration and archive format

This document describes the implemented migration path for moving an Ariadne
knowledge project between workspaces or into an Obsidian vault.

> **Status:** archive export/import is implemented at archive version `1`.
> There is no background sync, live Obsidian integration, or provider-secret
> migration. Those surfaces remain in progress.

## What is migrated

`ariadne knowledge export` writes a portable directory containing:

```text
manifest.json
project.json
data/*.json
pages/<page-type>/<slug>.md
graph.json
```

The data files contain the project-scoped knowledge tables: source and page
versions, provenance, links, graph nodes/edges, insights, jobs, reviews,
research records, conversations/messages, outputs, and the operation log.
Markdown pages are rendered from the current page versions. The manifest
records the archive format, project id, generated time, every file's size,
media type, and SHA-256 checksum.

Provider profile metadata is included only after removing
`configuration_json`. The manifest explicitly lists
`knowledge_provider_profiles.configuration_json` as omitted. Credentials,
tokens, and provider prompts must be configured again at the destination.

With `--obsidian`, the exporter additionally writes:

```text
.obsidian/app.json
```

Page links are rendered as `[[page-slug|title]]`, so the exported Markdown can
be opened as an Obsidian vault. This is a one-way compatible export: Ariadne
does not watch the vault or import arbitrary edits as page versions.

## Export

Run from the workspace containing the project:

```bash
ariadne knowledge project list
ariadne knowledge export <project-id> knowledge-export
ariadne knowledge export <project-id> knowledge-vault --obsidian
```

The output path is resolved relative to the current workspace. Existing files
at the target path may be overwritten, so choose a dedicated directory and
review it before sharing or opening it in another application.

## Import

Import validates `manifest.json`, archive version, safe relative paths, file
presence, sizes, and checksums before writing database rows:

```bash
ariadne knowledge import <project-id> knowledge-export
```

The command uses the project id recorded in the archive. The positional
`<project-id>` is retained for CLI symmetry and workspace context; it does not
rewrite the archive's project id. Import fails if that project already exists.
Use `--replace` only when intentionally replacing the same project id:

```bash
ariadne knowledge import <project-id> knowledge-export --replace
```

Replacement is transactional and replaces the database project rows. It does
not delete unrelated projects, task history, or files outside the imported
archive. Importing does not restore provider credentials or execute queued
research/chat jobs.

## Cross-workspace procedure

1. Export from the source workspace to a dedicated directory.
2. Move or copy that directory through your approved local transfer method.
3. In the destination workspace, build/run the same Ariadne version or a
   version that supports archive version `1`.
4. Import without `--replace` first; resolve duplicate project ids deliberately.
5. Reconfigure any provider integration outside the archive.
6. Review pending reviews, queued jobs, source roots, and page provenance.

The archive is project-scoped. It does not migrate the workspace's task
database, global task registry, git history, `.github` configuration, or
cloud-sync credentials.

## Safety checks and limitations

- Absolute paths, `..` segments, malformed normalized paths, missing entries,
  size mismatches, checksum mismatches, and unsupported archive versions are
  rejected.
- Provider configuration payloads are never restored because they are never
  exported.
- Archive import restores database rows; it does not copy source files into
  the destination workspace. Re-ingest a source if the referenced source
  content is unavailable.
- Queued work is metadata. Import does not run providers or make network
  calls.
- Obsidian export does not provide two-way synchronization, conflict
  resolution, backlinks indexing, or automatic page ingestion.

For a privacy-preserving transfer, inspect `manifest.json`, the rendered
Markdown, and `data/` files before sharing. Redaction reduces common secret
leaks but is not a substitute for human review.
