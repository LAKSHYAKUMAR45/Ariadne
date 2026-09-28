# Task 9 Report — Provider Security/Correctness Follow-up

## Scope
Fixed all Task 9 follow-up security and correctness findings in `packages/core` only.

The unrelated unstaged plan file `docs/superpowers/plans/2026-09-24-ariadne-knowledge-wiki-plan.md` was left untouched.

## Host policy contract

### Credential policy
- `apiKeyEnv` is persisted as a variable name only and must use the `ARIADNE_KNOWLEDGE_PROVIDER_` prefix.
- Secret resolution is now **host-controlled**.
- Hosts must inject either:
  - `allowedEnvironmentVariables: Set<string>`, or
  - `resolveApiKey({ profile, envName, environment })`.
- Legacy persisted env names are **default-deny** unless the host explicitly exact-allowlists them with `allowedLegacyEnvironmentVariables`.
- Resolver callbacks now receive only the single approved env binding, never the caller's full environment.
- Default behavior denies secret resolution and does **not** read or forward unapproved `process.env[...]` keys.
- Diagnostics mention only the env-var name, never the secret value.

### Endpoint / origin policy
- Provider requests are now **host-controlled** too.
- Hosts must inject an exact-origin allowlist/policy into `OpenAICompatibleProvider`.
- Default behavior denies sending requests to unapproved origins.
- Named hosts additionally require a transport implementing the new `requestPinned(...)` contract.
- Plain-HTTP loopback endpoints must use explicit IP literals (`127.0.0.1` / `[::1]`), not hostname aliases.
- Loopback fixture tests inject explicit host policy.

### Request-time network safety
- Literal IP endpoints stay on the plain request path.
- Named hosts resolve inside the injected transport, must validate the full resolved set, and must bind the request to a selected approved address plus original Host/TLS metadata before credentials are released.
- Named-host private/reserved/loopback resolutions are rejected.
- IPv4-mapped IPv6 loopback/private targets are canonicalized and rejected.
- Redirects remain disabled.

## RED
Regression RED command:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeProviderProfiles.test.ts test/knowledge/OpenAICompatibleProvider.test.ts test/knowledge/KnowledgeAnalysis.test.ts test/knowledge/KnowledgeWorker.test.ts test/knowledge/KnowledgeArchive.test.ts test/knowledge/knowledgeMigrations.test.ts
```

Initial RED findings reproduced by the new tests included:
- unsafe legacy `apiKeyEnv` names still reached resolver callbacks / env access;
- naïve named-host transports could claim pinning without a single enforceable request contract;
- named-host validation and connection were split across an easy-to-misuse API;
- prompt bounding and provider safeguards needed to stay green under the hardened contract.

## GREEN
Focused validation:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeProviderProfiles.test.ts test/knowledge/OpenAICompatibleProvider.test.ts test/knowledge/KnowledgeAnalysis.test.ts test/knowledge/KnowledgeWorker.test.ts test/knowledge/KnowledgeArchive.test.ts test/knowledge/knowledgeMigrations.test.ts
```

Result: pass (`6` files / `56` tests).

Full validation:

```bash
pnpm --filter @ariadne-dev/core test
pnpm --filter @ariadne-dev/core build
```

Results:
- full core tests: pass (`65` files / `554` tests)
- core build: pass (`tsc -p tsconfig.json`)

## Fix summary

### 1. Secret boundary locked down
- Added `KnowledgeProviderCredentialPolicy`.
- Default secret resolution now denies all env-name dereferences.
- Added `allowedLegacyEnvironmentVariables` so intentional legacy env support is explicit and exact.
- Unsafe legacy env names are quarantined before any resolver callback or env lookup and return bounded warning diagnostics.
- Approved names resolve only through the host contract; resolver callbacks receive only the single approved env binding.
- Provider profile test adapters now receive only the sanitized approved credential subset, not the caller's raw `process.env`.
- `apiKeyEnv` validation now requires the `ARIADNE_KNOWLEDGE_PROVIDER_` prefix.
- Previously persisted legacy env-var names remain readable for compatibility, but new writes enforce the dedicated prefix.

### 2. Endpoint policy made host-controlled
- Added exact-origin host policy support to `OpenAICompatibleProvider`.
- All provider requests are rejected unless the host explicitly approves the origin.
- Loopback/private fixture origins are allowed only through injected test policy.

### 3. SSRF hardening
- Replaced the old `resolveHostname + pinsResolvedHostnames + fetch` split with a single named-host `requestPinned(...)` transport operation.
- The provider now validates the resolved set and selected address before it constructs a credential-bearing pinned request payload.
- The validated pinned payload binds connection target IP/port separately from the original hostname Host/SNI metadata, making rebinding harder to misuse accidentally.
- Rejected private/reserved/loopback destinations, including IPv4-mapped and embedded IPv6-to-IPv4 forms.
- Exported clear host-policy / transport / pinned-request types plus a safe default fetch transport for literal-IP paths.
- Default transport now fails closed for named hosts unless the host injects a compliant pinned transport.
- Kept redirects disabled.
- Public requests now require both an approved origin and a safe resolved destination.

### 4. Streaming response limits and cancellation
- Replaced `response.text()` buffering with streaming reads.
- Direct provider callers now also get explicit request-prompt byte limits without JSON-slicing.
- Enforced byte limits using UTF-8 byte accounting.
- Checked `Content-Length` early but still enforced the real streamed-byte cap.
- Cancelled oversized streams immediately.
- Already-aborted parent signals now fail synchronously before fetch starts and preserve the abort reason; destination validation is covered by the same timeout/abort path.

### 5. Legacy/malformed row compatibility
- Added compatibility handling so `list/get/select` skip unsupported legacy provider rows instead of bricking.
- Added bounded redacted diagnostics via `listWithDiagnostics(...)`.
- Legacy secrets stay hidden.
- Persisted config parsing is now strict and typed; malformed rows are rejected without `String(...)`/`Number(...)` coercion or raw `TypeError` leakage.

### 6. Structured prompt bounding
- Bounded sections/symbols/relationships/pages before JSON serialization.
- Added explicit truncation metadata to prompts.
- Kept exact grounding spans intact; if grounding is too large, enrichment now returns a warning instead of silently dropping spans.
- Preserved warning-only worker integration and deterministic-fact safety.

## Security / audit notes
- No provider secret values are written to SQLite, archives, exports, logs, job results, or diagnostics.
- `knowledge_provider_profiles.configuration_json` remains omitted from archives.
- Authorization data and response excerpts are redacted and bounded.
- Provider output must still match the strict schema and exact deterministic grounding before enrichment is accepted.
- Optional enrichment remains warning-only; deterministic generation/reconciliation behavior is unchanged.

## Files changed
- `packages/core/src/index.ts`
- `packages/core/src/knowledge/KnowledgeProviderProfiles.ts`
- `packages/core/src/knowledge/providers/OpenAICompatibleProvider.ts`
- `packages/core/test/knowledge/KnowledgeProviderProfiles.test.ts`
- `packages/core/test/knowledge/OpenAICompatibleProvider.test.ts`
- `task-9-report.md`

## Remaining concerns
- None beyond the explicit host contract: named hosts still require a host-supplied pinned transport implementation, and plain-HTTP loopback endpoints must use literal loopback IPs.
