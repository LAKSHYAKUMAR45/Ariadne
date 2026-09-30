import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { searchKnowledge, type KnowledgeSearchResult } from '../../src/knowledge/KnowledgeSearch.js';
import { runKnowledgeBenchmarkArchiveGate } from './KnowledgeBenchmarkArchiveGate.js';
import {
  KNOWLEDGE_BENCHMARK_SENTINEL_CANARIES,
  createKnowledgeBenchmarkHarness,
  type KnowledgeBenchmarkHarness,
} from './KnowledgeBenchmarkFixture.js';
import {
  calculateKnowledgeBenchmarkQuality,
  nearestRankPercentile,
  roundMetric,
  type KnowledgeBenchmarkQualityMetrics,
  type KnowledgeBenchmarkQuestionOutcome,
} from './KnowledgeBenchmarkMetrics.js';
import {
  assertKnowledgeBenchmarkPrivacy,
  createKnowledgeBenchmarkReport,
  renderKnowledgeBenchmarkMarkdown,
  serializeKnowledgeBenchmarkJson,
  type GateResult,
  type KnowledgeBenchmarkPrivacyInput,
  type KnowledgeBenchmarkReportV1,
} from './KnowledgeBenchmarkReport.js';
import {
  evaluateKnowledgeAcceptanceGate,
  hasKnowledgeTypedGraphEvidence,
  scoreKnowledgeAccuracy,
  type KnowledgeAccuracyQuestion,
} from './KnowledgeSearchEvaluator.js';

const DEFAULT_TIMED_SEARCH_ROUNDS = 30;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const PUBLIC_BENCHMARK_REASON = 'Not measured in the offline baseline; no reviewed adapter or dataset is bundled.';
const PUBLIC_BENCHMARK_NAMES = ['CodeSearchNet', 'RepoBench', 'BEIR/MTEB', 'ALCE', 'VIBE'] as const;

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

interface ProjectedResult {
  title: string;
  kind: string;
  hasSpanCitation: boolean;
  searchConfidence: string | null;
  score: number;
}

interface QualityPass {
  metrics: KnowledgeBenchmarkQualityMetrics;
  resultsByQuestion: Array<{ id: string; results: ProjectedResult[] }>;
  violations: string[];
}

interface JobStateRow {
  status: string;
  failure_code: string | null;
  source_path: string | null;
  version_number: number | null;
  job_kind: string;
}

async function measureMilliseconds<T>(
  operation: () => T | Promise<T>,
): Promise<{ value: T; durationMs: number }> {
  const start = process.hrtime.bigint();
  const value = await operation();
  const elapsed = process.hrtime.bigint() - start;
  return { value, durationMs: Number(elapsed) / 1_000_000 };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function defaultHashProjection(projection: unknown): string {
  return createHash('sha256').update(stableStringify(projection)).digest('hex');
}

function requireValidRounds(rounds: number): number {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error('timedSearchRounds must be an integer greater than or equal to 1');
  }
  return rounds;
}

function requirePositiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function gate(violations: readonly string[]): GateResult {
  return { passed: violations.length === 0, violations: [...violations] };
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

function requiredQuestions(harness: KnowledgeBenchmarkHarness): KnowledgeAccuracyQuestion[] {
  return harness.input.corpus.questions.filter((question) => question.required);
}

function projectResult(result: KnowledgeSearchResult): ProjectedResult {
  return {
    title: result.title,
    kind: result.kind,
    hasSpanCitation: result.citations.some((citation) => citation.span !== null),
    searchConfidence: result.searchConfidence ?? null,
    score: roundMetric(result.score),
  };
}

function searchSources(harness: KnowledgeBenchmarkHarness, prompt: string): KnowledgeSearchResult[] {
  return searchKnowledge(prompt, {
    db: harness.db,
    projectId: harness.projectId,
    mode: 'sources',
  });
}

function findSentinelLeaks(
  harness: KnowledgeBenchmarkHarness,
  sentinelProjectId: string,
  questionId: string,
  results: readonly KnowledgeSearchResult[],
): string[] {
  const lookup = harness.db.prepare('SELECT project_id FROM knowledge_sources WHERE id = ?');
  const violations: string[] = [];
  for (const result of results) {
    const owner = (lookup.get(result.id) as { project_id: string } | undefined)?.project_id;
    const leaked = result.projectId === sentinelProjectId
      || owner === sentinelProjectId
      || (result.projectId !== null && result.projectId !== harness.projectId)
      || (owner !== undefined && owner !== harness.projectId);
    if (leaked) {
      violations.push(`Sentinel project result leaked into benchmark search for ${questionId}`);
    }
  }
  return violations;
}

function runQualityPass(
  harness: KnowledgeBenchmarkHarness,
  sentinelProjectId: string,
  label: string,
): QualityPass {
  const questions = requiredQuestions(harness);
  const violations: string[] = [];
  const outcomes: KnowledgeBenchmarkQuestionOutcome[] = [];
  const resultsByQuestion: QualityPass['resultsByQuestion'] = [];

  for (const question of questions) {
    const results = searchSources(harness, question.prompt);
    violations.push(...findSentinelLeaks(harness, sentinelProjectId, question.id, results));
    const projected = results.map(projectResult);
    resultsByQuestion.push({ id: question.id, results: projected });
    outcomes.push({
      id: question.id,
      expectedPaths: question.expectedPaths,
      // A duplicated title is one document; counting it twice could push nDCG above 1.
      results: projected.filter((result, index) =>
        projected.findIndex((candidate) => candidate.title === result.title) === index,
      ).map(({ title, hasSpanCitation, searchConfidence }) => ({
        title,
        hasSpanCitation,
        searchConfidence: searchConfidence === 'clear' || searchConfidence === 'ambiguous' ? searchConfidence : null,
      })),
      hasTypedGraphEvidence: question.expectedPaths.some((sourcePath) =>
        hasKnowledgeTypedGraphEvidence(harness.db, {
          projectId: harness.projectId,
          sourcePath,
          expectedSymbols: question.expectedSymbols,
        })),
    });
  }

  const metrics = calculateKnowledgeBenchmarkQuality(outcomes);
  const legacy = scoreKnowledgeAccuracy(
    harness.input.corpus,
    (prompt) => searchSources(harness, prompt),
    (question, sourcePath) => hasKnowledgeTypedGraphEvidence(harness.db, {
      projectId: harness.projectId,
      sourcePath,
      expectedSymbols: question.expectedSymbols,
    }),
  );
  violations.push(...evaluateKnowledgeAcceptanceGate(legacy));
  const agreements: Array<[string, number, number]> = [
    ['Recall@1', metrics.recallAt1.count, legacy.top1PathHits],
    ['Recall@3', metrics.recallAt3.count, legacy.top3PathHits],
    ['exact-span citation', metrics.exactSpanCitationRate.count, legacy.spanCitationHits],
    ['typed graph evidence', metrics.typedGraphEvidenceRate.count, legacy.typedGraphEvidenceHits],
  ];
  for (const [name, actual, expected] of agreements) {
    if (actual !== expected) {
      violations.push(`${name} metric ${actual} disagrees with acceptance scorer ${expected}`);
    }
  }
  return {
    metrics,
    resultsByQuestion,
    violations: violations.map((violation) => `${label}: ${violation}`),
  };
}

function collectCorrectnessViolations(
  harness: KnowledgeBenchmarkHarness,
  label: string,
): string[] {
  const { db, projectId } = harness;
  const violations: string[] = [];
  const requiredPaths = new Set(requiredQuestions(harness).flatMap((question) => question.expectedPaths));

  if (count(db, `SELECT COUNT(*) AS count FROM knowledge_jobs WHERE project_id = ? AND status IN ('queued', 'running')`, projectId) > 0) {
    violations.push('Jobs remain queued or running after worker drain');
  }
  const jobs = db.prepare(
    `SELECT job.status, job.failure_code, job.job_kind, source.source_path, version.version_number
     FROM knowledge_jobs job
     LEFT JOIN knowledge_source_versions version
       ON version.project_id = job.project_id AND version.id = job.source_version_id
     LEFT JOIN knowledge_sources source
       ON source.project_id = version.project_id AND source.id = version.source_id
     WHERE job.project_id = ?`,
  ).all(projectId) as JobStateRow[];
  for (const job of jobs) {
    const validFailure = job.status === 'failed' && (job.failure_code ?? '').trim().length > 0;
    if (job.status !== 'completed' && !validFailure && job.status !== 'queued' && job.status !== 'running') {
      violations.push('Job reached an invalid terminal state');
    }
    if (job.status === 'failed' && job.source_path !== null && requiredPaths.has(job.source_path)) {
      violations.push(`Required source job failed for ${job.source_path}`);
    }
  }

  if (count(
    db,
    `SELECT COUNT(*) AS count FROM knowledge_jobs job
     WHERE job.source_version_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_source_versions version
         WHERE version.project_id = job.project_id AND version.id = job.source_version_id)`,
  ) > 0) {
    violations.push('Job is owned by the wrong project relative to its source version');
  }
  if (count(
    db,
    `SELECT COUNT(*) AS count FROM (
       SELECT 1 FROM knowledge_jobs
       WHERE source_version_id IS NOT NULL AND status IN ('queued', 'running')
       GROUP BY project_id, job_kind, source_version_id HAVING COUNT(*) > 1)`,
  ) > 0) {
    violations.push('Duplicate active job for a project, job kind, and source version');
  }

  const sources = db.prepare(
    `SELECT source.id, source.source_path,
            (SELECT COUNT(*) FROM knowledge_source_versions version
             WHERE version.project_id = source.project_id
               AND version.source_id = source.id
               AND version.content_hash = source.current_hash) AS current_versions
     FROM knowledge_sources source WHERE source.project_id = ?`,
  ).all(projectId) as Array<{ id: string; source_path: string; current_versions: number }>;
  const pathCounts = new Map<string, number>();
  for (const source of sources) {
    pathCounts.set(source.source_path, (pathCounts.get(source.source_path) ?? 0) + 1);
    if (source.current_versions !== 1) {
      violations.push(`Source ${source.source_path} has ${source.current_versions} current source versions`);
    }
  }
  for (const [sourcePath, occurrences] of pathCounts) {
    if (occurrences > 1) {
      violations.push(`Duplicate current source version registrations for ${sourcePath}`);
    }
  }
  return violations.map((violation) => `${label}: ${violation}`);
}

function versionCounts(db: Database.Database, projectId: string): Map<string, number> {
  const rows = db.prepare(
    `SELECT source.source_path AS path, COUNT(version.id) AS versions
     FROM knowledge_sources source
     LEFT JOIN knowledge_source_versions version
       ON version.project_id = source.project_id AND version.source_id = source.id
     WHERE source.project_id = ? GROUP BY source.id`,
  ).all(projectId) as Array<{ path: string; versions: number }>;
  return new Map(rows.map((row) => [row.path, row.versions]));
}

function verifyIncrementalUpdate(
  before: Map<string, number>,
  after: Map<string, number>,
  updatedPath: string,
): string[] {
  const violations: string[] = [];
  if (before.size !== after.size) {
    violations.push('Incremental update changed the number of sources');
  }
  for (const [path, versions] of before) {
    const expected = path === updatedPath ? versions + 1 : versions;
    if (after.get(path) !== expected) {
      violations.push(`Incremental update produced an unexpected version count for ${path}`);
    }
  }
  return violations;
}

function buildProjection(
  harness: KnowledgeBenchmarkHarness,
  quality: QualityPass,
): unknown {
  const { db, projectId, input } = harness;
  const nodes = db.prepare(
    `SELECT node.id, node.node_type, node.label, node.qualified_name, source.source_path, version.version_number
     FROM knowledge_graph_nodes node
     LEFT JOIN knowledge_source_versions version
       ON version.project_id = node.project_id AND version.id = node.source_version_id
     LEFT JOIN knowledge_sources source
       ON source.project_id = version.project_id AND source.id = version.source_id
     WHERE node.project_id = ?`,
  ).all(projectId) as Array<Record<string, string | number | null>>;
  const nodeKey = new Map(nodes.map((node) => [
    node.id,
    [node.node_type, node.label, node.qualified_name, node.source_path, node.version_number].join('|'),
  ]));
  const edges = (db.prepare(
    'SELECT source_node_id, target_node_id, edge_type FROM knowledge_graph_edges WHERE project_id = ?',
  ).all(projectId) as Array<{ source_node_id: string; target_node_id: string; edge_type: string }>)
    .map((edge) => `${nodeKey.get(edge.source_node_id)}>${edge.edge_type}>${nodeKey.get(edge.target_node_id)}`)
    .sort();
  const jobs = (db.prepare(
    `SELECT job.status, job.failure_code, job.job_kind, source.source_path, version.version_number
     FROM knowledge_jobs job
     LEFT JOIN knowledge_source_versions version
       ON version.project_id = job.project_id AND version.id = job.source_version_id
     LEFT JOIN knowledge_sources source
       ON source.project_id = version.project_id AND source.id = version.source_id
     WHERE job.project_id = ?`,
  ).all(projectId) as JobStateRow[])
    .map((job) => `${job.source_path}|${job.version_number}|${job.job_kind}|${job.status}|${job.failure_code ?? ''}`)
    .sort();

  return {
    corpus: { version: input.corpus.corpusVersion, digest: input.corpusDigest },
    quality: quality.metrics,
    questions: quality.resultsByQuestion,
    graph: { nodes: [...nodeKey.values()].sort(), edges },
    jobs,
  };
}

function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function sqliteBytes(harness: KnowledgeBenchmarkHarness): KnowledgeBenchmarkReportV1['performance']['sqliteBytes'] {
  harness.db.pragma('wal_checkpoint(TRUNCATE)');
  const main = fileBytes(harness.databasePath);
  const wal = fileBytes(`${harness.databasePath}-wal`);
  const shm = fileBytes(`${harness.databasePath}-shm`);
  return { main, wal, shm, total: main + wal + shm };
}

function cleanupAll(harnesses: readonly KnowledgeBenchmarkHarness[]): unknown[] {
  const failures: unknown[] = [];
  for (const harness of harnesses) {
    try {
      harness.cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function buildProcessedHarness(
  harness: KnowledgeBenchmarkHarness,
  workerId: string,
): Promise<{ sentinelProjectId: string }> {
  harness.seedInitialSources();
  await harness.runWorker(workerId);
  const sentinel = await harness.seedSentinelProject();
  return { sentinelProjectId: sentinel.projectId };
}

function assembleReport(
  options: KnowledgeBenchmarkRunOptions,
  body: Omit<KnowledgeBenchmarkReportV1, 'schemaVersion' | 'benchmarkId' | 'generatedAt' | 'git' | 'environment' | 'gates'>,
  gates: { quality: GateResult; correctness: GateResult; privacy: GateResult; determinism: GateResult },
): KnowledgeBenchmarkReportV1 {
  return createKnowledgeBenchmarkReport({
    generatedAt: options.generatedAt,
    git: { ...options.git },
    environment: { ...options.environment },
    gates: {
      passed: gates.quality.passed && gates.correctness.passed && gates.privacy.passed && gates.determinism.passed,
      ...gates,
    },
    ...body,
  });
}

export async function runKnowledgeBenchmark(
  options: KnowledgeBenchmarkRunOptions,
  dependencies: Partial<KnowledgeBenchmarkRunnerDependencies> = {},
): Promise<KnowledgeBenchmarkRunResult> {
  const timedRounds = requireValidRounds(options.timedSearchRounds ?? DEFAULT_TIMED_SEARCH_ROUNDS);
  const createHarness = dependencies.createHarness ?? createKnowledgeBenchmarkHarness;
  const hashProjection = dependencies.hashProjection ?? defaultHashProjection;
  const harnesses: KnowledgeBenchmarkHarness[] = [];
  let primaryFailure: unknown;

  try {
    let peakRss = process.memoryUsage().rss;
    const startRss = peakRss;
    const sampleRss = (): void => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    };

    const construction = await measureMilliseconds(() => {
      const created = createHarness();
      harnesses.push(created);
      created.seedInitialSources();
      return created;
    });
    const harness = construction.value;
    sampleRss();
    const questions = requiredQuestions(harness);
    const correctnessViolations: string[] = [];

    const drain = await measureMilliseconds(() => harness.runWorker('benchmark-initial'));
    sampleRss();
    correctnessViolations.push(...collectCorrectnessViolations(harness, 'initial drain'));
    const completedJobs = count(
      harness.db,
      `SELECT COUNT(*) AS count FROM knowledge_jobs WHERE project_id = ? AND status = 'completed'`,
      harness.projectId,
    );
    const drainMs = requirePositiveFinite(drain.durationMs, 'workerDrainMs');

    const { projectId: sentinelProjectId } = await harness.seedSentinelProject();
    await yieldToEventLoop();
    const quality = runQualityPass(harness, sentinelProjectId, 'initial quality');
    await yieldToEventLoop();
    const firstProjection = buildProjection(harness, quality);
    const baselineResults = stableStringify(quality.resultsByQuestion);

    for (const question of questions) {
      searchSources(harness, question.prompt);
    }
    const samplesNs: number[] = [];
    const timedResults: Array<{ id: string; results: ProjectedResult[] }> = [];
    const timedProjectionViolations: string[] = [];
    for (let round = 0; round < timedRounds; round += 1) {
      await yieldToEventLoop();
      timedResults.length = 0;
      for (const question of questions) {
        const start = process.hrtime.bigint();
        const results = searchSources(harness, question.prompt);
        samplesNs.push(Number(process.hrtime.bigint() - start));
        timedResults.push({ id: question.id, results: results.map(projectResult) });
      }
      if (stableStringify(timedResults) !== baselineResults) {
        timedProjectionViolations.push(`Timed search round ${round + 1} projection differs from the untimed quality run`);
      }
    }
    sampleRss();

    const versionsBefore = versionCounts(harness.db, harness.projectId);
    const incremental = await measureMilliseconds(async () => {
      const update = harness.applyIncrementalUpdate();
      await harness.runWorker('benchmark-incremental');
      return update;
    });
    sampleRss();
    correctnessViolations.push(...collectCorrectnessViolations(harness, 'incremental update'));
    correctnessViolations.push(...verifyIncrementalUpdate(
      versionsBefore,
      versionCounts(harness.db, harness.projectId),
      incremental.value.sourcePath,
    ));
    await yieldToEventLoop();
    const incrementalQuality = runQualityPass(harness, sentinelProjectId, 'incremental quality');
    correctnessViolations.push(...timedProjectionViolations);
    correctnessViolations.push(...incrementalQuality.violations.filter((violation) => /leaked/.test(violation)));

    const bytes = sqliteBytes(harness);
    const sourceBytes = requirePositiveFinite(harness.input.sourceBytes, 'sourceBytes');
    const drainSeconds = drainMs / 1000;

    await yieldToEventLoop();
    try {
      runKnowledgeBenchmarkArchiveGate(harness.db, harness.projectId);
    } catch {
      correctnessViolations.push('Archive gate rejected the benchmark project export or tampered import checks');
    }

    const firstRunDigest = hashProjection(firstProjection);
    const second = createHarness();
    harnesses.push(second);
    const secondSentinel = await buildProcessedHarness(second, 'benchmark-determinism');
    await yieldToEventLoop();
    const secondProjection = buildProjection(
      second,
      runQualityPass(second, secondSentinel.sentinelProjectId, 'determinism quality'),
    );
    const secondRunDigest = hashProjection(secondProjection);
    const determinismMatched = firstRunDigest === secondRunDigest;

    const isLeak = (violation: string): boolean => /leaked/.test(violation);
    const qualityViolations = [...quality.violations, ...incrementalQuality.violations].filter((v) => !isLeak(v));
    const leakViolations = quality.violations.filter(isLeak);
    const toMs = (ns: number): number => roundMetric(ns / NANOSECONDS_PER_MILLISECOND, 3);

    const privacy: KnowledgeBenchmarkPrivacyInput = {
      prohibitedValues: [...KNOWLEDGE_BENCHMARK_SENTINEL_CANARIES],
      temporaryRoots: harnesses.map((entry) => entry.workspaceRoot),
      fixtureContents: harness.input.sources.map((source) => source.content),
      rawPrompts: questions.map((question) => question.prompt),
    };
    const body = {
      configuration: {
        corpusVersion: harness.input.corpus.corpusVersion,
        corpusDigest: harness.input.corpusDigest,
        sourceCount: harness.input.sources.length,
        sourceBytes: harness.input.sourceBytes,
        requiredQuestionCount: questions.length,
        searchWarmupRounds: 1 as const,
        searchTimedRounds: timedRounds,
        searchSampleCount: samplesNs.length,
      },
      quality: quality.metrics,
      performance: {
        policy: 'observational' as const,
        coldConstructionMs: roundMetric(construction.durationMs, 3),
        workerDrainMs: roundMetric(drainMs, 3),
        completedJobsPerSecond: roundMetric(completedJobs / drainSeconds),
        sourceBytesPerSecond: roundMetric(sourceBytes / drainSeconds),
        incrementalUpdateMs: roundMetric(incremental.durationMs, 3),
        searchLatencyMs: {
          p50: toMs(nearestRankPercentile(samplesNs, 0.5)),
          p95: toMs(nearestRankPercentile(samplesNs, 0.95)),
          p99: toMs(nearestRankPercentile(samplesNs, 0.99)),
        },
        sqliteBytes: bytes,
        storageAmplification: roundMetric(bytes.total / sourceBytes),
        rssBytes: { start: startRss, peak: peakRss, delta: peakRss - startRss },
      },
      determinism: {
        digestAlgorithm: 'sha256' as const,
        firstRunDigest,
        secondRunDigest,
        matched: determinismMatched,
      },
      publicBenchmarks: PUBLIC_BENCHMARK_NAMES.map((name) => ({
        name,
        status: 'not_measured' as const,
        reason: PUBLIC_BENCHMARK_REASON,
      })),
    };
    const gates = {
      quality: gate(qualityViolations),
      correctness: gate([...correctnessViolations, ...leakViolations]),
      determinism: gate(determinismMatched ? [] : ['Repeated clean run digests differ']),
    };

    let report = assembleReport(options, body, { ...gates, privacy: gate([]) });
    try {
      assertKnowledgeBenchmarkPrivacy(
        serializeKnowledgeBenchmarkJson(report),
        renderKnowledgeBenchmarkMarkdown(report),
        privacy,
      );
    } catch {
      report = assembleReport(options, body, {
        ...gates,
        privacy: gate(['Privacy scan rejected the report content']),
      });
    }
    return { report, privacy };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const failures = cleanupAll(harnesses);
    if (failures.length > 0 && primaryFailure === undefined) {
      throw failures[0];
    }
  }
}
