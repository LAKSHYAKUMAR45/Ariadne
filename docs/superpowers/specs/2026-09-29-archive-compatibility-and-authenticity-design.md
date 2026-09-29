# Archive Schema Compatibility and Optional Authenticity Metadata Design

## Purpose

Evolve the knowledge archive format without breaking safe import/export or
weakening current fail-closed guarantees. Ariadne should support explicit
schema compatibility, reader-first upgrades, and optional authenticity metadata
while keeping checksum validation, path confinement, and project ownership
strict.

## Scope

This slice adds:

- a versioned compatibility block in the archive manifest;
- dual-read support for archive versions 1 and 2;
- optional authenticity metadata that can be verified locally when a verifier
  is available;
- additive warnings/results describing compatibility and authenticity state;
- a table classification registry (`required`, `optional`, `derived-rebuild`,
  `host-local`, `privacy-omitted`) covering every existing and new table, with
  row-level omission for host-local settings;
- explicit post-import rebuild reporting for derived data; and
- regression coverage for fail-closed imports and mixed-version behavior.

Shared contracts (classification of every table, the host-local `host.` settings
namespace, and slice ordering) are owned by
`2026-09-29-knowledge-backlog-contracts-design.md`. This slice reserves **no**
global migration; it is a format and importer/exporter change, and it lands
**first** in the backlog sequence, before any reserved migration, so every new
table has a declared class the moment it exists.

## Non-goals

- No remote signing service, transparency log, or network verification.
- No attempt to make incompatible archives import through best-effort column
  dropping.
- No weakening of current checksum, path, or same-project reference rules.
- No storage of private signing keys in SQLite, archives, or CLI flags.
- No archive import that silently rewrites project IDs or required table
  semantics.

## Current state and gaps

Archive version `1` already enforces strong invariants:

- manifest ↔ project ID agreement;
- exact manifest/file matching;
- strict checksum and size validation;
- path confinement and symlink rejection;
- project ownership checks;
- workspace-root redaction; and
- omission of provider secrets.

The current gaps are about format evolution rather than basic safety:

1. no structured way to announce required reader features;
2. no way to know whether a new additive table is optional or required;
3. no optional authenticity story beyond checksum/integrity; and
4. no standard way to warn on omitted privacy-sensitive tables such as future
   analytics/feedback data.

## Interfaces and data model

The archive contract stays manifest-centric. This slice extends the existing
manifest and import/export option types so compatibility and authenticity are
expressed explicitly instead of inferred from ad hoc version checks.

### Manifest changes

Introduce archive version `2` with additive compatibility metadata:

```ts
export interface KnowledgeArchiveCompatibilityBlock {
  minimumReaderArchiveVersion: number;
  producedBy: {
    packageVersion: string | null;
    knowledgeSchemaVersion: number | null;
  };
  requiredFeatures: string[];
  optionalFeatures: string[];
  tableFingerprints: Array<{
    table: string;
    sha256: string;
    rowCount: number;
  }>;
  omissions: Array<{
    table: string;
    reason: 'secret_omitted' | 'privacy_omitted' | 'host_local_only' | 'derived_rebuild';
    rowFilter?: { column: string; prefix: string };
  }>;
}

export interface KnowledgeArchiveAuthenticity {
  algorithm: 'ed25519-detached';
  keyId: string;
  signerHint: string | null;
  signedManifestSha256: string;
  signatureBase64: string;
  signedAt: string;
}

export interface KnowledgeArchiveManifestV2 extends KnowledgeArchiveManifest {
  archiveVersion: 2;
  compatibility: KnowledgeArchiveCompatibilityBlock;
  authenticity?: KnowledgeArchiveAuthenticity;
}
```

`requiredFeatures` (semantic correctness depends on them):

- `knowledge-analysis-coverage-v1` (coverage and deferred-relationship tables)
- `knowledge-chat-payload-v2` (any V2 conversation payload file)

`optionalFeatures` (safe to ignore; absence never corrupts imported knowledge):

- `knowledge-graph-reports-v1` (graph reports and ambiguities; recomputable)
- `knowledge-semantic-summaries-v1` (grounded summaries; rebuildable on demand)

## Table classification registry

A single code registry, one entry per table, drives export, import validation,
manifest `requiredFeatures`/`optionalFeatures`/`omissions`, and
`tableFingerprints`. A table without an entry fails the exporter and importer
tests, so no table can be added without a declared class. The full table list
and feature ids are in the umbrella spec; the class semantics are:

| Class | Exported | Import behavior |
| ----- | -------- | --------------- |
| `required` | yes | Missing while the feature is declared: reject. Unknown required feature: reject |
| `optional` | yes if rows exist | Present: import. Absent: warn `optional_table_absent`, continue |
| `derived-rebuild` | never | Not in archive; rebuilt locally; import result reports what to rebuild |
| `host-local` | never | Present in an archive: reject |
| `privacy-omitted` | never (default) | Not in archive; never fabricated |

Notes:

- `knowledge_settings` is `required` with a **row filter**: rows whose
  `setting_key` starts with `host.` are host-local. The exporter omits them and
  declares `{ table: 'knowledge_settings', reason: 'host_local_only', rowFilter:
  { column: 'setting_key', prefix: 'host.' } }`; table fingerprints cover the
  exported rows only. The importer rejects any `host.` row.
- `knowledge_provider_profiles` stays omitted with reason `secret_omitted`. No
  exported table may contain provider endpoints, models, `apiKeyEnv`, or keys;
  summary records export `provider_profile_name` as `NULL`.
- `knowledge_jobs.result_schema_version` is an optional column of the existing
  table (unknown columns are still rejected).
- New exported tables are appended to the table list in foreign-key dependency
  order (after the tables they reference), validated with the existing
  project-ownership and same-archive-reference checks.

### Import/export interfaces

Add additive options:

```ts
export interface ExportKnowledgeProjectOptions {
  // existing fields
  manifestVersion?: 1 | 2 | 'auto';
  authenticitySigner?: {
    keyId: string;
    signerHint?: string | null;
    signManifestSha256(sha256: string): string;
  };
}

export interface ImportKnowledgeProjectOptions {
  // existing fields
  compatibilityPolicy?: {
    maxSupportedArchiveVersion: number;
    acceptedOptionalFeatures?: ReadonlySet<string>;
  };
  authenticityVerifier?: {
    verify(input: KnowledgeArchiveAuthenticity, manifestSha256: string): 'verified' | 'invalid' | 'unverified';
  };
}

export interface ImportResult {
  // existing fields
  warnings: Array<{ code: string; message: string }>;
  postImport: { rebuildRequired: Array<'search_index' | 'semantic_model'> };
  authenticity:
    | { state: 'absent' }
    | { state: 'verified'; keyId: string }
    | { state: 'unverified'; keyId: string }
    | { state: 'invalid'; keyId: string };
}
```

## Fail-closed rules

Imports remain fail-closed for any structural or semantic mismatch.

Reject import when:

- archive version is above the supported reader version;
- any `requiredFeatures` entry is unknown to the reader;
- any required table or file fingerprint is malformed or mismatched;
- a host-local table or a `host.` settings row is present in the archive;
- an exported table has no registry entry, or an omission declares a table the
  archive nevertheless contains;
- authenticity metadata is present but syntactically malformed;
- authenticity verification explicitly returns `invalid`;
- project/table/path/checksum validation fails for any existing reason.

Warn but continue when:

- authenticity metadata is absent;
- authenticity metadata is present but no verifier is configured;
- optional features are unknown but not required;
- optional tables are absent (`optional_table_absent`);
- derived-rebuild, host-local (row-filtered), and privacy-omitted data are
  omitted exactly as declared in `compatibility.omissions`.

Authenticity is therefore optional, but a claimed signature cannot fail open.

## Export rules

- Readers land before writers emit version 2 by default.
- Writer rollout is:
  1. import v2 support and the classification registry (first in the backlog);
  2. explicit `--manifest-version 2` export;
  3. `'auto'` selection (below) as the default once adapters have parity, which
     keeps version 1 for projects that have no v2-only data.
- Analytics/feedback tables are omitted with `privacy_omitted`; derived indexes
  and vectors are omitted with `derived_rebuild`; freshness, watcher, and
  regression tables and `host.` settings are omitted with `host_local_only`.
- Provider secrets remain omitted exactly as they are today.
- `manifestVersion` defaults to `'auto'`: version 1 when the project has no
  `required`-class v2 data (no coverage rows, no V2 chat payload files),
  otherwise version 2. An explicit `manifestVersion: 1` for a project that has
  such data fails closed with `manifest_version_incompatible` instead of
  silently dropping required data.

## Import behavior for derived and host-local data

- Import never rebuilds derived data inside the import transaction. After
  success, the project's derived tables (search index, semantic model) are empty,
  search uses its per-source fallback, and hybrid stays lexical-only until the
  local rebuilds run. `ImportResult` gains
  `postImport: { rebuildRequired: Array<'search_index' | 'semantic_model'> }` and
  a warning `derived_data_rebuild_required`.
- `replaceExisting` deletes the project's derived-rebuild rows and host-local
  freshness/watcher rows in the same transaction as the table replacement
  (freshness bootstraps on the next refresh), and preserves the project's
  `host.` settings and privacy-omitted analytics rows.
- Imported data never carries host-local state, so an imported project uses the
  importing host's defaults (worker concurrency, hybrid off, analytics off).

## Security and privacy constraints

- Signing keys are caller-owned and never persisted in the archive or database.
- `signerHint` may identify an operator or host label, but must not contain
  secrets or private paths.
- Authenticity metadata cannot bypass checksum validation, path validation, or
  project ownership validation.
- Omitted-table declarations must never hide required operational state.
- Archive verification remains local-only and must not contact remote services.

## Compatibility and migrations

- Readers must support v1 and v2 during rollout.
- Until CLI/MCP/core parity exists, the default remains version 1 wherever it is
  lossless (`'auto'` never emits version 2 for a project with no v2-only data).
- Version 1 manifests have no `omissions` block. A version 1 export therefore
  omits only classes that are never required (derived-rebuild, host-local,
  privacy-omitted); anything required forces version 2 or fails closed as above.
- The archive code path needs a compatibility normalizer so older archives can
  be mapped into the current import contract before validation continues.
- Future additive tables should declare whether they are required for semantic
  correctness or safely omittable.
- Existing archive tests remain relevant and gain mixed-version cases.

## TDD validation

Follow RED → GREEN → IMPROVE with tests for:

1. v1 archives still importing cleanly;
2. v2 manifests with known required features importing cleanly;
3. unknown required feature rejection;
4. malformed authenticity metadata rejection;
5. invalid signature rejection;
6. absent or unverifiable authenticity yielding warnings, not unsafe success;
7. table fingerprint mismatch rejection;
8. omission declarations for privacy-sensitive, derived-rebuild, and host-local
   data, including the `host.` settings row filter and import rejection of a
   `host.` row or a host-local table;
   registry completeness (every table has a class) and `'auto'` manifest version
   selection, including fail-closed explicit v1;
   post-import `rebuildRequired` reporting and `replaceExisting` cleanup of
   derived and freshness rows while preserving `host.` settings;
9. archive export/import round-trips for both manifest versions; and
10. unchanged fail-closed behavior for path traversal, checksum mismatch, and
    project ownership mismatch.

Validation should run focused archive/exporter/security tests and then full
core/CLI suites.
