# Knowledge Benchmark Baseline Design

## Purpose

Establish a reproducible, local-first benchmark for Ariadne's offline knowledge
worker and retrieval pipeline. The benchmark measures retrieval quality,
grounding, worker efficiency, latency, storage, determinism, correctness, and
privacy using the production SQLite, source-storage, queue, worker, search, and
graph implementations.

The first baseline is an evidence-producing engineering benchmark, not a claim
of general performance against public datasets. It must report what was
measured, fail when required correctness or privacy properties are violated,
and serialize unsupported benchmark families as `not_measured`.

## Goals

- Exercise the complete deterministic knowledge path from source registration
  through queued analysis, graph materialization, search, and evidence checks.
- Extend the existing `naas-v1` acceptance corpus with standard retrieval
  metrics while preserving its current release gates.
- Measure cold construction, worker throughput, incremental processing, search
  latency, storage, memory, and repeated-run determinism.
- Produce stable, sanitized JSON and Markdown reports that can be committed and
  compared with future baselines.
- Keep every baseline operation offline and safe for local and CI execution.
- Separate machine-dependent observations from portable pass/fail gates.

## Non-goals

- No provider calls, embeddings, remote datasets, SSH, deployment, sync, or
  external service access.
- No ranking, indexing, worker, or graph behavior changes solely to improve the
  first reported numbers.
- No universal latency, throughput, memory, or storage budgets in baseline v1.
- No claim of CodeSearchNet, RepoBench, BEIR, MTEB, ALCE, VIBE, or other public
  benchmark performance without importing and running a reviewed adapter and
  dataset.
- No production telemetry, background benchmark daemon, dashboard, or public
  benchmark download command.
- No raw source contents, prompts, secrets, absolute workspace paths, or
  provider payloads in committed reports.

## Benchmark authority and corpus

Baseline v1 uses the repository-owned synthetic fixture at
`packages/core/test/knowledge/fixtures/naas/`:

- corpus version: `naas-v1`;
- eight synthetic Python source files;
- ten required retrieval questions;
- one or more acceptable source paths per question;
- expected symbols used to verify typed graph evidence.

The fixture corpus is release authority for baseline v1 because it is
deterministic, reviewable, offline, and already accepted by the knowledge
worker tests. The runner derives and records:

- a SHA-256 digest over normalized relative paths and exact file bytes;
- source count and total source bytes;
- corpus version and required question count.

The digest changes when fixture inputs change. A changed digest creates a new
baseline identity even if the human-readable corpus version was not updated.
The benchmark must reject duplicate question IDs, empty expected paths, invalid
question shapes, missing fixture files, and path traversal outside the fixture
root.

## Architecture

The benchmark is a Vitest-backed harness inside `packages/core/test/knowledge`.
It reuses production code and adds benchmark-only orchestration and reporting.

The implementation is divided into focused units:

1. **Fixture harness**
   - creates an isolated temporary workspace and file-backed SQLite database;
   - applies production knowledge migrations;
   - registers the benchmark project and fixture source versions;
   - enqueues production analysis jobs;
   - exposes the database, queue, source store, project ID, corpus, and cleanup.
2. **Metric library**
   - calculates retrieval metrics, percentiles, throughput, storage
     amplification, and deterministic digests from explicit inputs;
   - contains no filesystem, clock, or database side effects.
3. **Benchmark runner**
   - runs cold construction, worker drain, search warm-up and samples,
     incremental update, correctness checks, privacy checks, and a second
     deterministic comparison run;
   - uses monotonic high-resolution timing;
   - records raw detail only in memory.
4. **Report serializer**
   - converts the in-memory result to an allowlisted, versioned report;
   - removes queries, source content, temporary paths, environment values, and
     per-result snippets;
   - writes deterministic JSON and derived Markdown.
5. **Vitest entry point**
   - executes the benchmark through an explicit package script;
   - fails on quality, correctness, privacy, schema, or determinism gate
     violations;
   - leaves performance observations informational in baseline v1.

The implementation extracts the shared fixture setup used by
`KnowledgeWorker.naas.test.ts` into the benchmark fixture harness. The
acceptance test remains readable and continues to exercise the same production
path through that harness.

## Execution protocol

### Isolation

Each measured run uses:

- a new temporary workspace;
- a new file-backed SQLite database;
- a stable benchmark project ID within that isolated database;
- a fixed logical timestamp where production semantics allow it;
- production migrations, stores, queue, worker, search, and graph code;
- no enabled provider profile and no network transport.

Temporary paths are deleted in `finally`. Failure to clean up is reported as a
test failure rather than silently ignored.

### Cold construction and worker drain

The cold phase starts before opening and migrating the file-backed database and
ends after all fixture sources are registered and analysis jobs are queued.
The worker phase starts immediately before `KnowledgeWorker.runOnce` and ends
after it returns.

The runner verifies that:

- every fixture source has one current source version;
- one analysis job exists per fixture source;
- no job remains `queued` or `running`;
- each terminal job is `completed`, or is `failed` with a non-empty failure
  code;
- the release-quality gates cannot pass if a required source job failed.

### Search timing

Search timing uses production source search against the fully processed
project.

1. Run every corpus query once as an untimed warm-up.
2. Run the full ordered query set for a configurable number of timed rounds.
3. Default to 30 timed rounds, producing 300 samples for `naas-v1`.
4. Measure each search call with `process.hrtime.bigint()`.
5. Store durations internally in nanoseconds and report milliseconds rounded
   to three decimal places.
6. Calculate p50, p95, and p99 using the nearest-rank method over the complete
   sorted sample set.

The benchmark records the configured rounds and resulting sample count. Timed
search results must produce the same deterministic projection as the untimed
quality run.

### Incremental update

The incremental phase makes one deterministic, semantics-preserving change to
a copied fixture source, registers the resulting source version, enqueues its
analysis job, and drains the worker again. The change is defined in benchmark
code and must not modify tracked fixture files.

The measurement begins before registering the new version and ends after the
incremental worker drain. The runner verifies:

- exactly one fixture source gains one version;
- unrelated source versions remain unchanged;
- no duplicate current source version or duplicate active job is created;
- the updated job reaches a valid terminal state;
- the required quality and grounding gates still pass.

### Memory observation

The runner samples `process.memoryUsage().rss` at these boundaries:

- before cold construction;
- after source registration and queueing;
- after initial worker drain;
- after timed search;
- after incremental processing.

The report includes the starting RSS, peak observed RSS, and peak-minus-start
delta in bytes. These are coarse process observations, not isolated heap costs,
and are informational in baseline v1.

### Determinism

The runner performs a second clean build with the same corpus and configuration.
It compares a canonical projection containing:

- corpus identity;
- aggregate quality and grounding metrics;
- ordered result IDs, kinds, titles, citation spans, scores, and search
  confidence for each fixture question;
- aggregate graph node and edge identities and types;
- terminal job outcomes.

Timing, RSS, SQLite byte size, timestamps, temporary paths, generated database
row IDs that are not contractually deterministic, and environment metadata are
excluded. Canonical object keys and arrays are sorted by explicit stable keys
before SHA-256 hashing. Both runs must produce the same digest.

## Metrics

### Retrieval quality

Only required corpus questions contribute to the quality denominator.

- **Recall@1, Recall@3, Recall@10**: fraction of questions for which at least
  one expected path appears in the first `k` results.
- **MRR**: mean reciprocal rank of the first expected path; a miss contributes
  zero.
- **nDCG@10**: binary relevance discounted cumulative gain at rank 10 divided
  by the ideal gain for `min(expectedPaths.length, 10)` relevant results.
- **Zero-result rate**: fraction of questions returning no results.
- **Ambiguity rate**: fraction of questions whose leading result has
  `searchConfidence === 'ambiguous'`.
- **Exact-span citation rate**: fraction of questions where an expected path is
  returned with at least one non-null persisted citation span.
- **Typed-graph evidence rate**: fraction of questions where at least one
  expected path has an expected symbol connected by a supported typed edge with
  explicit or semantic evidence.

All rates are serialized as numbers in the closed interval `[0, 1]`, rounded to
six decimal places. Counts are included alongside rates.

### Worker and system observations

- cold database/index construction duration;
- initial worker queue-drain duration;
- completed jobs per second;
- fixture source bytes processed per second;
- incremental-update duration;
- search p50, p95, and p99 latency;
- SQLite main database, WAL, and SHM bytes after checkpointing;
- total SQLite bytes;
- storage amplification: total SQLite bytes divided by fixture source bytes;
- starting and peak observed RSS and RSS delta;
- deterministic result digest.

Throughput is reported only when the worker duration is greater than zero.
Storage amplification is reported only when fixture source bytes are greater
than zero. Invalid denominators fail report construction.

## Gates

### Quality gates

Baseline v1 preserves the existing `naas-v1` acceptance contract:

- exactly ten required questions;
- at least 8/10 Recall@3 hits;
- 10/10 exact-span citation hits;
- at least 8/10 typed-graph evidence hits.

Recall@1, Recall@10, MRR, nDCG@10, zero-result rate, and ambiguity rate are
reported for diagnosis and future threshold calibration. They do not weaken or
replace the existing gate.

### Correctness gates

The benchmark fails on:

- cross-project search leakage from a sentinel project;
- claiming or processing a job under the wrong project;
- duplicate current source versions or duplicate active jobs;
- invalid terminal job state or a failed required source job;
- loss of citations or typed graph provenance below the quality gates;
- unequal deterministic digests across clean repeated runs;
- archive import accepting a mismatched project or undeclared columns.

Archive safety may be verified by focused existing regression tests invoked by
the benchmark validation script rather than by importing an archive during
every timed run. Those checks are pass/fail evidence and are excluded from
performance timing.

### Privacy gates

The runner seeds synthetic secret and PII canaries that are safe to store in
test code but must never appear in reports. The report serializer rejects any
output containing:

- fixture source content or snippets;
- raw corpus prompts;
- secret or PII canary values;
- environment-variable values;
- provider request or response data;
- absolute paths or the temporary workspace root;
- analytics salts or raw query/result identifiers.

Reports may include safe corpus question IDs, relative fixture identifiers,
aggregate counts, metric values, digests, and sanitized environment metadata.
The privacy scan runs against both JSON and Markdown bytes before either file is
accepted.

### Performance policy

Performance metrics are observational in baseline v1. The benchmark records
them but does not fail because a duration, throughput, RSS, or storage value is
worse than an arbitrary machine-independent limit.

Future hard budgets require multiple accepted runs on a named environment,
documented variance, and a separate approved specification change. Correctness,
quality, privacy, and determinism gates are immediate and machine-independent.

## Report contract

The report schema version is `knowledge-benchmark-report-v1`. The committed
artifacts are:

- `docs/benchmarks/knowledge-baseline-v1.json`;
- `docs/benchmarks/knowledge-baseline-v1.md`.

The JSON report is authoritative. Markdown is a deterministic human-readable
projection of the same allowlisted data. The JSON top-level shape is:

```ts
interface KnowledgeBenchmarkReportV1 {
  schemaVersion: 'knowledge-benchmark-report-v1';
  benchmarkId: string;
  generatedAt: string;
  git: {
    commit: string;
    dirty: boolean;
  };
  environment: {
    node: string;
    platform: string;
    architecture: string;
    cpuModel: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
  };
  configuration: {
    corpusVersion: string;
    corpusDigest: string;
    sourceCount: number;
    sourceBytes: number;
    requiredQuestionCount: number;
    searchWarmupRounds: 1;
    searchTimedRounds: number;
    searchSampleCount: number;
  };
  gates: {
    passed: boolean;
    quality: GateResult;
    correctness: GateResult;
    privacy: GateResult;
    determinism: GateResult;
  };
  quality: {
    recallAt1: MetricCountRate;
    recallAt3: MetricCountRate;
    recallAt10: MetricCountRate;
    meanReciprocalRank: number;
    ndcgAt10: number;
    zeroResultRate: MetricCountRate;
    ambiguityRate: MetricCountRate;
    exactSpanCitationRate: MetricCountRate;
    typedGraphEvidenceRate: MetricCountRate;
  };
  performance: {
    policy: 'observational';
    coldConstructionMs: number;
    workerDrainMs: number;
    completedJobsPerSecond: number;
    sourceBytesPerSecond: number;
    incrementalUpdateMs: number;
    searchLatencyMs: { p50: number; p95: number; p99: number };
    sqliteBytes: { main: number; wal: number; shm: number; total: number };
    storageAmplification: number;
    rssBytes: { start: number; peak: number; delta: number };
  };
  determinism: {
    digestAlgorithm: 'sha256';
    firstRunDigest: string;
    secondRunDigest: string;
    matched: boolean;
  };
  publicBenchmarks: Array<{
    name: string;
    status: 'not_measured';
    reason: string;
  }>;
}
```

`benchmarkId` is derived from the schema version, corpus version, corpus digest,
Git commit, and benchmark configuration. `generatedAt` is an ISO 8601 UTC
timestamp and is the only wall-clock value in the committed report.

The public benchmark list includes CodeSearchNet, RepoBench, BEIR/MTEB, ALCE,
and VIBE with `status: 'not_measured'` and a factual reason. The serializer
cannot accept a score for an adapter that was not executed.

## Environment metadata

The report records enough sanitized context to interpret observations:

- exact Git commit and dirty status;
- Node version;
- operating-system platform and CPU architecture;
- CPU model and logical CPU count;
- total system memory;
- corpus and benchmark configuration.

It does not record hostname, username, home directory, repository path,
environment variables, IP addresses, serial numbers, or arbitrary command
output. A dirty run may be used diagnostically, but an authoritative committed
baseline must be generated from a clean benchmark branch at the commit that
contains the runner.

## Commands and developer workflow

`packages/core/package.json` will expose:

- `test:knowledge:benchmark` for metric, serializer, privacy, and runner tests;
- `benchmark:knowledge` for the explicit measured run and report generation.

The root package exposes `benchmark:knowledge` as a convenience wrapper.
Ordinary `pnpm test` runs correctness tests but must not rewrite committed
benchmark reports. Only the explicit benchmark command writes report artifacts.

The measured command exits non-zero when any required gate fails, report
sanitization fails, output differs from the report schema, cleanup fails, or
the report cannot be written atomically. It writes to temporary sibling files,
validates both projections, and renames them only after all gates pass.

## Testing strategy

Implementation follows RED -> GREEN -> IMPROVE:

1. Metric unit tests cover hits, misses, multiple acceptable paths, reciprocal
   rank, nDCG, ambiguity, zero results, rounding, invalid denominators, and
   nearest-rank percentiles.
2. Serializer tests cover canonical ordering, stable digest calculation,
   schema validation, Markdown projection, atomic output, and every prohibited
   data class.
3. Fixture-harness tests cover source registration, queueing, cleanup,
   project isolation, duplicate prevention, incremental versioning, and
   deterministic projections.
4. Runner tests use the production local pipeline and verify all quality,
   correctness, privacy, and determinism gates.
5. Focused archive-import regressions verify mismatched-project and undeclared
   column rejection outside measured timing.
6. Validation runs focused benchmark tests, the full core suite and build, and
   then repository lint, build, and tests before integration.

## Public benchmark roadmap

Public benchmark support is deliberately adapter-based and deferred:

1. review dataset license, redistribution terms, and privacy implications;
2. pin a dataset version and digest;
3. add an offline import step separate from measured execution;
4. map dataset relevance judgments to the same metric library;
5. record adapter and dataset identity in a new report schema or compatible
   additive section;
6. execute the adapter before changing its status from `not_measured`.

Synthetic `naas-v1` results must never be presented as a proxy score for a
public benchmark.
