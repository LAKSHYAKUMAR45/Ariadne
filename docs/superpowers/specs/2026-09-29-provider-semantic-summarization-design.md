# Optional Provider-Backed Semantic Summarization with Offline Fallback Design

## Purpose

Add an optional semantic summarization layer that can produce more coherent,
higher-level summaries for sources, pages, and project overviews without making
providers mandatory. Ariadne must remain useful offline, and any provider
failure or invalid response must degrade to deterministic local summaries with
warnings instead of failed jobs.

## Scope

This slice adds:

- a core semantic summarization service for source/page/project scopes;
- deterministic offline summaries as the baseline implementation path;
- optional provider-backed summary refinement using bounded grounded evidence;
- persisted summary records with explicit strategy and warning metadata;
- additive CLI/MCP/read surfaces to request or inspect semantic summaries; and
- regression coverage for fallback, grounding, redaction, and compatibility.

The slice is about summarization, not retrieval ranking or free-form answer
synthesis. It should complement the separate answer-synthesis and local-semantic
retrieval designs already present in this worktree.

Shared contracts are owned by `2026-09-29-knowledge-backlog-contracts-design.md`.
This slice owns the `knowledge_semantic_summaries` table (reserved global
migration version 17, knowledge revision 13) and the host-local setting
`host.provider.summary_profile`. Summaries never call a provider unless the
caller opts in per request; offline is the default and the always-available
result.

## Non-goals

- No provider-required behavior for indexing, worker completion, or search.
- No raw provider prompts/responses stored in SQLite or archives.
- No ungrounded provider prose accepted as authoritative fact.
- No background provider execution unless an integrating caller explicitly opts
  in and supplies a compatible provider profile.
- No cross-project summarization or shared corpus.

## Current state and gaps

The branch already has strong deterministic summary sources:

- `DeterministicExtraction.summary`;
- deterministic source-page generation;
- `KnowledgeRenderer` overview/index rendering; and
- provider-neutral `KnowledgeAnalysis` / `KnowledgeGeneration` contracts.

What is missing is a reusable, bounded service that can:

1. use those deterministic summaries directly when offline;
2. optionally ask a provider for a semantically richer rewrite;
3. validate the returned summary against grounded local evidence; and
4. persist only the safe summary output plus warning metadata.

## Interfaces and data model

### 1. Service contract

```ts
export type KnowledgeSummaryScopeKind = 'source_version' | 'page_version' | 'project';
export type KnowledgeSummaryStrategy = 'deterministic' | 'provider_refined' | 'fallback_warning';

export interface BuildKnowledgeSemanticSummaryInput {
  projectId: string;
  scopeKind: KnowledgeSummaryScopeKind;
  scopeId: string;
  providerMode?: 'never' | 'if-available';
  providerProfileName?: string | null;
}

// Runtime only: `text` is bounded redacted extraction-derived text and is sent to a
// provider request in memory; it is never persisted.
export interface KnowledgeSemanticSummaryEvidence {
  id: string;
  title: string;
  citation: KnowledgeSearchCitation | null;
  text: string;
}

export interface KnowledgeSemanticSummaryRecord {
  id: string;
  projectId: string;
  scopeKind: KnowledgeSummaryScopeKind;
  scopeId: string;
  strategy: KnowledgeSummaryStrategy;
  title: string;
  summary: string;
  bullets: string[];
  evidence: Array<{
    evidenceId: string;
    citation: KnowledgeSearchCitation | null; // context.snippetPolicy is always 'reference_only'
  }>;
  providerProfileName: string | null; // label only; see "Provider profile reference"
  warnings: Array<{ code: string; message: string; reason?: ProviderFallbackReason }>; // ProviderFallbackReason: umbrella spec
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSemanticSummaryService {
  build(input: BuildKnowledgeSemanticSummaryInput): Promise<KnowledgeSemanticSummaryRecord>;
  getLatest(projectId: string, scopeKind: KnowledgeSummaryScopeKind, scopeId: string): KnowledgeSemanticSummaryRecord | null;
}
```

### 2. Persistence

Add an additive table:

```sql
CREATE TABLE knowledge_semantic_summaries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  provider_profile_name TEXT,
  summary_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, scope_kind, scope_id, created_at),
  FOREIGN KEY (project_id) REFERENCES knowledge_projects(id) ON DELETE CASCADE
);
```

`summary_json` stores only:

- summary title/text;
- bullet list;
- evidence IDs and reference-only citations (IDs, coordinates, `reference_only`
  snippet policy; the citation spec's rule that only `ephemeral_redacted`
  snippets may reach a provider request applies, and nothing derived from them is
  persisted);
- no raw provider prompt/response;
- no source excerpts beyond what the summary text itself states.

Summary text is redacted extraction-derived prose in the deterministic path
(extraction summary, symbol names, section titles) or validated provider prose in
the refined path.

### Provider profile reference

`provider_profile_name` holds only the profile name (validated by the existing
profile-name pattern) and is set only when `strategy = 'provider_refined'`. It
never holds an endpoint, model, `apiKeyEnv`, key, or environment-variable value,
and `summary_json`/`warnings_json` never include them. Because profiles are
host-local (`knowledge_provider_profiles` is omitted from archives), the archive
exporter writes `provider_profile_name` as `NULL`; a `provider_refined` record
imported elsewhere is therefore still valid and grounded, but does not name a
profile that may not exist on the importing host.

### Migration

Reserved **global migration version 17** (knowledge revision 13), after the
search, coverage, graph, freshness, and hybrid migrations. It creates only
`knowledge_semantic_summaries` with an `IF NOT EXISTS` guard.

### 3. Provider request/response contract

Reuse the existing `generation` capability rather than inventing a new provider
capability. Local semantic retrieval and this slice are unrelated: neither uses
the `embeddings` capability.

```ts
export interface SemanticSummaryProviderRequest {
  scopeKind: KnowledgeSummaryScopeKind;
  title: string;
  deterministicSummary: string;
  evidence: Array<{
    id: string;
    title: string;
    text: string;
    citation: KnowledgeSearchCitation | null;
  }>;
}

export interface SemanticSummaryProviderResponse {
  title: string;
  summary: string;
  bullets: string[];
  evidenceIdsByBullet: string[][];
}
```

Validation rules:

- every bullet must reference at least one known evidence ID;
- evidence IDs must resolve to local citations already supplied in the request;
- response sizes are bounded;
- failed validation falls back to deterministic output with warnings.

## Deterministic offline fallback

The offline baseline uses only local evidence:

- **source-version scope**: extraction summary + top symbols/sections + source
  citation references;
- **page-version scope**: page summary + page provenance rollup + linked source
  counts;
- **project scope**: bounded aggregation of current page summaries, graph
  counts, review counts, and analyzer coverage warnings.

This baseline is always available and is the authoritative minimum behavior.

## Provider behavior

1. Build the deterministic summary first. It is the authoritative minimum and is
   what gets persisted whenever a provider is not used or not accepted.
2. Resolve a provider profile only when `providerMode = 'if-available'`.
   Selection precedence: `providerProfileName` input, then host-local setting
   `host.provider.summary_profile`, then none. The profile must be enabled and
   declare the `generation` capability. There is no "first enabled profile"
   guessing.
3. Send a bounded redacted evidence pack plus the deterministic summary in a
   single **non-streaming** request; the response is validated as a whole before
   anything is stored or shown, so there is no partial streamed summary.
4. Accept the provider response only after grounding validation succeeds.
5. Persist the final record with:
   - `strategy = 'provider_refined'` on success (`providerProfileName` set);
   - `strategy = 'fallback_warning'` when a provider was requested but not used
     or not accepted; the deterministic content is stored with one
     `ProviderFallbackWarning` (umbrella spec) whose `reason` is one of
     `no_profile`, `profile_disabled`, `capability_missing`,
     `missing_credentials`, `unsafe_endpoint`, `timeout`, `provider_error`, or
     `invalid_response` (`provider_invalid` code for the last, `provider_unavailable`
     for the rest);
   - `strategy = 'deterministic'` when `providerMode = 'never'` or omitted.

Provider failures are warnings only. They must not fail the worker, page build,
or search path, and they never throw to the caller. Warning messages never
include endpoints, keys, environment values, or provider transcripts.

## Security and privacy constraints

- No source-content leakage beyond bounded redacted evidence already approved
  for provider use.
- Never persist raw provider prompts, raw provider responses, API keys, or
  environment-variable values.
- Provider profile resolution must obey existing endpoint and credential
  policies.
- Summary persistence stores only the accepted grounded result and bounded
  warnings.
- Project scope summaries must never mix evidence across projects.

## Compatibility and migrations

- `knowledge_semantic_summaries` is additive (global migration 17).
- Callers that do not request summaries remain unchanged.
- Search/page rendering may adopt semantic summaries as optional display
  metadata later without changing core deterministic ranking.
- **Archive class: optional**, feature `knowledge-semantic-summaries-v1`. Accepted
  summary records are grounded knowledge artifacts and are exported in archive
  v2 (after `knowledge_page_versions`), with `provider_profile_name` exported as
  `NULL` and provider credentials/configuration omitted exactly as today. Import
  validates project ownership and that `scope_id` resolves to a source version,
  page version, or the project inside the archive, and rejects otherwise. An
  archive lacking the table imports with a warning; summaries can be rebuilt on
  demand.
- Older databases without the table behave as “summary feature unavailable”
  until migrated.

## TDD validation

Follow RED → GREEN → IMPROVE with tests for:

1. deterministic source/page/project summary generation with no provider;
2. provider-absent fallback behavior returning deterministic summaries;
3. provider timeouts, missing credentials, and invalid responses producing
   warning-only fallback;
4. grounding validation rejecting bullets that cite unknown evidence IDs;
5. persistence omitting raw provider prompts/responses;
6. project isolation across summary scopes;
7. archive round-tripping accepted summary records with `provider_profile_name`
   exported as `NULL` and no endpoint/model/`apiKeyEnv` anywhere, plus rejection
   of an unresolvable `scope_id`;
   provider selection precedence, capability check, and each fallback reason
   producing the deterministic record with exactly one warning; and
8. unchanged worker/search behavior when no caller opts into summaries.

Validation should run focused provider/profile/summary tests, then full core and
CLI suites.
