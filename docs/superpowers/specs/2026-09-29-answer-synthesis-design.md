# Cross-File Answer Synthesis with Provenance-Preserving Citations

## Purpose

Add a core answer-synthesis layer that can combine evidence from multiple
knowledge search results into one grounded answer while preserving exact
source/page provenance. The design must stay useful offline, must not require a
provider, and must not let provider prose become authoritative unless every
claim can be traced back to already retrieved Ariadne evidence.

## Scope

This slice adds:

- a provider-optional `KnowledgeAnswerSynthesisService` in core;
- deterministic cross-file synthesis over existing `searchKnowledge(...)`
  results;
- a structured evidence/claim/result model that preserves exact citations;
- optional provider-assisted rewriting that references precomputed evidence IDs
  instead of inventing citations;
- persistence of a reference-only synthesis block in the `synthesis` slot of the
  citation slice's `MessagePayloadV2`;
- save-to-page behavior that carries exact source-span provenance into
  `knowledge_page_provenance`;
- bounded diagnostics for ambiguous, weak, or citation-poor answers; and
- regression coverage for determinism, provenance preservation, fallback, and
  compatibility.

The public search API remains project-scoped and unchanged. This design is
about turning retrieved evidence into a grounded answer, not about changing the
ranking algorithm itself.

Shared contracts are owned by `2026-09-29-knowledge-backlog-contracts-design.md`.
This slice reserves **no** global migration. It does **not** define the chat
payload: `MessagePayloadV2` is owned by the citation-context slice, and this
slice only defines `PersistedKnowledgeSynthesis`, the value that fills that
payload's `synthesis` slot. Persisted synthesis is **reference-only** (IDs,
coordinates, snippet policy), consistent with the citation spec.

## Non-goals

- No semantic embeddings or mandatory provider dependency.
- No provider authority over facts, citations, or provenance.
- No cross-project retrieval or cross-project citation stitching.
- No change to queue leasing, source watching, or worker concurrency.
- No storage of full raw source contents in chat payloads or synthesis tables.
- No free-form provider citation format that bypasses Ariadne span validation.

## Current constraints

Today `KnowledgeChatService`:

1. runs `searchKnowledge(...)`;
2. builds a token-budgeted search context;
3. flattens result citations into one deduped list; and
4. streams provider output as plain text.

That leaves two gaps:

- answers are not synthesized deterministically when no provider is configured;
  and
- saved answers keep a flat citation list, but not a claim-to-evidence mapping.

The good news is that Ariadne already has the core ingredients this design
should reuse:

- exact-span source citations in `KnowledgeSearchCitation`;
- `KnowledgeProvenanceRef` fields for source-version and span coordinates;
- `KnowledgePageStore` support for resolving exact span IDs into
  `knowledge_page_provenance`; and
- file-backed chat payloads, which let us extend message structure without a
  large schema change.

## Proposed interfaces

### Runtime types (in memory, never persisted as-is)

```ts
export type KnowledgeAnswerStrategy = 'deterministic' | 'provider-assisted';

export interface SynthesizeKnowledgeAnswerInput {
  projectId: string;
  query: string;
  mode?: KnowledgeSearchMode;
  taskStore?: TaskStore;
  limit?: number;
  maxGraphExpansions?: number;
  tokenBudget?: number;
  providerStrategy?: 'never' | 'if-available';
  providerProfileName?: string | null;
}

// Runtime evidence may carry an ephemeral redacted snippet for provider input.
export interface KnowledgeSynthesisEvidence {
  id: string;
  resultId: string;
  kind: 'page' | 'source' | 'task';
  title: string;
  path: string | null;
  url: string | null;
  rank: number;
  citation: KnowledgeSearchCitation | null;
  snippetPolicy: 'reference_only' | 'ephemeral_redacted';
  ephemeralSnippet: string | null; // only when snippetPolicy = 'ephemeral_redacted'; never persisted
  searchConfidence: 'clear' | 'ambiguous' | null;
  ambiguityReason: 'near_tie' | 'shared_role' | 'insufficient_intent' | null;
}

export type KnowledgeSynthesisClaimConfidence = 'clear' | 'ambiguous' | 'unassessed';

export interface KnowledgeSynthesisClaim {
  id: string;
  text: string;
  evidenceIds: string[];
  citations: KnowledgeSearchCitation[];
  confidence: KnowledgeSynthesisClaimConfidence;
}

export interface KnowledgeSynthesisSection {
  id: string;
  heading: string;
  claims: KnowledgeSynthesisClaim[];
}

export interface KnowledgeSynthesisWarning {
  code:
    | 'provider_unavailable'
    | 'provider_invalid'
    | 'insufficient_exact_spans'
    | 'ambiguous_evidence'
    | 'result_limit_reached';
  reason?: ProviderFallbackReason; // present for provider_* codes; shared type from the umbrella spec
  ambiguityReason?: 'near_tie' | 'shared_role' | 'insufficient_intent';
  alternativeCount?: number;
  message: string;
}

export interface KnowledgeSynthesisResult {
  strategy: KnowledgeAnswerStrategy;
  query: string;
  mode: KnowledgeSearchMode;
  answerMarkdown: string;
  sections: KnowledgeSynthesisSection[];
  evidence: KnowledgeSynthesisEvidence[];
  citations: KnowledgeSearchCitation[];
  warnings: KnowledgeSynthesisWarning[];
}

export interface KnowledgeAnswerSynthesisService {
  synthesize(input: SynthesizeKnowledgeAnswerInput): Promise<KnowledgeSynthesisResult>;
}
```

The earlier free-form `snippet` and `metadata` evidence fields and the numeric
claim `confidence` are removed: a snippet is ephemeral and optional, and
confidence is not invented by synthesis (see the mapping below).

### Persisted type (the only synthesis shape written to disk or archives)

```ts
export interface PersistedKnowledgeSynthesis {
  synthesisVersion: 1;
  strategy: KnowledgeAnswerStrategy;
  sections: KnowledgeSynthesisSection[];   // claim text is redacted extraction-derived prose or accepted provider prose
  evidence: Array<{
    id: string;
    resultId: string;
    kind: 'page' | 'source' | 'task';
    title: string | null;
    path: string | null;
    rank: number;
    citation: KnowledgeSearchCitation | null; // context.snippetPolicy is always 'reference_only'
    snippetPolicy: 'reference_only';
    searchConfidence: 'clear' | 'ambiguous' | null;
  }>;
  warnings: KnowledgeSynthesisWarning[];
}
```

Persistence rules:

- `ephemeralSnippet`, provider prompts, provider responses, and any excerpt text
  are dropped before persistence. `snippetPolicy` is always `reference_only` in
  stored form.
- The stored evidence carries only IDs, titles/paths, rank, the citation
  (coordinates and span IDs), and the snippet policy.
- Claim text is bounded prose. In the deterministic path it is assembled from
  extraction symbol names, section titles, and summaries after redaction, not
  from verbatim source excerpt spans. In the provider path it is the validated
  provider claim text, which is the same category of content the chat `content`
  field already stores.
- `PersistedKnowledgeSynthesis` is the only extension of `MessagePayloadV2`; this
  spec adds no other payload keys and does not redeclare the payload.

### Ambiguity and confidence mapping

Synthesis computes no ambiguity. It reads the top-one confidence metadata that
search already attaches (`searchConfidence`, `ambiguityReason`,
`ambiguityAlternatives`; owned by the top-one slice and preserved unchanged by
the hybrid slice, including after a semantic reorder):

- Each evidence entry copies `searchConfidence`/`ambiguityReason` from its
  search result; page and task evidence, which have no such metadata, use `null`.
- A claim's `confidence` is `'ambiguous'` when any evidence it cites has
  `searchConfidence = 'ambiguous'`; otherwise `'clear'` when all cited evidence
  is `'clear'`; otherwise `'unassessed'`.
- `ambiguous_evidence` is emitted once when the leading source result is
  `ambiguous`, with `ambiguityReason` and `alternativeCount` copied from the
  metadata, and the deterministic **Open questions / ambiguity** section lists
  the competing results. The warning is also emitted when cited evidence
  conflicts or lacks exact spans and is combined with `insufficient_exact_spans`.
- Semantic (hybrid) reordering never changes this mapping: the confidence is the
  pre-reorder value the search layer preserved.

### Provider capability, profile selection, and streaming

- **Capability.** Provider-assisted synthesis uses an enabled project provider
  profile with the existing `generation` capability, in a single non-streaming
  request. It does not use `embeddings`, and it is unrelated to the local
  semantic retrieval.
- **Profile selection.** Precedence: `input.providerProfileName`, then the
  host-local setting `host.provider.synthesis_profile`, then none. No "first
  enabled profile" guessing. If `providerStrategy = 'never'`, or omitted, no
  provider is consulted.
- **Offline.** With `providerStrategy = 'if-available'` and no resolvable
  profile, the result is deterministic and carries a `provider_unavailable`
  warning with reason `no_profile`; the call does not error.
- **Warning-only fallback.** Disabled profile, missing capability, missing
  credentials, unsafe endpoint, timeout, provider error, and invalid response all
  produce the deterministic result plus a warning (`provider_unavailable` or
  `provider_invalid`, with the shared `reason`). No retry inside the request, and
  no failure is thrown for provider problems. Messages never include endpoints,
  keys, or provider transcripts.
- **Streaming.** The provider call is non-streaming so the whole response can be
  validated against evidence IDs before anything is persisted or shown. Surfaces
  that stream (chat) emit `answerMarkdown` as chunked deltas **after** validation
  (deterministic and provider-assisted alike). When a caller does not opt into
  synthesis, `KnowledgeChatService` keeps its existing provider text streaming
  unchanged.

### Provider rewrite contract

```ts
export interface KnowledgeSynthesisProviderRequest {
  query: string;
  mode: KnowledgeSearchMode;
  evidence: Array<{
    id: string;
    title: string;
    snippet: string | null;   // ephemeral redacted, bounded; null for reference_only evidence
    citation: KnowledgeSearchCitation | null;
  }>;
  deterministicDraft: KnowledgeSynthesisSection[];
}

export interface KnowledgeSynthesisProviderResponse {
  sections: Array<{
    heading: string;
    claims: Array<{
      text: string;
      evidenceIds: string[];
    }>;
  }>;
}
```

The request contains only the bounded evidence pack, and snippets only where the
citation spec's `ephemeral_redacted` policy permits it. Provider responses are
accepted only after Ariadne validates that every claim:

- references at least one known `evidenceId`;
- resolves to at least one citation already present in the evidence pack; and
- stays within configured claim/section count and text-length bounds.

If validation fails, Ariadne falls back to deterministic synthesis and records a
`provider_invalid` warning instead of persisting ungrounded prose.

### Chat payload

`MessagePayloadV2` is defined once, in the citation-context spec, and is not
redeclared here. Its `synthesis?: PersistedKnowledgeSynthesis | null` slot is
filled with the type defined above.

`parseMessagePayload(...)` (citation slice) must continue accepting legacy
payloads without `schemaVersion` or `synthesis`. This slice supplies the
`PersistedKnowledgeSynthesis` validator used by that parser.

## Exact data flow

1. `KnowledgeChatService` or a future query/synthesis caller requests an answer
   through `KnowledgeAnswerSynthesisService.synthesize(...)`.
2. The service runs the existing `searchKnowledge(...)` call with current
   project, retrieval mode, graph-expansion, and token-budget options.
3. Search results are converted into a bounded evidence pack:
   - preserve existing result ordering;
   - keep at most `N` distinct result records and `M` citations per result;
   - prefer exact-span source citations for claims;
   - allow page/task evidence only when source-span evidence is unavailable.
4. The deterministic synthesizer builds sections in stable order:
   - **Answer**: the smallest grounded set of claims that directly answer the
     query;
   - **Supporting evidence**: grouped cross-file details;
   - **Open questions / ambiguity**: only when evidence conflicts or exact
     spans are missing.
5. If `providerStrategy === 'if-available'` and a profile resolves (input, then
   `host.provider.synthesis_profile`) with an enabled `generation` capability,
   Ariadne sends only the bounded evidence pack and deterministic draft in one
   non-streaming request. The provider returns claim text plus `evidenceIds`,
   not raw citations.
6. Ariadne validates the provider response, reconstructs citations from
   evidence IDs, and either:
   - persists a `provider-assisted` synthesis result; or
   - falls back to the deterministic result with a warning.
7. `KnowledgeChatService` converts the runtime result to
   `PersistedKnowledgeSynthesis` (dropping ephemeral snippets) and persists both
   flattened citations and that block in the `MessagePayloadV2`.
8. `saveMessageToPage(...)` uses the structured claim citations first, then the
   flattened citation list, to create page provenance rows with exact
   `sourceSpanId` resolution wherever possible.

## Deterministic baseline behavior

The provider-optional baseline is deliberately conservative:

- A claim may only cite evidence already returned by search.
- Source-backed claims use exact source spans whenever they exist.
- Results without exact spans may appear under supporting context or ambiguity,
  but they must not be upgraded into exact-span inline citations.
- Citation ordering follows evidence ordering, then source path, then span
  offset.
- Section and claim IDs derive from stable hashes of `(query, heading,
  evidenceIds)` so the same inputs produce the same structure.

This makes the offline path useful by itself and keeps the provider path a
presentation layer, not a truth layer.

## Failure handling and rollback

- **Search failure**: return a normal knowledge-chat error; persist nothing.
- **No provider configured**: emit deterministic synthesis with no error.
- **Provider timeout / refusal / malformed output**: keep the deterministic
  result, add `provider_unavailable` or `provider_invalid`, and do not retry
  inside the same request.
- **Weak or citation-poor evidence**: return a bounded answer that explicitly
  records `insufficient_exact_spans` or `ambiguous_evidence` rather than
  fabricating certainty.
- **Persistence failure after synthesis**: do not create a half-written message
  row; treat the request as failed and leave the conversation unchanged.
- **Page-save failure**: keep the chat message intact; no partial provenance row
  writes outside the page-version transaction.

Rollback remains simple because synthesis is derived state: if persistence or
page-save fails, Ariadne can recompute the answer from search results instead of
repairing a partially trusted synthesis record.

## Offline and security constraints

- Offline mode is first-class; no network or provider is required.
- Provider-assisted synthesis is opt-in per call (`providerStrategy`), and the
  provider is never required, so the offline constraint and the provider option
  do not conflict: offline is the default and the always-available result.
- Only bounded ephemeral snippets and citation metadata are eligible for provider
  input; raw full-file contents are not.
- All snippets and provider-bound text continue through the existing redaction
  hooks.
- Evidence and citations remain project-scoped.
- Stored synthesis metadata must not include secrets, provider transcripts,
  excerpt text, or entire source payloads (enforced by
  `PersistedKnowledgeSynthesis`).
- Any provider output that cannot be grounded to known evidence IDs is rejected.

## Compatibility

- `searchKnowledge(...)` stays unchanged.
- Existing chat conversations remain readable because `synthesis` is optional.
- Existing flat `citations` arrays remain present for adapters that have not
  yet been updated to render claim-level structure.
- `KnowledgePageStore` already supports exact span provenance resolution, so no
  page-schema change is required.
- Archive import/export continues to use the existing conversation payload file
  path rules; the payload schema is versioned and additive. Because the
  payload is a file in the archive, it carries no excerpts, and a V2 payload
  makes `knowledge-chat-payload-v2` a required manifest feature (umbrella spec).
  The synthesis block adds no table and needs no separate archive class.
- The feature composes with the search-index design: indexed search still feeds
  the same synthesis service.

## TDD validation

Follow RED → GREEN → IMPROVE:

1. Add unit tests for deterministic cross-file synthesis over existing
   source/page search fixtures.
2. Add regression tests proving that exact-span citations survive:
   - search result → synthesis claim;
   - synthesis claim → chat payload;
   - chat payload → saved query/synthesis page provenance.
3. Add provider-validation tests covering:
   - unknown `evidenceId` rejection;
   - duplicate evidence deduplication;
   - fallback on malformed provider output;
   - deterministic behavior when no provider exists.
4. Add backward-compatibility tests for legacy chat payload JSON.
   Add tests that persisted synthesis contains no `ephemeralSnippet` or excerpt
   text, that `ambiguous` search confidence maps to `ambiguous_evidence` and claim
   confidence (including after a hybrid reorder), and that provider capability,
   profile precedence, streaming-after-validation, and every warning-only
   fallback reason behave as specified.
5. Run focused knowledge chat/search/page-store tests, then full core tests and
   build.
6. Verify CLI/MCP/dashboard rendering can ignore `synthesis` safely before any
   richer UI uses it.

A change is not complete until the deterministic path works with zero providers
and the provider-assisted path proves that every persisted claim still maps back
to Ariadne-owned citations.
