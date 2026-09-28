# Task 10 Report — Offline Worker CLI and Provider Management

## Scope

Implemented Task 10 across the CLI/documentation surfaces and the tightly
coupled core worker/provider fixes the CLI exposed:

- `packages/cli/src/knowledgeCommands.ts`
- `packages/cli/test/knowledgeCommands.test.ts`
- `packages/core/src/knowledge/KnowledgeWorker.ts`
- `packages/core/test/knowledge/KnowledgeWorker.test.ts`
- `packages/core/src/knowledge/providers/OpenAICompatibleProvider.ts`
- `packages/core/test/knowledge/OpenAICompatibleProvider.test.ts`
- `.github/skills/ariadne/SKILL.md`
- `.github/agents/ariadne.agent.md`
- `docs/knowledge-worker.md`

The unrelated unstaged plan file
`docs/superpowers/plans/2026-09-24-ariadne-knowledge-wiki-plan.md` was left
untouched.

## RED

Initial RED command:

```bash
pnpm --filter @ariadne-dev/cli test -- knowledgeCommands.test.ts
```

Initial failures reproduced before implementation:

- `error: unknown command 'worker'`
- `error: unknown command 'provider'`

Follow-on CLI integration RED revealed one core correctness issue after the
worker commands existed:

- CLI-ingested sources still stored mutable workspace-relative content paths,
  so `knowledge worker run --once` failed with
  `source_path_rejected: Knowledge source content path must stay within .ariadne/knowledge/sources`
- `OpenAICompatibleEnrichmentService` reported an empty "success" result when
  no enabled provider profile existed, causing deterministic-only runs to be
  counted as enriched
- `worker status` undercounted active workers once the bounded lease list was
  truncated
- provider failure warnings still risked surfacing response/prompt excerpts in
  persisted warnings and CLI JSON
- warning-only enrichment failures could still count as enriched, and status
  warnings were not yet capped

## GREEN

Required validation order:

```bash
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/core test -- KnowledgeQueue.test.ts knowledgeMigrations.test.ts
pnpm --filter @ariadne-dev/cli test -- knowledgeCommands.test.ts
pnpm --filter @ariadne-dev/cli test
pnpm --filter @ariadne-dev/cli build
node packages/cli/dist/index.js knowledge worker --help
node packages/cli/dist/index.js knowledge provider --help
```

Results:

- core build: pass (`tsc -p tsconfig.json`)
- targeted core suites: pass (`65` files / `566` tests)
- focused CLI suite: pass (`12` files / `128` tests)
- full CLI suite: pass (`12` files / `128` tests)
- CLI build: pass (`tsc -p tsconfig.json`)
- help verification: pass; both `knowledge worker` and `knowledge provider`
  trees list the documented commands

## CLI contracts implemented

### Worker commands

- `knowledge worker run <project-id> --once [--concurrency <n>] [--worker <id>] [--json]`
- `knowledge worker run <project-id> --watch [--poll-ms <n>] [--concurrency <n>] [--worker <id>]`
- `knowledge worker status <project-id> [--json]`

Behavior:

- `--once` drains currently eligible project-scoped jobs and exits
- repeat `--once` claims `0` when the queue is already drained
- `--watch` installs scoped `SIGINT`/`SIGTERM` handlers, aborts cleanly, and
  removes those handlers in `finally`
- `--watch --json` is rejected to preserve the single JSON envelope contract
- `--concurrency > 1` is rejected explicitly instead of pretending to run
  unsupported multi-worker concurrency
- status returns bounded queue counts, active worker leases, oldest queued
  timing, recent failure codes, analyzer versions, deterministic/enriched
  completion totals, and provider-profile diagnostics without exposing source
  contents, private paths, provider responses, or secret values

### Provider commands

- `knowledge provider add <project-id> <profile-name> --kind openai-compatible --endpoint <url> --model <model> --capabilities <csv> [--timeout-ms <n>] [--api-key-env <name>]`
- `knowledge provider list <project-id> [--json]`
- `knowledge provider test <project-id> <profile-name> [--json]`
- `knowledge provider enable <project-id> <profile-name> [--json]`
- `knowledge provider disable <project-id> <profile-name> [--json]`
- `knowledge provider remove <project-id> <profile-name> [--json]`

Behavior:

- Task 9 profile storage is used as-is; only env-var names persist
- literal `--api-key` remains an unknown/rejected option
- loopback literal HTTP profiles can be tested locally
- named/public hosts fail closed because the CLI does not provide a reviewed
  production `requestPinned(...)` transport
- missing env vars return safe diagnostics naming the env var only
- provider test/list JSON output is redacted and bounded

## Fix summary

### 1. Worker and provider command trees added

- Added `knowledge worker run/status` and `knowledge provider add/list/test/enable/disable/remove`
  under the existing Commander-based knowledge surface
- Reused `runKnowledgeAction(...)` and `withKnowledgeDb(...)` so success/error
  envelopes stay consistent

### 2. CLI worker construction now stays local-first

- Added `createCliKnowledgeWorker(...)`
- Worker enrichment only wires in enabled provider profiles
- When no enabled/safe profile exists, the worker runs with deterministic-only
  behavior instead of inventing an "enriched" success state
- Watch mode uses project-scoped workers and clean abort handling

### 3. CLI ingestion now stores immutable source content correctly

- `knowledge ingest file|folder` now copies source content into
  `.ariadne/knowledge/sources/...`
- registered `contentPath` values now satisfy the Task 8 immutable source
  loader contract, so worker runs succeed against real file-backed SQLite

### 4. Provider policy is fail-closed and env-only

- CLI provider testing uses exact safe origins only
- loopback literal HTTP profiles are approved locally
- public named hosts still fail closed without downgrading to an ordinary
  unpinned fetch path
- provider failure messages now redact prompt/response excerpts instead of
  echoing source text, source paths, or provider body content
- only env-var names are persisted or echoed; secret values never appear in
  stdout/stderr/JSON

### 5. Status accounting stays correct under bounded output

- `worker status` still bounds the returned lease list, failure codes, and
  analyzer-version rows
- the status snapshot now captures one consistent `now`, keeps
  `queue.runningCount` as the raw database status count, and reports
  `activeWorkers.runningCount`/`workerCount` only for leases whose
  `lease_expires_at > now`
- expired running leases are excluded from active-worker details without
  attempting recovery in the read-only status command
- the total active worker count is computed separately, so projects with more
  than eight active workers still report the full count accurately
- provider-profile diagnostics in `worker status` are now capped too, so the
  JSON envelope stays bounded even with many malformed legacy rows

### 6. Completion-mode totals are now migration-backed and index-only at runtime

- completed jobs now always persist `result_processing_mode` alongside
  `result_json`, with new completions using one of:
  - `deterministic`
  - `enriched`
  - `unknown` when a completed row has no structured result metadata
- the base `KNOWLEDGE_SCHEMA_SQL` no longer creates the
  `idx_knowledge_jobs_project_completed_mode` index before older databases
  receive the additive `result_processing_mode` column
- migration/open now performs a **one-time transactional backfill** for legacy
  completed rows whose `result_processing_mode` is null
- the backfill parses legacy `result_json` in **bounded ordered batches** and
  stores explicit `unknown` for malformed, missing, or unrecognized results
- rollback is atomic: if any row update fails, the entire backfill transaction
  rolls back and the completion-mode index is not left half-created
- after migration, `worker status` uses **indexed aggregate SQL only**; the
  runtime no longer loops through legacy rows or calls `JSON.parse(...)` during
  status generation
- status now reports `unknownCompletionCount` plus a bounded
  `job_result_unknown` warning when legacy malformed/missing rows were migrated
  to explicit unknown mode
- the CLI/core regression coverage now includes:
  - actual pre-column/pre-v5 schema reproduction
  - large legacy-row backfill
  - malformed JSON fallback to `unknown`
  - idempotent rerun
  - transactional rollback on injected failure
  - indexed project-scoped aggregation query shape

### 7. Docs and operator guidance updated

- Added `docs/knowledge-worker.md`
- Updated `.github/skills/ariadne/SKILL.md`
- Updated `.github/agents/ariadne.agent.md`
- Documented offline guarantees, retry/status workflow, provider policy,
  env-only secrets, pinned named-host limitation, export/import boundaries,
  project-scoped claims, and no nodem2 dependency

## Additional core integration fix

`OpenAICompatibleEnrichmentService.enrich(...)` now returns no enrichment
result when no enabled profile exists, and `KnowledgeWorker` now treats both
that case and warning-only enrichment outcomes as deterministic rather than
enriched. This preserves correct job classification and aligns CLI worker
status totals with actual provider use.

## Files changed

- `.github/agents/ariadne.agent.md`
- `.github/skills/ariadne/SKILL.md`
- `docs/knowledge-worker.md`
- `packages/cli/src/knowledgeCommands.ts`
- `packages/cli/test/knowledgeCommands.test.ts`
- `packages/core/src/knowledge/KnowledgeQueue.ts`
- `packages/core/src/knowledge/KnowledgeWorker.ts`
- `packages/core/src/knowledge/knowledgeMigrations.ts`
- `packages/core/src/knowledge/knowledgeSchema.ts`
- `packages/core/src/migrations.ts`
- `packages/core/test/knowledge/KnowledgeQueue.test.ts`
- `packages/core/test/knowledge/KnowledgeWorker.test.ts`
- `packages/core/test/knowledge/knowledgeMigrations.test.ts`
- `packages/core/src/knowledge/providers/OpenAICompatibleProvider.ts`
- `packages/core/test/knowledge/OpenAICompatibleProvider.test.ts`
- `task-10-report.md`

## Remaining concerns

- Full CLI runs still print an unrelated pre-existing noisy line
  (`AssertionError: expected 1 to be 2`) during the broader suite, but the
  suites complete green and this task did not change that behavior.
