# Knowledge migration and archive format

This document describes the implemented migration path for moving an Ariadne
knowledge project between workspaces or into an Obsidian vault.

> **Status:** archive export/import is implemented; the reader accepts archive
> versions `1` and `2`. There is no background sync, live Obsidian integration, or provider-secret
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

The provider-profile table is privacy-omitted in current exports, not a
portable provider configuration. Credentials, tokens, and provider setup
must be configured again at the destination. Host-local settings, feedback,
and derived indexes/models are also intentionally excluded.

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

Import validates the complete archive structure before writing database rows:

- `manifest.json` and `project.json` must describe the same non-empty project id
- `knowledge_projects` must contain exactly one row for that same project
- every project-scoped row must stay in that project
- direct and indirect same-project references must resolve inside the archive
- unknown/missing columns and duplicate archive identities are rejected
- every required table export must be present
- every archived file must be declared in the manifest, and file-backed
  knowledge content is restored from the archive before the import commits
- safe relative paths, file presence, sizes, and checksums must all match
- exported archives redact `workspace_root`; imports always rewrite it to the
  current local workspace root

```bash
ariadne knowledge import <project-id> knowledge-export
```

The command uses the project id recorded in the archive. The positional
`<project-id>` is retained for CLI compatibility, but it must exactly match the
manifest project id; import never rewrites the archive to a different project.
Import fails if that project already exists. Use `--replace` only when
intentionally replacing the same project id:

```bash
ariadne knowledge import <project-id> knowledge-export --replace
```

Replacement is transactional and replaces the database project rows. It does
not delete unrelated projects, task history, or files outside the imported
archive. Importing does not restore provider credentials or execute queued
research/chat jobs.

## Archive versions and host-local state

The manifest is version `1` unless the project has data only version `2` can
carry (for example a V2 chat payload). The core `manifestVersion` option
(`1`, `2`, or `'auto'`; the CLI uses `'auto'`) controls this.
An explicit version `1` for such a project fails with
`manifest_version_incompatible` instead of dropping data.

Version `2` manifests add a `compatibility` block (required and optional
feature ids, per-table SHA-256 fingerprints, and omission declarations) and
may carry optional Ed25519 `authenticity` metadata that is verified locally
only when the caller supplies a verifier. Every knowledge table has one archive
class (`required`, `optional`, `derived-rebuild`, `host-local`,
`privacy-omitted`); archives containing derived, host-local, or privacy-omitted
table files, unclassified tables, unknown required features, or `host.*`
settings rows are rejected.

Grounded semantic summaries (`knowledge_semantic_summaries`, optional feature
`knowledge-semantic-summaries-v1`) travel in version `2` archives with
`provider_profile_name` always exported as `NULL`; import rejects a non-null
name, an unresolvable `scope_id` (it must reference a source version, page
version, or the project inside the archive), and malformed or oversized summary
or warning JSON. An archive without the table imports with an
`optional_table_absent` warning, and summaries can be rebuilt on demand. Chat
message payloads with a `synthesis` block are validated strictly on import.

Host-local `host.*` settings are never exported, imported, or echoed in
errors. `--replace` preserves the target project's `host.*` settings, provider
profiles, and other privacy-omitted rows, and clears its derived search rows.
Derived search data is never imported: after import, `postImport.rebuildRequired`
lists `search_index` and `semantic_model`, and a `derived_data_rebuild_required`
warning is returned until those are rebuilt locally.

## Cross-workspace procedure

1. Export from the source workspace to a dedicated directory.
2. Move or copy that directory through your approved local transfer method.
3. In the destination workspace, build/run the same Ariadne version or a
   reader that supports the archive's actual manifest version and required
   features (current readers support versions `1` and `2`).
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
- Archive import restores database rows and declared immutable knowledge
  content artifacts under the local knowledge directory. It does not
  reconstruct the working repository's original source files or Git history.
  Re-ingest original sources when you want to analyze changes at the
  destination.
- Queued work is metadata. Import does not run providers or make network
  calls.
- Obsidian export does not provide two-way synchronization, conflict
  resolution, backlinks indexing, or automatic page ingestion.

For a privacy-preserving transfer, inspect `manifest.json`, the rendered
Markdown, and `data/` files before sharing. Redaction reduces common secret
leaks but is not a substitute for human review.
