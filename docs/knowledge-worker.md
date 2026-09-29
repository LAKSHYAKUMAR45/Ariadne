# Knowledge Worker

The Ariadne knowledge worker is an **offline-first** queue processor for
knowledge projects. It turns queued `analyze` jobs into deterministic
extractions, exact-span search records, graph relationships, and generated
pages using only the local workspace state database plus immutable source
content stored under `.ariadne/knowledge/sources/`.

It does **not** require nodem2, cloud sync, SSH access, deployment, or any
external provider for baseline operation. Knowledge transfer between
workspaces remains `ariadne knowledge export` / `ariadne knowledge import`;
cloud sync still covers task-memory data only.

## Commands

```bash
ariadne knowledge worker run <project-id> --once [--concurrency 1] [--worker <id>] [--json]
ariadne knowledge worker run <project-id> --watch [--poll-ms <n>] [--concurrency 1] [--worker <id>]
ariadne knowledge worker status <project-id> [--json]

ariadne knowledge provider add <project-id> <profile-name> \
  --kind openai-compatible --endpoint <url> --model <model> \
  --capabilities <csv> [--timeout-ms <n>] [--api-key-env <name>]
ariadne knowledge provider list <project-id> [--json]
ariadne knowledge provider test <project-id> <profile-name> [--json]
ariadne knowledge provider enable <project-id> <profile-name> [--json]
ariadne knowledge provider disable <project-id> <profile-name> [--json]
ariadne knowledge provider remove <project-id> <profile-name> [--json]
```

`--once` drains the currently eligible jobs and exits. A second `--once` run
claims `0` when nothing new is queued. `--watch` keeps polling until interrupted
with `SIGINT`/`SIGTERM`; the CLI installs scoped handlers, aborts cleanly, and
removes those handlers before exit. `--watch` rejects `--json` to preserve the
single-object JSON contract.

`--concurrency` is currently bounded to `1`. The CLI rejects larger values
instead of pretending to run multiple workers without a reviewed lease-safe
multi-worker adapter.

## Recommended workflow

1. Create or reuse a project: `ariadne knowledge project list|create`.
2. Ingest sources: `ariadne knowledge ingest file|folder`.
3. Drain the queue locally: `ariadne knowledge worker run <project-id> --once`.
4. Inspect status: `ariadne knowledge worker status <project-id>`.
5. Search or review the results: `knowledge search`, `page list`, `review list`.
6. Retry any failed jobs explicitly: `ariadne knowledge queue retry <job-id>`.

`knowledge queue claim` remains available for debugging, but normal operation
should use the worker commands. Claims are now **project-scoped**, so the worker
only drains jobs belonging to the requested project.

## Offline guarantees

Without any provider profile, or when no safely usable enabled profile exists,
the worker still completes deterministic processing:

- immutable source-version loading from `.ariadne/knowledge/sources/`
- analyzer extraction with exact spans
- extraction persistence
- graph materialization
- deterministic page generation
- content-backed lexical search

Provider enrichment is optional and warning-only. A provider timeout, unsafe
host, missing env var, or invalid provider response must not roll back a
successful deterministic run.

## Synthetic worker acceptance

The core test suite includes an offline regression over original, minimal
Python fixtures shaped around task-manager patterns. It runs the real worker,
then scores a stable `naas-v1` fixture corpus.

Run the evaluator and synthetic worker acceptance from the repository root
with:

```bash
pnpm --filter @ariadne-dev/core run test:knowledge:evaluation
```

The synthetic worker report always uses this JSON shape:

- `corpusVersion`
- `questionCount`
- `top1PathHits`
- `top3PathHits`
- `spanCitationHits`
- `typedGraphEvidenceHits`
- `failures[]`, one entry per required question that misses a gated criterion
  (top-three path, span citation, or typed graph evidence). A top-one miss
  alone never records a failure. Each failure contains only:
  - `id`
  - `prompt`
  - `expectedPaths`
  - `returnedPaths`
  - `missing`

Evidence is intentionally bounded to paths and boolean hit metrics. The report
must not serialize snippets, source contents, provider responses, arbitrary
metadata, or other result payloads, which makes it safe to write outside the
repository for local scoring artifacts.

The synthetic acceptance requires:

- `questionCount === 10`
- `top3PathHits >= 8`
- `spanCitationHits === 10`
- `typedGraphEvidenceHits >= 8`
- no jobs left queued or running

These thresholds are declared as `KNOWLEDGE_ACCEPTANCE_THRESHOLDS` in
`packages/core/test/knowledge/KnowledgeSearchEvaluator.ts` and enforced by
`evaluateKnowledgeAcceptanceGate`. `top1PathHits` is reported for optimization
only and is not gated; `failures` may therefore be non-empty (or top-one may
miss) while the acceptance gate still passes.

The real NAAS scorer remains a separate read-only local validation step. It is
not part of CI, does not call providers, and should only read existing local
state when comparing deterministic search output against external evidence.

Run the synthetic worker acceptance alone with:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeWorker.naas.test.ts
```

## Status output

`knowledge worker status` reports bounded project-local metadata only:

- queued/running/completed/failed/cancelled counts
- active worker count, active leased running-job count, and lease expiries
- oldest queued job timestamp and age
- recent failure codes
- analyzer ids/versions currently persisted
- deterministic, enriched, and unknown completion totals

On database open, Ariadne performs a one-time knowledge-job completion-mode
backfill for legacy completed rows whose `result_processing_mode` is still
missing. The migration runs transactionally, parses legacy `result_json`
payloads in bounded ID-ordered batches, and stores one of:

- `deterministic`
- `enriched`
- `unknown` for missing/malformed/unrecognized legacy results

After that one-time backfill, `knowledge worker status` uses only indexed
aggregate SQL over persisted `result_processing_mode` values. It does **not**
scan and `JSON.parse(...)` completed results at status time. When unknown rows
exist, status exposes `unknownCompletionCount` and a bounded warning so callers
can distinguish malformed legacy history from deterministic/enriched totals.

`queue.runningCount` is the raw database count of jobs still marked `running`.
Active worker counts/details are stricter: they only include rows whose
`lease_expires_at` is still greater than the single observation time used for
that status snapshot, so expired leases do not look active.

It does **not** print source contents, full private filesystem paths, provider
responses, environment-variable values, or secret material.

## Provider profiles and secret handling

Provider profiles use the Task 9 store and persist only non-secret metadata:

- profile name
- provider kind
- endpoint
- model
- capabilities
- timeout
- `apiKeyEnv` name
- enabled flag

Literal `--api-key` values are intentionally unsupported and remain an unknown
CLI option. Secrets stay in environment variables only.

For local CLI usage:

- loopback HTTP profiles are limited to the exact literals `127.0.0.1` and
  `[::1]`
- named/public hosts require an explicitly approved exact origin
- public named-host requests still fail closed because the CLI does not ship a
  reviewed production `requestPinned(...)` transport

That means local loopback OpenAI-compatible servers can be tested directly, but
public named hosts remain disabled by default even if a profile is stored.

## Retry and failure handling

Failed jobs keep a stable failure code and can be retried with:

```bash
ariadne knowledge queue retry <job-id>
```

Use `knowledge worker status` to identify recent failure codes, then inspect
individual jobs with `knowledge queue show <job-id>`. If the failure was caused
by unsafe provider configuration, missing env vars, or a public named-host
policy rejection, fix the configuration first and then retry.

## Export/import boundary

Knowledge pages, sources, queue results, and graph data move between
workspaces through `knowledge export` / `knowledge import`. Provider profile
configuration is intentionally omitted from exported archives, and cloud sync
does not move knowledge data.
