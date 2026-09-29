# Citation Context and Legacy-Result Handling Design

## Purpose

Upgrade Ariadne citations from flat path/span references into richer,
backward-compatible context records while preserving exact provenance and
supporting legacy job results, legacy chat payloads, and older archives.
Citations should become easier to explain, save, inspect, and audit without
persisting source-content leaks.

## Scope

This slice adds:

- additive citation-context metadata for search, chat, saved pages, and answer
  synthesis;
- a stable compatibility contract for legacy chat message payloads and legacy
  knowledge job results;
- improved page-saving behavior that resolves persisted source span IDs when
  available;
- archive import/export rules for the richer citation structure; and
- regression coverage for dual-read/dual-write behavior.

It does not change search ranking itself.

This slice is the **owner** of two shared contracts defined in
`2026-09-29-knowledge-backlog-contracts-design.md`: `MessagePayloadV2` (the only
definition of the chat payload) and the versioned `KnowledgeJobResult` envelope
(`result_schema_version`). Other specs must reference, not redeclare, them.

## Non-goals

- No raw full-text source excerpts persisted into SQLite, archives, or chat
  payloads.
- No breaking change to the public `KnowledgeSearchCitation` consumer shape.
- No provider dependency for citation context.
- No silent reinterpretation of malformed legacy results as valid structured
  evidence.

## Current state and gaps

Today `KnowledgeSearchCitation` carries:

- page ID
- source ID
- path or URL
- optional span coordinates

That is enough for provenance but not enough for later consumers to know:

- which field or match produced the citation;
- whether the citation came from an exact persisted span, page provenance, or a
  metadata-only fallback;
- whether the cited result came from a legacy payload with incomplete metadata;
- whether `saveMessageToPage(...)` can resolve a concrete `source_span_id`
  rather than emitting source-only provenance.

The branch also already supports legacy `knowledge_jobs.result_processing_mode`
backfill with `unknown`, so the design should extend that compatibility mindset
instead of starting over.

## Interfaces and data model

### 1. Additive citation context

Extend citations with an optional additive context object:

```ts
export interface KnowledgeCitationContext {
  sourceVersionId: string | null;
  sourceSpanId: string | null;
  fieldKind:
    | 'section'
    | 'symbol'
    | 'summary'
    | 'page_provenance'
    | 'path_metadata'
    | 'task'
    | 'graph';
  fieldLabel: string | null;
  matchKind:
    | 'exact_span'
    | 'section_span'
    | 'metadata_only'
    | 'page_provenance'
    | 'legacy_unknown';
  snippetPolicy: 'reference_only' | 'ephemeral_redacted';
  startLineWindow: number | null;
  endLineWindow: number | null;
  legacyState: 'current' | 'legacy_payload' | 'legacy_unknown';
}

export interface KnowledgeSearchCitation {
  // existing fields
  context?: KnowledgeCitationContext;
}
```

`snippetPolicy` is persisted so readers know whether raw excerpt text is
allowed to exist only transiently in memory.

Explicit permission for other slices: answer synthesis and semantic
summarization may hold `ephemeral_redacted` snippets in memory and place them in
a single provider request when the caller opts into a provider. Nothing derived
from those snippets may be persisted; every persisted citation, synthesis
evidence entry, and summary evidence entry uses `reference_only`. No other slice
may persist excerpt text.

### 2. Message payload versioning

Move chat payloads to explicit versioned JSON while keeping tolerant readers:

```ts
interface MessagePayloadV2 {
  schemaVersion: 2;
  content: string;
  citations: KnowledgeSearchCitation[];
  retrievalMode: KnowledgeSearchMode | null;
  synthesis?: PersistedKnowledgeSynthesis | null;
}
```

`PersistedKnowledgeSynthesis` is declared by the answer-synthesis spec and is the
only extension slot. This slice ships the slot (parsed, validated as a plain
object or `null`, written as absent until synthesis lands) and the tolerant
parser. The synthesis slice must not redeclare `MessagePayloadV2`.

Rules:

- `parseMessagePayload(...)` must continue to accept legacy payloads with no
  `schemaVersion`.
- old payloads are normalized in memory to V2 with
  `context.legacyState = 'legacy_payload'` or `legacy_unknown` as applicable.
- writers emit only V2 after rollout.

### 3. Job result versioning

Reserved **global migration version 12** (knowledge revision 8) adds one
additive column and no other object:

```sql
ALTER TABLE knowledge_jobs ADD COLUMN result_schema_version INTEGER;
```

The migration is guarded by `hasColumn`, never recreates `knowledge_jobs`, and
follows the search-index migration (version 11). The archive table schema for
`knowledge_jobs` gains `result_schema_version` as an optional column so older
archives import with `NULL`.

The result payload becomes a discriminated envelope. This slice owns the
envelope and the `analyzed` variant; the analyzer-coverage slice owns the
`coverage_only` variant, its writer, and its semantics:

```ts
export type KnowledgeJobResult = KnowledgeAnalyzedJobResult | KnowledgeCoverageOnlyJobResult;

export interface KnowledgeJobResultBase {
  resultKind: 'analyzed' | 'coverage_only';
  processingMode: 'deterministic' | 'enriched';
  warnings: KnowledgeJobResultWarning[];
  legacyState?: 'current' | 'legacy_payload' | 'legacy_unknown';
}

export interface KnowledgeAnalyzedJobResult extends KnowledgeJobResultBase {
  resultKind: 'analyzed';
  analyzerId: string;
  analyzerVersion: string;
  extractionId: string;
  pageVersionIds: string[];
  graphNodeCount: number;
  graphEdgeCount: number;
  coverageStatus?: 'supported' | 'partial';
}

// KnowledgeCoverageOnlyJobResult is defined and written by the analyzer-coverage spec.
```

Interpretation:

- `result_schema_version IS NULL` + valid parse => `legacy_payload`, read as
  `resultKind: 'analyzed'` (legacy payloads have no discriminator);
- `result_processing_mode = 'unknown'` or malformed parse => `legacy_unknown`;
- `result_schema_version = 1` + valid envelope => `current`;
- writers set `result_schema_version = 1` after the tolerant reader lands.

`result_processing_mode` for `coverage_only` is `'deterministic'`, so the
existing CHECK constraint is unchanged and `unknownCompletionCount` does not
count coverage-only completions. There is no second schema-version bump when the
coverage slice starts writing `coverage_only`; the envelope already reserves it.

### 4. Optional ephemeral citation excerpts

Search, chat, and MCP read APIs may accept an additive option:

```ts
interface CitationContextOptions {
  includeEphemeralExcerpt?: boolean;
  excerptLineRadius?: number;
}
```

If enabled, Ariadne may attach a small redacted excerpt to the in-memory API
response only. It is never persisted to message payloads, analytics, or
archives.

## Read/write behavior

### Search

`searchKnowledge(...)` populates `citation.context` from the strongest matching
field:

- exact span-backed source field => `matchKind = 'exact_span'`
- page provenance citation => `page_provenance`
- metadata fallback => `metadata_only`
- legacy/incomplete restoration => `legacy_unknown`

### Chat

`KnowledgeChatService` persists only reference-level citation context.
Transient excerpt text may be included in events or read responses when the
caller opts in, but not in the on-disk message payload.

### Save to page

`saveMessageToPage(...)` should prefer this provenance resolution order:

1. `citation.context.sourceSpanId`
2. `citation.context.sourceVersionId` + coordinate lookup
3. source-only provenance fallback

This preserves exact source spans more often without breaking old messages.

### Archive

Archive export/import accepts both citation payload shapes:

- V1 legacy payloads without context
- V2 payloads with additive context

On import, Ariadne normalizes legacy payloads in memory but does not invent
missing span IDs.

Archive classification (see the umbrella spec): conversation payload files that
are `MessagePayloadV2` make `knowledge-chat-payload-v2` a **required feature**
of a v2 manifest; `knowledge_jobs.result_schema_version` is an optional column of
the existing required `knowledge_jobs` table. Payload files never contain
excerpt text, so exporting them cannot leak source content.

## Security and privacy constraints

- Persist only identifiers, labels, coordinates, and bounded metadata.
- Never persist raw source excerpts, provider prompts, or provider responses as
  citation context.
- Any ephemeral excerpt must be redacted, bounded, and opt-in.
- Legacy parse failures must degrade to explicit `legacy_unknown` markers,
  never to fabricated structured context.
- Citation context must remain project-scoped and must not create cross-project
  source references.

## Compatibility and migrations

- Message-payload versioning is file-JSON compatible and dual-read.
- `knowledge_jobs.result_schema_version` is additive (reserved global migration
  version 12) and may be backfilled lazily.
- Older archives remain importable because context is optional.
- Older callers remain compatible because `context` is additive on existing
  citation records.
- Worker status continues to report `unknownCompletionCount`; this slice adds
  better structure without removing the warning path.

Recommended rollout:

1. tolerant readers and archive readers;
2. dual-write for chat payloads and job results;
3. save-to-page span resolution improvements;
4. optional excerpt rendering for read APIs.

## TDD validation

Follow RED → GREEN → IMPROVE with tests for:

1. parsing legacy message payloads with no schema version;
2. parsing current V2 payloads with additive citation context;
3. mapping malformed legacy job results to `legacy_unknown` without crashes;
4. preserving `unknownCompletionCount` behavior while adding legacy-state
   metadata;
5. saving chat messages to pages with exact `source_span_id` reuse when
   context is present;
6. archive round-tripping mixed legacy/current message payloads;
7. excerpt opt-in behavior never persisting raw excerpt text; and
8. backward-compatible MCP/CLI output for callers that ignore `context`.

Validation should run focused chat/search/archive/queue migration tests plus
full core and CLI suites.
