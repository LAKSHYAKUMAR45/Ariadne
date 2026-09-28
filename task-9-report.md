# Task 9 Report — Optional Provider Profiles and OpenAI-Compatible Enrichment

## Scope
Implemented Task 9 in `packages/core` only:

- added strict project-scoped `KnowledgeProviderProfileStore` for `openai-compatible` profiles
- added OpenAI-compatible `/chat/completions` adapter and optional enrichment service
- extended `KnowledgeAnalysis` grounding with exact source spans
- exported the new provider/profile APIs
- added focused provider/profile/analysis tests

The unrelated unstaged plan file `docs/superpowers/plans/2026-09-24-ariadne-knowledge-wiki-plan.md` was left untouched.

## RED
Initial RED command:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeProviderProfiles.test.ts test/knowledge/OpenAICompatibleProvider.test.ts test/knowledge/KnowledgeAnalysis.test.ts
```

Initial failures recorded before implementation:

- `KnowledgeProviderProfiles.test.ts` and `OpenAICompatibleProvider.test.ts` failed to load because the new provider/profile modules did not exist yet.
- `KnowledgeAnalysis > accepts structured entities, claims, relationships, contradictions, research gaps, and confidence values`
  - failed with `Knowledge entity has an unexpected field: sourceSpans` because exact source-span grounding was not yet supported.
- `KnowledgeAnalysis > rejects malformed result structures...`
  - failed before the intended assertion because `sourceSpans` were rejected outright.
- `KnowledgeGeneration > accepts generated content with validated analysis`
  - failed for the same unsupported `sourceSpans` reason.

## GREEN
Focused validation:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeProviderProfiles.test.ts test/knowledge/OpenAICompatibleProvider.test.ts test/knowledge/KnowledgeAnalysis.test.ts test/knowledge/KnowledgeWorker.test.ts test/knowledge/KnowledgeArchive.test.ts test/knowledge/knowledgeMigrations.test.ts
pnpm --filter @ariadne-dev/core build
```

Results:

- focused knowledge/provider/archive/migration/worker suites: pass (`6` files / `42` tests)
- core build: pass (`tsc -p tsconfig.json`)

Full validation:

```bash
pnpm --filter @ariadne-dev/core test
```

Results:

- full core tests: pass (`65` files / `540` tests)

## Fix summary

### 1. Strict non-secret provider profile store

- Added `KnowledgeProviderProfileStore` with project-scoped, case-insensitive profile-name uniqueness.
- Persisted only non-secret configuration in `configuration_json`:
  - endpoint
  - model
  - capabilities
  - timeout
  - environment-variable name
  - enabled flag
- Rejected non-HTTP(S) endpoints, credentials, query strings, fragments, malformed hostnames, loopback/plain HTTP beyond localhost, and localhost/private/reserved HTTPS literals.
- Enforced bounded model length, bounded timeout, bounded capabilities, and environment-variable-name validation only.
- Disabled profiles are excluded from selection.

### 2. Redacted provider testing and secret handling

- Added provider test support with injected environment and adapter.
- Secret values are never persisted, listed, exported, or returned from profile APIs.
- Missing API-key environment variables surface warning-only diagnostics instead of leaking values.
- Diagnostics and warnings redact API keys, `Authorization` headers, and oversized excerpts.

### 3. OpenAI-compatible adapter hardening

- Added `/chat/completions` POST adapter for OpenAI-compatible servers.
- Added loopback fixture coverage for:
  - request shape
  - conditional `Authorization` header emission
  - timeout handling
  - redirect rejection
  - status / JSON / structured-response validation
  - bounded prompt and response excerpts
- Added JSON hardening for oversized, deeply nested, or unsafe-key payloads.

### 4. Exact-span grounding for provider output

- Extended `KnowledgeAnalysis` entities, claims, relationships, contradictions, and research gaps with optional `sourceSpans`.
- Added structural validation for exact spans and consistency between `sourceIds` and `sourceSpans`.
- The provider adapter now rejects outputs that:
  - cite unknown source IDs
  - cite spans outside the deterministic input
  - mismatch the current source version
  - provide contradiction/gap output without exact source spans

### 5. Warning-only optional enrichment

- Added `OpenAICompatibleEnrichmentService` that builds bounded prompts from deterministic extraction data and bounded deterministic page content.
- Provider failures stay warning-only and compatible with existing `KnowledgeWorker` fallback behavior.
- Enrichment converts grounded contradictions into pending reviews and grounded research gaps into insights.
- Provider-generated content is validated but not allowed to replace deterministic persisted facts.

## Migration ruling

No additive schema migration was required.

Ruling: the existing `knowledge_provider_profiles` table safely supports the Task 9 contract because strict validation and redaction are enforced in the application layer while archive export already omits `configuration_json`.

## Security / audit notes

- No provider secret values are written to SQLite, archives, exports, logs, job results, or diagnostics.
- Endpoint validation rejects unsupported schemes, credentials, query strings, fragments, malformed hosts, and local/private HTTPS literals.
- Redirects are not followed (`3xx` is rejected).
- Provider outputs must match structured contracts and exact deterministic grounding before enrichment is accepted.
- Warning-only enrichment preserves deterministic completion when providers fail.

## Files changed

- `packages/core/src/knowledge/KnowledgeProviderProfiles.ts`
- `packages/core/src/knowledge/providers/OpenAICompatibleProvider.ts`
- `packages/core/src/knowledge/KnowledgeAnalysis.ts`
- `packages/core/src/index.ts`
- `packages/core/test/knowledge/KnowledgeProviderProfiles.test.ts`
- `packages/core/test/knowledge/OpenAICompatibleProvider.test.ts`
- `packages/core/test/knowledge/KnowledgeAnalysis.test.ts`
- `task-9-report.md`

## Remaining concerns

- Hostname-to-IP DNS rebinding protection is still hostname-policy-based; literal localhost/private/reserved targets are blocked, but fully pinning resolved public hostnames to validated addresses would require a lower-level transport change beyond this Task 9 scope.
