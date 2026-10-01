# Knowledge Benchmark Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a reproducible local benchmark that measures Ariadne knowledge retrieval quality, grounding, worker efficiency, latency, storage, determinism, correctness, and privacy, then commits sanitized baseline artifacts.

**Architecture:** Add a Vitest-backed test-support harness around the production SQLite, source store, queue, worker, search, graph, and archive paths. Keep metric calculation and report serialization pure, isolate filesystem/database orchestration in a fixture and runner, and make report writing available only through an explicit benchmark script.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Node.js filesystem/crypto/os/process APIs, existing Ariadne knowledge production modules.

**Spec:** `docs/superpowers/specs/2026-09-29-knowledge-benchmark-baseline-design.md`

## Global Constraints

- Run entirely locally with no provider calls, embeddings, remote datasets, SSH, deployment, sync, or external service access.
- Use the production SQLite migrations, source storage, queue, worker, search, graph, and archive validation paths.
- Preserve the existing `naas-v1` gates: exactly 10 required questions, at least 8 Recall@3 hits, 10 exact-span citation hits, and at least 8 typed-graph evidence hits.
- Treat latency, throughput, memory, and storage as observational in report schema `knowledge-benchmark-report-v1`.
- Fail immediately on quality, correctness, privacy, determinism, schema, cleanup, or atomic-write violations.
- Never commit raw prompts, source contents, snippets, canary values, environment values, provider payloads, absolute workspace paths, hostnames, usernames, salts, or raw analytics identifiers.
- Serialize CodeSearchNet, RepoBench, BEIR/MTEB, ALCE, and VIBE as `not_measured`.
- Use one untimed warm-up round and 30 timed search rounds by default.
- Calculate p50, p95, and p99 using nearest-rank percentiles.
- Keep ordinary `pnpm test` from rewriting benchmark reports.
- Follow RED -> GREEN -> IMPROVE for each task and commit each independently reviewable increment.

---

### Task 1: Extract the deterministic NAAS benchmark fixture harness

**Files:**
- Create: `packages/core/test/knowledge/KnowledgeBenchmarkFixture.ts`
- Create: `packages/core/test/knowledge/KnowledgeBenchmarkFixture.test.ts`
- Modify: `packages/core/test/knowledge/KnowledgeWorker.naas.test.ts`

**Interfaces:**
- Consumes:
  - `parseKnowledgeAccuracyCorpus(input: unknown): KnowledgeAccuracyCorpus`
  - `openDatabase(path: string): Database.Database`
  - `applyKnowledgeMigrations(db: Database.Database): void`
  - `KnowledgeSourceStore`, `KnowledgeQueue`, and `KnowledgeWorker`
- Produces:

```ts
export interface KnowledgeBenchmarkSource {
  path: string;
  content: string;
  bytes: number;
}

export interface KnowledgeBenchmarkInput {
  corpus: KnowledgeAccuracyCorpus;
  corpusDigest: string;
  sourceBytes: number;
  sources: readonly KnowledgeBenchmarkSource[];
}

export interface KnowledgeBenchmarkHarness {
  db: Database.Database;
  databasePath: string;
  projectId: string;
  workspaceRoot: string;
  input: KnowledgeBenchmarkInput;
  seedInitialSources(): { queuedJobCount: number };
  runWorker(workerId: string): Promise<void>;
  applyIncrementalUpdate(): { sourcePath: string; sourceVersionId: string };
  cleanup(): void;
}

export function loadKnowledgeBenchmarkInput(): KnowledgeBenchmarkInput;

export function createKnowledgeBenchmarkHarness(options?: {
  databasePath?: string;
  projectId?: string;
  createdAt?: string;
}): KnowledgeBenchmarkHarness;
```

- [ ] **Step 1: Write failing input-validation and digest tests**

Create `KnowledgeBenchmarkFixture.test.ts` with tests that assert exact fixture
identity and immutability:

```ts
describe('loadKnowledgeBenchmarkInput', () => {
  it('loads the versioned corpus and eight deterministic sources', () => {
    const input = loadKnowledgeBenchmarkInput();

    expect(input.corpus.corpusVersion).toBe('naas-v1');
    expect(input.corpus.questions.filter(({ required }) => required)).toHaveLength(10);
    expect(input.sources.map(({ path }) => path)).toEqual([
      'task-managers/configlet.py',
      'task-managers/deployment.py',
      'task-managers/device.py',
      'task-managers/gnmi.py',
      'task-managers/pytest_bootstrap.py',
      'task-managers/remote_access.py',
      'task-managers/topology.py',
      'task-managers/use_case.py',
    ]);
    expect(input.sourceBytes).toBeGreaterThan(0);
    expect(input.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns fresh arrays while preserving the same digest', () => {
    const first = loadKnowledgeBenchmarkInput();
    const second = loadKnowledgeBenchmarkInput();

    expect(first).not.toBe(second);
    expect(first.sources).not.toBe(second.sources);
    expect(first.corpusDigest).toBe(second.corpusDigest);
  });
});
```

- [ ] **Step 2: Run the fixture tests to verify RED**

Run:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeBenchmarkFixture.test.ts
```

Expected: FAIL because `KnowledgeBenchmarkFixture.ts` does not exist.

- [ ] **Step 3: Implement deterministic fixture loading**

In `KnowledgeBenchmarkFixture.ts`:

- resolve the fixture root from `process.cwd()/test/knowledge/fixtures/naas`;
- use the explicit sorted source-path allowlist shown in Step 1;
- reject any resolved source path that is outside the fixture root;
- read `questions.json` as `unknown` and call
  `parseKnowledgeAccuracyCorpus`;
- compute each source byte count with `Buffer.byteLength(content, 'utf8')`;
- compute SHA-256 over repeated
  `path + "\0" + byteLength + "\0" + content + "\0"` entries in allowlist
  order plus the exact `questions.json` bytes.

Use copies for returned arrays and corpus fields. Do not scan the fixture
directory dynamically.

- [ ] **Step 4: Write failing harness lifecycle tests**

Add tests:

```ts
describe('createKnowledgeBenchmarkHarness', () => {
  it('seeds one current version and one queued job per source', () => {
    const harness = createKnowledgeBenchmarkHarness();
    try {
      expect(harness.seedInitialSources()).toEqual({ queuedJobCount: 8 });
      expect(harness.db.prepare(
        `SELECT COUNT(*) AS count FROM knowledge_source_versions
         WHERE project_id = ? AND is_current = 1`,
      ).get(harness.projectId)).toEqual({ count: 8 });
      expect(harness.db.prepare(
        `SELECT COUNT(*) AS count FROM knowledge_jobs
         WHERE project_id = ? AND status = 'queued'`,
      ).get(harness.projectId)).toEqual({ count: 8 });
    } finally {
      harness.cleanup();
    }
  });

  it('creates exactly one incremental version and queues one job', async () => {
    const harness = createKnowledgeBenchmarkHarness();
    try {
      harness.seedInitialSources();
      await harness.runWorker('fixture-initial');
      const update = harness.applyIncrementalUpdate();
      expect(update.sourcePath).toBe('task-managers/configlet.py');
      expect(harness.db.prepare(
        `SELECT COUNT(*) AS count FROM knowledge_source_versions
         WHERE project_id = ? AND source_id = (
           SELECT id FROM knowledge_sources
           WHERE project_id = ? AND source_path = ?
         )`,
      ).get(harness.projectId, harness.projectId, update.sourcePath)).toEqual({ count: 2 });
    } finally {
      harness.cleanup();
    }
  });
});
```

- [ ] **Step 5: Implement harness creation, seeding, updating, and cleanup**

Use a file-backed database by default:

```ts
const workspaceRoot = mkdtempSync(join(tmpdir(), 'ariadne-knowledge-benchmark-'));
const databasePath = options.databasePath ?? join(workspaceRoot, 'state.db');
```

Create project ID `synthetic-naas-benchmark` by default and timestamp
`2026-09-29T00:00:00.000Z`. Persist each fixture source under:

```ts
const contentPath = `sources/files/${source.path.replaceAll('/', '-')}`;
```

`applyIncrementalUpdate()` appends:

```ts
'\n# benchmark incremental refresh\n'
```

to the copied `configlet.py` content, registers it through
`KnowledgeSourceStore`, and enqueues one `analyze` job for the new version.
It must not edit the tracked fixture.

`cleanup()` closes the database first, then removes only `workspaceRoot`.
Make it idempotent and rethrow cleanup failures.

- [ ] **Step 6: Refactor the existing NAAS acceptance test**

Replace its duplicated project, file, source, queue, and worker setup with the
new harness:

```ts
const harness = createKnowledgeBenchmarkHarness({
  projectId: 'synthetic-naas-acceptance',
});
try {
  harness.seedInitialSources();
  await harness.runWorker('naas-acceptance');
  // Existing scorer and terminal-job assertions remain here.
} finally {
  harness.cleanup();
}
```

Preserve all existing quality, citation, graph, and terminal queue assertions.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm --filter @ariadne-dev/core exec vitest run \
  test/knowledge/KnowledgeBenchmarkFixture.test.ts \
  test/knowledge/KnowledgeWorker.naas.test.ts
```

Expected: both files pass and no `.knowledge-worker-naas-*` or benchmark
temporary directory remains.

- [ ] **Step 8: Commit the shared fixture harness**

```bash
git add packages/core/test/knowledge/KnowledgeBenchmarkFixture.ts \
  packages/core/test/knowledge/KnowledgeBenchmarkFixture.test.ts \
  packages/core/test/knowledge/KnowledgeWorker.naas.test.ts
git commit -m "test(knowledge): extract benchmark fixture harness"
```

### Task 2: Implement pure benchmark metrics

**Files:**
- Create: `packages/core/test/knowledge/KnowledgeBenchmarkMetrics.ts`
- Create: `packages/core/test/knowledge/KnowledgeBenchmarkMetrics.test.ts`

**Interfaces:**
- Consumes benchmark corpus questions and projected search outcomes.
- Produces:

```ts
export interface KnowledgeBenchmarkRankedResult {
  title: string;
  hasSpanCitation: boolean;
  searchConfidence: 'clear' | 'ambiguous' | null;
}

export interface KnowledgeBenchmarkQuestionOutcome {
  id: string;
  expectedPaths: readonly string[];
  results: readonly KnowledgeBenchmarkRankedResult[];
  hasTypedGraphEvidence: boolean;
}

export interface MetricCountRate {
  count: number;
  total: number;
  rate: number;
}

export interface KnowledgeBenchmarkQualityMetrics {
  recallAt1: MetricCountRate;
  recallAt3: MetricCountRate;
  recallAt10: MetricCountRate;
  meanReciprocalRank: number;
  ndcgAt10: number;
  zeroResultRate: MetricCountRate;
  ambiguityRate: MetricCountRate;
  exactSpanCitationRate: MetricCountRate;
  typedGraphEvidenceRate: MetricCountRate;
}

export function calculateKnowledgeBenchmarkQuality(
  outcomes: readonly KnowledgeBenchmarkQuestionOutcome[],
): KnowledgeBenchmarkQualityMetrics;

export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number;

export function roundMetric(value: number, digits?: number): number;
```

- [ ] **Step 1: Write failing retrieval formula tests**

Cover a hit at rank 1, a different hit at rank 4, a miss, multiple relevant
paths, span citations, graph evidence, ambiguity, and zero results:

```ts
it('calculates recall, MRR, nDCG, citation, graph, ambiguity, and zero rates', () => {
  const metrics = calculateKnowledgeBenchmarkQuality([
    {
      id: 'q1',
      expectedPaths: ['a.py'],
      results: [{ title: 'a.py', hasSpanCitation: true, searchConfidence: 'clear' }],
      hasTypedGraphEvidence: true,
    },
    {
      id: 'q2',
      expectedPaths: ['b.py'],
      results: [
        { title: 'x.py', hasSpanCitation: false, searchConfidence: 'ambiguous' },
        { title: 'y.py', hasSpanCitation: false, searchConfidence: null },
        { title: 'z.py', hasSpanCitation: false, searchConfidence: null },
        { title: 'b.py', hasSpanCitation: true, searchConfidence: null },
      ],
      hasTypedGraphEvidence: false,
    },
    {
      id: 'q3',
      expectedPaths: ['c.py'],
      results: [],
      hasTypedGraphEvidence: false,
    },
  ]);

  expect(metrics.recallAt1).toEqual({ count: 1, total: 3, rate: 0.333333 });
  expect(metrics.recallAt3).toEqual({ count: 1, total: 3, rate: 0.333333 });
  expect(metrics.recallAt10).toEqual({ count: 2, total: 3, rate: 0.666667 });
  expect(metrics.meanReciprocalRank).toBe(0.416667);
  expect(metrics.zeroResultRate).toEqual({ count: 1, total: 3, rate: 0.333333 });
  expect(metrics.ambiguityRate).toEqual({ count: 1, total: 3, rate: 0.333333 });
  expect(metrics.exactSpanCitationRate.count).toBe(2);
  expect(metrics.typedGraphEvidenceRate.count).toBe(1);
});
```

Add a separate nDCG test with two expected paths to prove the ideal denominator
uses `min(expectedPaths.length, 10)`.

- [ ] **Step 2: Write failing percentile and validation tests**

```ts
it.each([
  [0.50, 3],
  [0.95, 5],
  [0.99, 5],
])('uses nearest-rank percentile %s', (percentile, expected) => {
  expect(nearestRankPercentile([5, 1, 4, 2, 3], percentile)).toBe(expected);
});

it('rejects empty outcomes, duplicate ids, empty expected paths, and invalid numbers', () => {
  expect(() => calculateKnowledgeBenchmarkQuality([])).toThrow(/outcome/i);
  expect(() => nearestRankPercentile([], 0.5)).toThrow(/values/i);
  expect(() => nearestRankPercentile([1], 0)).toThrow(/percentile/i);
  expect(() => nearestRankPercentile([Number.NaN], 0.5)).toThrow(/finite/i);
});
```

- [ ] **Step 3: Run metric tests to verify RED**

Run:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeBenchmarkMetrics.test.ts
```

Expected: FAIL because the metric module does not exist.

- [ ] **Step 4: Implement the pure metric functions**

Use:

```ts
const discount = (rank: number): number => 1 / Math.log2(rank + 1);
const reciprocalRank = firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1);
const nearestRankIndex = Math.ceil(percentile * sorted.length) - 1;
```

For nDCG, sum binary relevance discounts through rank 10 and divide by the
ideal discounts for `min(expectedPaths.length, 10)`. Reject duplicate outcome
IDs, empty expected paths, zero outcomes, non-finite timing values, and
percentiles outside `(0, 1]`. Round public rates and scalar quality metrics to
six decimals without mutating caller arrays.

- [ ] **Step 5: Run metric tests**

Expected: all metric tests pass.

- [ ] **Step 6: Commit the metric library**

```bash
git add packages/core/test/knowledge/KnowledgeBenchmarkMetrics.ts \
  packages/core/test/knowledge/KnowledgeBenchmarkMetrics.test.ts
git commit -m "test(knowledge): add benchmark metric formulas"
```

### Task 3: Define the sanitized report model and serializer

**Files:**
- Create: `packages/core/test/knowledge/KnowledgeBenchmarkReport.ts`
- Create: `packages/core/test/knowledge/KnowledgeBenchmarkReport.test.ts`

**Interfaces:**
- Consumes `KnowledgeBenchmarkQualityMetrics` and measured runner values.
- Produces:

```ts
export const KNOWLEDGE_BENCHMARK_SCHEMA_VERSION =
  'knowledge-benchmark-report-v1' as const;

export interface GateResult {
  passed: boolean;
  violations: string[];
}

export interface KnowledgeBenchmarkReportV1 {
  schemaVersion: typeof KNOWLEDGE_BENCHMARK_SCHEMA_VERSION;
  benchmarkId: string;
  generatedAt: string;
  git: { commit: string; dirty: boolean };
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
  quality: KnowledgeBenchmarkQualityMetrics;
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

export interface KnowledgeBenchmarkPrivacyInput {
  prohibitedValues: readonly string[];
  temporaryRoots: readonly string[];
  fixtureContents: readonly string[];
  rawPrompts: readonly string[];
}

export function createKnowledgeBenchmarkReport(
  input: Omit<KnowledgeBenchmarkReportV1, 'schemaVersion' | 'benchmarkId'>,
): KnowledgeBenchmarkReportV1;

export function serializeKnowledgeBenchmarkJson(
  report: KnowledgeBenchmarkReportV1,
): string;

export function renderKnowledgeBenchmarkMarkdown(
  report: KnowledgeBenchmarkReportV1,
): string;

export function assertKnowledgeBenchmarkPrivacy(
  json: string,
  markdown: string,
  input: KnowledgeBenchmarkPrivacyInput,
): void;

export function writeKnowledgeBenchmarkArtifacts(
  outputRoot: string,
  report: KnowledgeBenchmarkReportV1,
  privacy: KnowledgeBenchmarkPrivacyInput,
): { jsonPath: string; markdownPath: string };
```

- [ ] **Step 1: Write failing schema and stable-serialization tests**

Construct a complete minimal report input and assert:

```ts
const report = createKnowledgeBenchmarkReport(validReportInput());
expect(report.schemaVersion).toBe('knowledge-benchmark-report-v1');
expect(report.benchmarkId).toMatch(/^[a-f0-9]{64}$/);
expect(Object.keys(report)).toEqual([
  'schemaVersion',
  'benchmarkId',
  'generatedAt',
  'git',
  'environment',
  'configuration',
  'gates',
  'quality',
  'performance',
  'determinism',
  'publicBenchmarks',
]);
expect(serializeKnowledgeBenchmarkJson(report)).toBe(
  serializeKnowledgeBenchmarkJson(structuredClone(report)),
);
```

Assert each required public benchmark has `status: 'not_measured'` and no score
property.

- [ ] **Step 2: Write failing privacy and atomic-write tests**

Use synthetic canaries:

```ts
const privacy = {
  prohibitedValues: ['sk-test-canary-123', 'person@example.invalid'],
  temporaryRoots: ['/tmp/private-benchmark-root'],
  fixtureContents: ['def secret_fixture_body(): pass'],
  rawPrompts: ['raw benchmark prompt'],
};
```

Assert both renderers reject reports containing any canary, `process.env`
value supplied to `prohibitedValues`, an absolute temporary path, fixture
content, or raw prompt. Spy on `renameSync` or inject a filesystem adapter so a
failure before the final rename leaves neither target artifact updated.

- [ ] **Step 3: Run report tests to verify RED**

Run:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeBenchmarkReport.test.ts
```

Expected: FAIL because the report module does not exist.

- [ ] **Step 4: Implement strict report construction**

Implement explicit object construction rather than spreading unknown input.
Validate:

- exact schema literal;
- 64-character lowercase SHA-256 digests;
- ISO 8601 UTC `generatedAt`;
- finite non-negative measurements;
- rates in `[0, 1]`;
- integer counts and sample counts;
- `searchWarmupRounds === 1`;
- `performance.policy === 'observational'`;
- both determinism digests and `matched`;
- exact required public benchmark names and statuses.

Derive `benchmarkId` by hashing stable JSON containing schema version, corpus
version, corpus digest, Git commit, and configuration fields.

- [ ] **Step 5: Implement deterministic JSON and Markdown**

JSON ends with one newline and uses two-space indentation. Markdown includes:

- baseline identity and Git state;
- gate table;
- quality table with counts/rates;
- performance observation table;
- determinism digest status;
- environment metadata;
- public benchmark `not_measured` table;
- a note that machine-dependent values are observational.

Do not include per-question paths, prompts, search snippets, source contents,
or temporary locations.

- [ ] **Step 6: Implement privacy scanning and atomic writes**

Reject non-empty prohibited strings by exact byte containment in either
artifact. Reject Unix absolute paths matching `/...` and Windows drive paths
matching `[A-Za-z]:\\...` unless they are Markdown syntax owned by the
renderer; prefer avoiding all absolute path-shaped values in the report model.

Write sibling temporary files:

```ts
const jsonTemp = `${jsonPath}.tmp-${process.pid}`;
const markdownTemp = `${markdownPath}.tmp-${process.pid}`;
```

Validate JSON parse, Markdown privacy, and target paths before renaming. On any
failure, remove only those exact temporary files and rethrow.

- [ ] **Step 7: Run report tests**

Expected: schema, determinism, privacy, Markdown, and atomic-write tests pass.

- [ ] **Step 8: Commit the report boundary**

```bash
git add packages/core/test/knowledge/KnowledgeBenchmarkReport.ts \
  packages/core/test/knowledge/KnowledgeBenchmarkReport.test.ts
git commit -m "test(knowledge): add sanitized benchmark reports"
```

### Task 4: Implement the production-path benchmark runner

**Files:**
- Create: `packages/core/test/knowledge/KnowledgeBenchmarkArchiveGate.ts`
- Create: `packages/core/test/knowledge/KnowledgeBenchmarkRunner.ts`
- Create: `packages/core/test/knowledge/KnowledgeBenchmarkRunner.test.ts`
- Modify: `packages/core/test/knowledge/KnowledgeBenchmarkFixture.ts`

**Interfaces:**
- Consumes:
  - `createKnowledgeBenchmarkHarness()`
  - `calculateKnowledgeBenchmarkQuality()`
  - `createKnowledgeBenchmarkReport()`
  - production `searchKnowledge()` and `hasKnowledgeTypedGraphEvidence()`
- Produces:

```ts
export interface KnowledgeBenchmarkRunOptions {
  generatedAt: string;
  git: { commit: string; dirty: boolean };
  environment: KnowledgeBenchmarkReportV1['environment'];
  timedSearchRounds?: number;
}

export interface KnowledgeBenchmarkRunResult {
  report: KnowledgeBenchmarkReportV1;
  privacy: KnowledgeBenchmarkPrivacyInput;
}

export interface KnowledgeBenchmarkRunnerDependencies {
  createHarness: typeof createKnowledgeBenchmarkHarness;
  hashProjection: (projection: unknown) => string;
}

export function runKnowledgeBenchmarkArchiveGate(
  sourceDb: Database.Database,
  projectId: string,
): { passed: true };

export async function runKnowledgeBenchmark(
  options: KnowledgeBenchmarkRunOptions,
  dependencies?: Partial<KnowledgeBenchmarkRunnerDependencies>,
): Promise<KnowledgeBenchmarkRunResult>;
```

- [ ] **Step 1: Write a failing full-run contract test**

```ts
it('runs the production pipeline and passes all portable gates', async () => {
  const result = await runKnowledgeBenchmark({
    generatedAt: '2026-09-29T12:00:00.000Z',
    git: { commit: 'a'.repeat(40), dirty: false },
    environment: testEnvironment(),
    timedSearchRounds: 2,
  });

  expect(result.report.gates.passed).toBe(true);
  expect(result.report.configuration).toMatchObject({
    corpusVersion: 'naas-v1',
    sourceCount: 8,
    requiredQuestionCount: 10,
    searchWarmupRounds: 1,
    searchTimedRounds: 2,
    searchSampleCount: 20,
  });
  expect(result.report.quality.recallAt3.count).toBeGreaterThanOrEqual(8);
  expect(result.report.quality.exactSpanCitationRate.count).toBe(10);
  expect(result.report.quality.typedGraphEvidenceRate.count).toBeGreaterThanOrEqual(8);
  expect(result.report.determinism.matched).toBe(true);
});
```

- [ ] **Step 2: Write failing correctness tests**

Add focused tests using the `createHarness` and `hashProjection` dependency
overrides that prove:

- a sentinel source in another project never appears in benchmark results;
- wrong-project queue claiming fails the correctness gate;
- duplicate active jobs or duplicate current versions fail the gate;
- a required source job failure fails the gate;
- unequal second-run digest fails determinism;
- temporary directories are removed after success and injected failure.

Expose no production API solely for fault injection.

- [ ] **Step 3: Run runner tests to verify RED**

Run:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeBenchmarkRunner.test.ts
```

Expected: FAIL because `runKnowledgeBenchmark` does not exist.

- [ ] **Step 4: Implement measured phases with monotonic timing**

Add:

```ts
async function measureMilliseconds<T>(
  operation: () => T | Promise<T>,
): Promise<{ value: T; durationMs: number }> {
  const start = process.hrtime.bigint();
  const value = await operation();
  const elapsed = process.hrtime.bigint() - start;
  return { value, durationMs: Number(elapsed) / 1_000_000 };
}
```

Measure:

- harness creation, migrations, source registration, and queueing as cold
  construction;
- initial `runWorker`;
- 30 timed rounds by default after one complete warm-up round;
- incremental registration and worker drain;
- RSS at all specification boundaries.

Reject `timedSearchRounds < 1` or non-integers.

- [ ] **Step 5: Project quality outcomes and enforce quality gates**

For each required corpus question:

```ts
const results = searchKnowledge(question.prompt, {
  db: harness.db,
  projectId: harness.projectId,
  mode: 'sources',
});
```

Project only title, non-null citation presence, and top-result confidence into
the metric library. Check typed graph evidence with
`hasKnowledgeTypedGraphEvidence`. Preserve the existing acceptance gate through
`scoreKnowledgeAccuracy` and `evaluateKnowledgeAcceptanceGate`, then assert the
new metrics agree with its Recall@1/Recall@3 and citation/graph counts.

- [ ] **Step 6: Implement queue, isolation, duplicate, and archive gates**

Add explicit SQL checks for:

- no queued/running job after each drain;
- one current version per source;
- no duplicate active job for `(project_id, job_kind, source_version_id)`;
- no failed job for a required source;
- no benchmark query result whose source belongs to the sentinel project.

Implement `runKnowledgeBenchmarkArchiveGate` outside measured runner timing:

1. export the completed benchmark project with `exportKnowledgeProject`;
2. clone the `knowledge_projects` table entry with an ID different from
   `manifest.projectId` and assert `importKnowledgeProject` throws an error
   matching `/matches manifest\.projectId/i`;
3. clone the first `knowledge_pages` row with an attacker-controlled key
   `"id) VALUES ('pwned'); --"` and assert import throws an error matching
   `/unknown column/i`;
4. assert the unknown-column error does not echo the attacker-controlled key;
5. close and remove the isolated import target in `finally`.

Return `{ passed: true }` only after both attacks are rejected. Do not catch an
unexpected import success or convert an assertion failure to a warning. The
`test:knowledge:benchmark` command in Task 5 also executes the complete
`KnowledgeArchive.test.ts` regression file.

- [ ] **Step 7: Implement SQLite, throughput, and memory observations**

Before measuring database bytes:

```ts
harness.db.pragma('wal_checkpoint(TRUNCATE)');
```

Sum existing main, `-wal`, and `-shm` files with absent sidecars counted as
zero. Calculate:

```ts
completedJobsPerSecond = completedJobs / (workerDrainMs / 1000);
sourceBytesPerSecond = sourceBytes / (workerDrainMs / 1000);
storageAmplification = totalSqliteBytes / sourceBytes;
```

Reject zero or invalid denominators. Record starting RSS, maximum sampled RSS,
and non-negative delta.

- [ ] **Step 8: Implement deterministic projection and second run**

Create a canonical projection with:

- corpus identity;
- quality metrics;
- each safe question ID and ordered result projection;
- graph node/edge identities and types sorted by stable keys;
- terminal job status and failure code sorted by source version and job kind.

Exclude timing, RSS, file sizes, timestamps, workspace paths, prompts, snippets,
and unstable row IDs. Stable-stringify recursively sorted object keys and hash
with SHA-256. Build the fixture a second time, compare digests, and always clean
up both harnesses in `finally`.

- [ ] **Step 9: Run runner and existing acceptance tests**

Run:

```bash
pnpm --filter @ariadne-dev/core exec vitest run \
  test/knowledge/KnowledgeBenchmarkRunner.test.ts \
  test/knowledge/KnowledgeWorker.naas.test.ts
```

Expected: all gates pass with two timed rounds in tests.

- [ ] **Step 10: Commit the runner**

```bash
git add packages/core/test/knowledge/KnowledgeBenchmarkArchiveGate.ts \
  packages/core/test/knowledge/KnowledgeBenchmarkFixture.ts \
  packages/core/test/knowledge/KnowledgeBenchmarkRunner.ts \
  packages/core/test/knowledge/KnowledgeBenchmarkRunner.test.ts
git commit -m "test(knowledge): add production benchmark runner"
```

### Task 5: Add explicit benchmark execution and report generation

**Files:**
- Create: `packages/core/test/knowledge/KnowledgeBenchmark.baseline.test.ts`
- Modify: `packages/core/package.json`
- Modify: `package.json`
- Create: `docs/benchmarks/.gitkeep`

**Interfaces:**
- Consumes `runKnowledgeBenchmark()` and `writeKnowledgeBenchmarkArtifacts()`.
- Produces package commands:
  - `pnpm --filter @ariadne-dev/core test:knowledge:benchmark`
  - `pnpm --filter @ariadne-dev/core benchmark:knowledge`
  - `pnpm benchmark:knowledge`

- [ ] **Step 1: Write the skipped-by-default baseline entry**

Create:

```ts
const writeBaseline = process.env.ARIADNE_KNOWLEDGE_BENCHMARK_WRITE === '1';

describe('knowledge benchmark baseline artifact', () => {
  it.skipIf(!writeBaseline)('writes a clean authoritative local baseline', async () => {
    // Collect sanitized Git/environment metadata.
    // Run 30 timed rounds.
    // Assert all gates passed.
    // Write docs/benchmarks/knowledge-baseline-v1.json and .md.
  });
});
```

The test must be discovered but skipped during ordinary `pnpm test`. It must
fail if the branch is dirty before execution. Ignore only the two absent target
report paths when determining the pre-run state; do not permit arbitrary dirty
files.

- [ ] **Step 2: Run the baseline entry without the environment flag**

Run:

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/knowledge/KnowledgeBenchmark.baseline.test.ts
```

Expected: one skipped test and no report files created.

- [ ] **Step 3: Implement sanitized environment and Git metadata collection**

Use `execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })` and
`execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], ...)`.
Validate the commit as 40 lowercase hexadecimal characters. Store only
commit and dirty boolean.

Use:

```ts
{
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  cpuModel: cpus()[0]?.model.trim() || 'unknown',
  logicalCpuCount: cpus().length,
  totalMemoryBytes: totalmem(),
}
```

Do not read hostname, username, home directory, IP addresses, or arbitrary
environment values into the report.

- [ ] **Step 4: Add package scripts**

In `packages/core/package.json`:

```json
"test:knowledge:benchmark": "vitest run test/knowledge/KnowledgeBenchmarkFixture.test.ts test/knowledge/KnowledgeBenchmarkMetrics.test.ts test/knowledge/KnowledgeBenchmarkReport.test.ts test/knowledge/KnowledgeBenchmarkRunner.test.ts test/knowledge/KnowledgeBenchmark.baseline.test.ts test/knowledge/KnowledgeArchive.test.ts",
"benchmark:knowledge": "ARIADNE_KNOWLEDGE_BENCHMARK_WRITE=1 vitest run test/knowledge/KnowledgeBenchmark.baseline.test.ts --reporter=verbose"
```

In root `package.json`:

```json
"benchmark:knowledge": "pnpm --filter @ariadne-dev/core benchmark:knowledge"
```

- [ ] **Step 5: Verify ordinary tests do not write reports**

Run:

```bash
rm -f docs/benchmarks/knowledge-baseline-v1.json docs/benchmarks/knowledge-baseline-v1.md
pnpm --filter @ariadne-dev/core test:knowledge:benchmark
test ! -e docs/benchmarks/knowledge-baseline-v1.json
test ! -e docs/benchmarks/knowledge-baseline-v1.md
```

Expected: focused tests pass, baseline artifact test is skipped, and neither
report exists. The targeted `rm -f` is allowed only for these two exact
generated paths.

- [ ] **Step 6: Commit the explicit benchmark command**

```bash
git add packages/core/test/knowledge/KnowledgeBenchmark.baseline.test.ts \
  packages/core/package.json package.json docs/benchmarks/.gitkeep
git commit -m "test(knowledge): add benchmark execution command"
```

### Task 6: Review TypeScript and privacy/security boundaries

**Files:**
- Modify only files identified by the required reviews.

**Interfaces:**
- Consumes all implementation from Tasks 1-5.
- Produces reviewed code with no unresolved high-confidence TypeScript,
  correctness, silent-failure, or report-exposure findings.

- [ ] **Step 1: Run the focused benchmark suite**

Run:

```bash
pnpm --filter @ariadne-dev/core test:knowledge:benchmark
```

Expected: all benchmark, archive-safety, and acceptance tests pass; artifact
generation remains skipped.

- [ ] **Step 2: Run the required TypeScript review**

Invoke the `TypeScript Reviewer` over the benchmark diff from `ad67996` through
`HEAD`. Require review of type safety, async cleanup, filesystem handling,
number validation, deterministic ordering, and package script behavior.

- [ ] **Step 3: Run the required security review**

Invoke the security reviewer over the report boundary, privacy canaries,
temporary-file writes, path confinement, Git/environment metadata collection,
and archive-safety evidence. Treat source files and generated content as
untrusted data.

- [ ] **Step 4: Run the silent-failure review**

Invoke `Silent Failure Hunter` over cleanup, optional sidecar file reads,
worker terminal-state checks, privacy scanning, and atomic output. No broad
catch may convert a failed gate or cleanup into a successful report.

- [ ] **Step 5: Fix accepted findings with regression tests first**

For every accepted finding:

1. add a failing focused regression test;
2. run it and observe the expected failure;
3. make the smallest implementation change;
4. rerun the focused file;
5. rerun `test:knowledge:benchmark`.

- [ ] **Step 6: Commit review fixes**

If files changed:

```bash
git add packages/core/test/knowledge packages/core/package.json package.json
git commit -m "fix(knowledge): harden benchmark reporting"
```

If no files changed, record the clean review result in the Ariadne checkpoint
instead of creating an empty commit.

### Task 7: Generate and commit the measured baseline

**Files:**
- Create: `docs/benchmarks/knowledge-baseline-v1.json`
- Create: `docs/benchmarks/knowledge-baseline-v1.md`

**Interfaces:**
- Consumes the clean committed runner and explicit `pnpm benchmark:knowledge`.
- Produces the authoritative baseline-v1 JSON and Markdown artifacts.

- [ ] **Step 1: Confirm the benchmark branch is clean**

Run:

```bash
git status --short
```

Expected: no output. Do not generate an authoritative baseline from a dirty
implementation branch.

- [ ] **Step 2: Run the measured baseline**

Run through Ariadne command logging:

```bash
ariadne exec pnpm benchmark:knowledge
```

Expected: PASS, 30 timed rounds, 300 search samples, all portable gates pass,
and both report files are created.

- [ ] **Step 3: Inspect artifact safety and schema**

Run:

```bash
node -e "
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync('docs/benchmarks/knowledge-baseline-v1.json', 'utf8'));
if (report.schemaVersion !== 'knowledge-benchmark-report-v1') process.exit(1);
if (!report.gates.passed || !report.determinism.matched) process.exit(1);
if (report.configuration.searchSampleCount !== 300) process.exit(1);
if (report.publicBenchmarks.some((entry) => entry.status !== 'not_measured')) process.exit(1);
"
```

Then inspect the Markdown report and Git diff. Confirm no absolute workspace
path, prompt, source content, secret/PII canary, hostname, username, or
environment value appears.

- [ ] **Step 4: Rerun the measured baseline once for variance observation**

Copy the first report to a session artifact outside the repository, rerun
`ariadne exec pnpm benchmark:knowledge`, and compare:

- quality metrics are identical;
- determinism digests are identical;
- gates remain passed;
- only generated timestamp and observational performance/environment values
  may differ.

Use the second successful run as the committed artifact and retain the first
only as an uncommitted session artifact for variance notes.

- [ ] **Step 5: Commit the baseline artifacts**

```bash
git add docs/benchmarks/knowledge-baseline-v1.json \
  docs/benchmarks/knowledge-baseline-v1.md
git commit -m "docs: record knowledge benchmark baseline"
```

### Task 8: Validate the branch and finalize task memory

**Files:**
- Modify only regressions caused by benchmark work.

**Interfaces:**
- Consumes the complete branch including measured artifacts.
- Produces a validated, review-ready benchmark branch and durable Ariadne
  checkpoint.

- [ ] **Step 1: Run focused core validation**

Run:

```bash
ariadne exec pnpm --filter @ariadne-dev/core test:knowledge:benchmark
ariadne exec pnpm --filter @ariadne-dev/core test
ariadne exec pnpm --filter @ariadne-dev/core build
```

Expected: all commands pass. The baseline test remains skipped in ordinary
test commands and committed reports remain unchanged.

- [ ] **Step 2: Run repository validation**

Run:

```bash
ariadne exec pnpm lint
ariadne exec pnpm build
ariadne exec pnpm test
```

Expected: all repository packages pass. If a pre-existing unrelated failure is
encountered, record it explicitly and do not change unrelated code.

- [ ] **Step 3: Verify artifact stability**

Run:

```bash
git status --short
git diff --exit-code -- docs/benchmarks/knowledge-baseline-v1.json \
  docs/benchmarks/knowledge-baseline-v1.md
```

Expected: clean worktree and no report rewrite from ordinary validation.

- [ ] **Step 4: Sync commits and record the milestone**

From the main Ariadne task database:

```bash
ariadne git-sync
ariadne checkpoint "Implemented and measured knowledge benchmark baseline v1 with passing quality, correctness, privacy, and determinism gates; committed sanitized JSON and Markdown results." -l milestone
```

- [ ] **Step 5: Mark workflow todos complete**

Mark `write-benchmark-plan` done after this plan commit. Mark
`run-benchmark-baseline` done only after the measured report commit and all
validation commands pass.
