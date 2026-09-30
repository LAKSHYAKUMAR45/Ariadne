import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeBenchmarkQualityMetrics, MetricCountRate } from './KnowledgeBenchmarkMetrics.js';

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

const JSON_FILENAME = 'knowledge-baseline-v1.json';
const MARKDOWN_FILENAME = 'knowledge-baseline-v1.md';
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNIX_ABSOLUTE_PATH_PATTERN = /(^|[\s"'`(\[{:,])\/(?:[^\s"'`)<>{}\]|]+(?:\/[^\s"'`)<>{}\]|]+)*)/m;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(^|[\s"'`(\[{:,])[A-Za-z]:\\(?:[^\s"'`)<>{}\]|]+(?:\\[^\s"'`)<>{}\]|]+)*)/m;
const PUBLIC_BENCHMARK_NAMES = [
  'CodeSearchNet',
  'RepoBench',
  'BEIR/MTEB',
  'ALCE',
  'VIBE',
] as const;

type FileSystemAdapter = Pick<
  typeof fs,
  'existsSync' | 'mkdirSync' | 'readFileSync' | 'renameSync' | 'rmSync' | 'writeFileSync'
>;

interface PublicBenchmarkStatus {
  name: string;
  status: 'not_measured';
  reason: string;
}

type KnowledgeBenchmarkReportInput = Omit<KnowledgeBenchmarkReportV1, 'schemaVersion' | 'benchmarkId'>;

type NormalizedReport = KnowledgeBenchmarkReportV1;

let fileSystem: FileSystemAdapter = fs;

function assertNonEmptyString(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertBoolean(value: boolean, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function assertFiniteNonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function assertRate(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite rate in [0, 1]`);
  }
  return value;
}

function assertSha256Hex(value: string, label: string): string {
  const normalized = assertNonEmptyString(value, label);
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a 64-character lowercase SHA-256 digest`);
  }
  return normalized;
}

function assertUtcIsoTimestamp(value: string, label: string): string {
  const normalized = assertNonEmptyString(value, label);
  if (!UTC_ISO_PATTERN.test(normalized)) {
    throw new Error(`${label} must be an ISO 8601 UTC timestamp`);
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new Error(`${label} must be an ISO 8601 UTC timestamp`);
  }
  return normalized;
}

function assertGitCommit(value: string, label: string): string {
  const normalized = assertNonEmptyString(value, label);
  if (!GIT_COMMIT_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a 40-character lowercase Git commit hash`);
  }
  return normalized;
}

function assertExactOwnProperties(
  value: object,
  label: string,
  expectedProperties: readonly string[],
): void {
  const actualProperties = Reflect.ownKeys(value);
  const unexpectedProperties = actualProperties.filter((property) =>
    typeof property !== 'string' || !expectedProperties.includes(property),
  );
  if (unexpectedProperties.length > 0) {
    throw new Error(`${label} contains unexpected own properties`);
  }
  for (const property of expectedProperties) {
    if (!Object.prototype.hasOwnProperty.call(value, property)) {
      throw new Error(`${label} must include ${property}`);
    }
  }
}

function normalizeMetricCountRate(
  value: MetricCountRate,
  label: string,
  requiredTotal: number,
): MetricCountRate {
  const count = assertNonNegativeInteger(value.count, `${label}.count`);
  const total = assertNonNegativeInteger(value.total, `${label}.total`);
  const rate = assertRate(value.rate, `${label}.rate`);
  if (count > total) {
    throw new Error(`${label}.count must be less than or equal to ${label}.total`);
  }
  if (total !== requiredTotal) {
    throw new Error(`${label}.total must equal configuration.requiredQuestionCount`);
  }
  const expectedRate = Number((count / total).toFixed(6));
  if (rate !== expectedRate) {
    throw new Error(`${label}.rate must equal ${expectedRate.toFixed(6)} derived from count / total`);
  }
  return {
    count,
    total,
    rate,
  };
}

function normalizeQualityMetrics(
  value: KnowledgeBenchmarkQualityMetrics,
  requiredQuestionCount: number,
): KnowledgeBenchmarkQualityMetrics {
  return {
    recallAt1: normalizeMetricCountRate(value.recallAt1, 'quality.recallAt1', requiredQuestionCount),
    recallAt3: normalizeMetricCountRate(value.recallAt3, 'quality.recallAt3', requiredQuestionCount),
    recallAt10: normalizeMetricCountRate(value.recallAt10, 'quality.recallAt10', requiredQuestionCount),
    meanReciprocalRank: assertRate(value.meanReciprocalRank, 'quality.meanReciprocalRank'),
    ndcgAt10: assertRate(value.ndcgAt10, 'quality.ndcgAt10'),
    zeroResultRate: normalizeMetricCountRate(value.zeroResultRate, 'quality.zeroResultRate', requiredQuestionCount),
    ambiguityRate: normalizeMetricCountRate(value.ambiguityRate, 'quality.ambiguityRate', requiredQuestionCount),
    exactSpanCitationRate: normalizeMetricCountRate(value.exactSpanCitationRate, 'quality.exactSpanCitationRate', requiredQuestionCount),
    typedGraphEvidenceRate: normalizeMetricCountRate(value.typedGraphEvidenceRate, 'quality.typedGraphEvidenceRate', requiredQuestionCount),
  };
}

function normalizeGateResult(value: GateResult, label: string): GateResult {
  const passed = assertBoolean(value.passed, `${label}.passed`);
  if (!Array.isArray(value.violations)) {
    throw new Error(`${label}.violations must be an array`);
  }
  const violations = value.violations.map((violation, index) =>
    assertNonEmptyString(violation, `${label}.violations[${index}]`),
  );
  if (passed && violations.length > 0) {
    throw new Error(`${label} cannot be passed with violations`);
  }
  if (!passed && violations.length === 0) {
    throw new Error(`${label} must include at least one violation when it fails`);
  }
  return { passed, violations: [...violations] };
}

function normalizePublicBenchmarks(
  value: readonly PublicBenchmarkStatus[],
): PublicBenchmarkStatus[] {
  if (!Array.isArray(value)) {
    throw new Error('publicBenchmarks must be an array');
  }
  if (value.length !== PUBLIC_BENCHMARK_NAMES.length) {
    throw new Error('publicBenchmarks must contain the exact required benchmark allowlist');
  }

  const byName = new Map<string, PublicBenchmarkStatus>();
  for (const [index, benchmark] of value.entries()) {
    assertExactOwnProperties(benchmark, `publicBenchmarks[${index}]`, ['name', 'status', 'reason']);
    const name = assertNonEmptyString(benchmark.name, `publicBenchmarks[${index}].name`);
    if (byName.has(name)) {
      throw new Error(`Duplicate public benchmark \"${name}\"`);
    }
    if (benchmark.status !== 'not_measured') {
      throw new Error(`publicBenchmarks[${index}].status must be \"not_measured\"`);
    }
    const reason = assertNonEmptyString(benchmark.reason, `publicBenchmarks[${index}].reason`);
    byName.set(name, {
      name,
      status: 'not_measured',
      reason,
    });
  }

  return PUBLIC_BENCHMARK_NAMES.map((name) => {
    const benchmark = byName.get(name);
    if (benchmark === undefined) {
      throw new Error(`Missing public benchmark \"${name}\"`);
    }
    return {
      name: benchmark.name,
      status: 'not_measured',
      reason: benchmark.reason,
    };
  });
}

function deriveBenchmarkId(
  gitCommit: string,
  configuration: KnowledgeBenchmarkReportV1['configuration'],
): string {
  const identityPayload = {
    schemaVersion: KNOWLEDGE_BENCHMARK_SCHEMA_VERSION,
    gitCommit,
    configuration: {
      corpusVersion: configuration.corpusVersion,
      corpusDigest: configuration.corpusDigest,
      sourceCount: configuration.sourceCount,
      sourceBytes: configuration.sourceBytes,
      requiredQuestionCount: configuration.requiredQuestionCount,
      searchWarmupRounds: configuration.searchWarmupRounds,
      searchTimedRounds: configuration.searchTimedRounds,
      searchSampleCount: configuration.searchSampleCount,
    },
  };
  return createHash('sha256').update(JSON.stringify(identityPayload)).digest('hex');
}

function normalizeReportInput(input: KnowledgeBenchmarkReportInput): NormalizedReport {
  const generatedAt = assertUtcIsoTimestamp(input.generatedAt, 'generatedAt');
  const gitCommit = assertGitCommit(input.git.commit, 'git.commit');
  const gitDirty = assertBoolean(input.git.dirty, 'git.dirty');

  const environment = {
    node: assertNonEmptyString(input.environment.node, 'environment.node'),
    platform: assertNonEmptyString(input.environment.platform, 'environment.platform'),
    architecture: assertNonEmptyString(input.environment.architecture, 'environment.architecture'),
    cpuModel: assertNonEmptyString(input.environment.cpuModel, 'environment.cpuModel'),
    logicalCpuCount: assertNonNegativeInteger(input.environment.logicalCpuCount, 'environment.logicalCpuCount'),
    totalMemoryBytes: assertNonNegativeInteger(input.environment.totalMemoryBytes, 'environment.totalMemoryBytes'),
  };

  const configuration = {
    corpusVersion: assertNonEmptyString(input.configuration.corpusVersion, 'configuration.corpusVersion'),
    corpusDigest: assertSha256Hex(input.configuration.corpusDigest, 'configuration.corpusDigest'),
    sourceCount: assertNonNegativeInteger(input.configuration.sourceCount, 'configuration.sourceCount'),
    sourceBytes: assertNonNegativeInteger(input.configuration.sourceBytes, 'configuration.sourceBytes'),
    requiredQuestionCount: assertNonNegativeInteger(input.configuration.requiredQuestionCount, 'configuration.requiredQuestionCount'),
    searchWarmupRounds: input.configuration.searchWarmupRounds,
    searchTimedRounds: assertNonNegativeInteger(input.configuration.searchTimedRounds, 'configuration.searchTimedRounds'),
    searchSampleCount: assertNonNegativeInteger(input.configuration.searchSampleCount, 'configuration.searchSampleCount'),
  } satisfies KnowledgeBenchmarkReportV1['configuration'];
  if (configuration.searchWarmupRounds !== 1) {
    throw new Error('configuration.searchWarmupRounds must equal 1');
  }

  const qualityGate = normalizeGateResult(input.gates.quality, 'gates.quality');
  const correctnessGate = normalizeGateResult(input.gates.correctness, 'gates.correctness');
  const privacyGate = normalizeGateResult(input.gates.privacy, 'gates.privacy');
  const determinismGate = normalizeGateResult(input.gates.determinism, 'gates.determinism');
  const overallPassed = qualityGate.passed
    && correctnessGate.passed
    && privacyGate.passed
    && determinismGate.passed;
  if (assertBoolean(input.gates.passed, 'gates.passed') !== overallPassed) {
    throw new Error('gates.passed must match the aggregate gate results');
  }

  const quality = normalizeQualityMetrics(input.quality, configuration.requiredQuestionCount);

  const performance = {
    policy: input.performance.policy,
    coldConstructionMs: assertFiniteNonNegativeNumber(input.performance.coldConstructionMs, 'performance.coldConstructionMs'),
    workerDrainMs: assertFiniteNonNegativeNumber(input.performance.workerDrainMs, 'performance.workerDrainMs'),
    completedJobsPerSecond: assertFiniteNonNegativeNumber(input.performance.completedJobsPerSecond, 'performance.completedJobsPerSecond'),
    sourceBytesPerSecond: assertFiniteNonNegativeNumber(input.performance.sourceBytesPerSecond, 'performance.sourceBytesPerSecond'),
    incrementalUpdateMs: assertFiniteNonNegativeNumber(input.performance.incrementalUpdateMs, 'performance.incrementalUpdateMs'),
    searchLatencyMs: {
      p50: assertFiniteNonNegativeNumber(input.performance.searchLatencyMs.p50, 'performance.searchLatencyMs.p50'),
      p95: assertFiniteNonNegativeNumber(input.performance.searchLatencyMs.p95, 'performance.searchLatencyMs.p95'),
      p99: assertFiniteNonNegativeNumber(input.performance.searchLatencyMs.p99, 'performance.searchLatencyMs.p99'),
    },
    sqliteBytes: {
      main: assertNonNegativeInteger(input.performance.sqliteBytes.main, 'performance.sqliteBytes.main'),
      wal: assertNonNegativeInteger(input.performance.sqliteBytes.wal, 'performance.sqliteBytes.wal'),
      shm: assertNonNegativeInteger(input.performance.sqliteBytes.shm, 'performance.sqliteBytes.shm'),
      total: assertNonNegativeInteger(input.performance.sqliteBytes.total, 'performance.sqliteBytes.total'),
    },
    storageAmplification: assertFiniteNonNegativeNumber(input.performance.storageAmplification, 'performance.storageAmplification'),
    rssBytes: {
      start: assertNonNegativeInteger(input.performance.rssBytes.start, 'performance.rssBytes.start'),
      peak: assertNonNegativeInteger(input.performance.rssBytes.peak, 'performance.rssBytes.peak'),
      delta: assertNonNegativeInteger(input.performance.rssBytes.delta, 'performance.rssBytes.delta'),
    },
  } satisfies KnowledgeBenchmarkReportV1['performance'];
  if (performance.policy !== 'observational') {
    throw new Error('performance.policy must equal \"observational\"');
  }
  if (performance.searchLatencyMs.p50 > performance.searchLatencyMs.p95 || performance.searchLatencyMs.p95 > performance.searchLatencyMs.p99) {
    throw new Error('performance.searchLatencyMs must be ordered p50 <= p95 <= p99');
  }
  if (performance.sqliteBytes.total !== performance.sqliteBytes.main + performance.sqliteBytes.wal + performance.sqliteBytes.shm) {
    throw new Error('performance.sqliteBytes.total must equal main + wal + shm');
  }
  if (performance.rssBytes.peak < performance.rssBytes.start) {
    throw new Error('performance.rssBytes.peak must be greater than or equal to performance.rssBytes.start');
  }
  if (performance.rssBytes.delta !== performance.rssBytes.peak - performance.rssBytes.start) {
    throw new Error('performance.rssBytes.delta must equal peak - start');
  }

  const determinism = {
    digestAlgorithm: input.determinism.digestAlgorithm,
    firstRunDigest: assertSha256Hex(input.determinism.firstRunDigest, 'determinism.firstRunDigest'),
    secondRunDigest: assertSha256Hex(input.determinism.secondRunDigest, 'determinism.secondRunDigest'),
    matched: assertBoolean(input.determinism.matched, 'determinism.matched'),
  } satisfies KnowledgeBenchmarkReportV1['determinism'];
  if (determinism.digestAlgorithm !== 'sha256') {
    throw new Error('determinism.digestAlgorithm must equal \"sha256\"');
  }
  if (determinism.matched !== (determinism.firstRunDigest === determinism.secondRunDigest)) {
    throw new Error('determinism.matched must reflect digest equality');
  }

  const publicBenchmarks = normalizePublicBenchmarks(input.publicBenchmarks);
  const benchmarkId = deriveBenchmarkId(gitCommit, configuration);

  return {
    schemaVersion: KNOWLEDGE_BENCHMARK_SCHEMA_VERSION,
    benchmarkId,
    generatedAt,
    git: {
      commit: gitCommit,
      dirty: gitDirty,
    },
    environment,
    configuration,
    gates: {
      passed: overallPassed,
      quality: qualityGate,
      correctness: correctnessGate,
      privacy: privacyGate,
      determinism: determinismGate,
    },
    quality,
    performance,
    determinism,
    publicBenchmarks,
  };
}

function normalizeExistingReport(report: KnowledgeBenchmarkReportV1): NormalizedReport {
  if (report.schemaVersion !== KNOWLEDGE_BENCHMARK_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must equal \"${KNOWLEDGE_BENCHMARK_SCHEMA_VERSION}\"`);
  }
  const normalized = normalizeReportInput({
    generatedAt: report.generatedAt,
    git: report.git,
    environment: report.environment,
    configuration: report.configuration,
    gates: report.gates,
    quality: report.quality,
    performance: report.performance,
    determinism: report.determinism,
    publicBenchmarks: report.publicBenchmarks,
  });
  if (report.benchmarkId !== normalized.benchmarkId) {
    throw new Error('benchmarkId must match the derived benchmark identity');
  }
  return normalized;
}

function formatCountRateMetric(metric: MetricCountRate): string {
  return `${metric.count} / ${metric.total} (${metric.rate.toFixed(6)})`;
}

function markdownTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  const headerRow = `| ${headers.join(' | ')} |`;
  const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyRows = rows.map((row) => `| ${row.join(' | ')} |`);
  return [headerRow, separatorRow, ...bodyRows].join('\n');
}

export function createKnowledgeBenchmarkReport(
  input: Omit<KnowledgeBenchmarkReportV1, 'schemaVersion' | 'benchmarkId'>,
): KnowledgeBenchmarkReportV1 {
  return normalizeReportInput(input);
}

export function serializeKnowledgeBenchmarkJson(
  report: KnowledgeBenchmarkReportV1,
): string {
  const normalized = normalizeExistingReport(report);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function renderKnowledgeBenchmarkMarkdown(
  report: KnowledgeBenchmarkReportV1,
): string {
  const normalized = normalizeExistingReport(report);
  const lines = [
    '# Knowledge Benchmark Baseline Report',
    '',
    `- Benchmark ID: ${normalized.benchmarkId}`,
    `- Schema Version: ${normalized.schemaVersion}`,
    `- Generated At: ${normalized.generatedAt}`,
    `- Git Commit: ${normalized.git.commit}`,
    `- Git Dirty: ${normalized.git.dirty ? 'yes' : 'no'}`,
    '',
    '## Gates',
    '',
    markdownTable(
      ['Gate', 'Passed', 'Violations'],
      [
        ['overall', normalized.gates.passed ? 'yes' : 'no', normalized.gates.passed ? 'none' : 'aggregate gate failure'],
        ['quality', normalized.gates.quality.passed ? 'yes' : 'no', normalized.gates.quality.violations.join('; ') || 'none'],
        ['correctness', normalized.gates.correctness.passed ? 'yes' : 'no', normalized.gates.correctness.violations.join('; ') || 'none'],
        ['privacy', normalized.gates.privacy.passed ? 'yes' : 'no', normalized.gates.privacy.violations.join('; ') || 'none'],
        ['determinism', normalized.gates.determinism.passed ? 'yes' : 'no', normalized.gates.determinism.violations.join('; ') || 'none'],
      ],
    ),
    '',
    '## Quality',
    '',
    markdownTable(
      ['Metric', 'Value'],
      [
        ['Recall@1', formatCountRateMetric(normalized.quality.recallAt1)],
        ['Recall@3', formatCountRateMetric(normalized.quality.recallAt3)],
        ['Recall@10', formatCountRateMetric(normalized.quality.recallAt10)],
        ['Mean Reciprocal Rank', normalized.quality.meanReciprocalRank.toFixed(6)],
        ['nDCG@10', normalized.quality.ndcgAt10.toFixed(6)],
        ['Zero-result rate', formatCountRateMetric(normalized.quality.zeroResultRate)],
        ['Ambiguity rate', formatCountRateMetric(normalized.quality.ambiguityRate)],
        ['Exact-span citation rate', formatCountRateMetric(normalized.quality.exactSpanCitationRate)],
        ['Typed-graph evidence rate', formatCountRateMetric(normalized.quality.typedGraphEvidenceRate)],
      ],
    ),
    '',
    '## Performance observations',
    '',
    markdownTable(
      ['Observation', 'Value'],
      [
        ['Policy', normalized.performance.policy],
        ['Cold construction (ms)', normalized.performance.coldConstructionMs.toFixed(3)],
        ['Worker drain (ms)', normalized.performance.workerDrainMs.toFixed(3)],
        ['Completed jobs per second', normalized.performance.completedJobsPerSecond.toFixed(6)],
        ['Source bytes per second', normalized.performance.sourceBytesPerSecond.toFixed(6)],
        ['Incremental update (ms)', normalized.performance.incrementalUpdateMs.toFixed(3)],
        ['Search latency p50 (ms)', normalized.performance.searchLatencyMs.p50.toFixed(3)],
        ['Search latency p95 (ms)', normalized.performance.searchLatencyMs.p95.toFixed(3)],
        ['Search latency p99 (ms)', normalized.performance.searchLatencyMs.p99.toFixed(3)],
        ['SQLite main bytes', String(normalized.performance.sqliteBytes.main)],
        ['SQLite WAL bytes', String(normalized.performance.sqliteBytes.wal)],
        ['SQLite SHM bytes', String(normalized.performance.sqliteBytes.shm)],
        ['SQLite total bytes', String(normalized.performance.sqliteBytes.total)],
        ['Storage amplification', normalized.performance.storageAmplification.toFixed(6)],
        ['RSS start bytes', String(normalized.performance.rssBytes.start)],
        ['RSS peak bytes', String(normalized.performance.rssBytes.peak)],
        ['RSS delta bytes', String(normalized.performance.rssBytes.delta)],
      ],
    ),
    '',
    'Machine-dependent values are observational in baseline v1.',
    '',
    '## Determinism',
    '',
    markdownTable(
      ['Field', 'Value'],
      [
        ['Digest algorithm', normalized.determinism.digestAlgorithm],
        ['First run digest', normalized.determinism.firstRunDigest],
        ['Second run digest', normalized.determinism.secondRunDigest],
        ['Matched', normalized.determinism.matched ? 'yes' : 'no'],
      ],
    ),
    '',
    '## Environment',
    '',
    markdownTable(
      ['Field', 'Value'],
      [
        ['Node', normalized.environment.node],
        ['Platform', normalized.environment.platform],
        ['Architecture', normalized.environment.architecture],
        ['CPU model', normalized.environment.cpuModel],
        ['Logical CPU count', String(normalized.environment.logicalCpuCount)],
        ['Total memory bytes', String(normalized.environment.totalMemoryBytes)],
        ['Corpus version', normalized.configuration.corpusVersion],
        ['Corpus digest', normalized.configuration.corpusDigest],
        ['Source count', String(normalized.configuration.sourceCount)],
        ['Source bytes', String(normalized.configuration.sourceBytes)],
        ['Required question count', String(normalized.configuration.requiredQuestionCount)],
        ['Search warm-up rounds', String(normalized.configuration.searchWarmupRounds)],
        ['Search timed rounds', String(normalized.configuration.searchTimedRounds)],
        ['Search sample count', String(normalized.configuration.searchSampleCount)],
      ],
    ),
    '',
    '## Public benchmarks',
    '',
    markdownTable(
      ['Benchmark', 'Status', 'Reason'],
      normalized.publicBenchmarks.map((benchmark) => [benchmark.name, benchmark.status, benchmark.reason]),
    ),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function assertNoContainedValues(content: string, label: string, values: readonly string[]): void {
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    if (content.includes(value)) {
      throw new Error(`${label} contains a prohibited value`);
    }
  }
}

function assertNoAbsolutePaths(content: string, label: string): void {
  if (UNIX_ABSOLUTE_PATH_PATTERN.test(content) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(content)) {
    throw new Error(`${label} contains an absolute path`);
  }
}

export function assertKnowledgeBenchmarkPrivacy(
  json: string,
  markdown: string,
  input: KnowledgeBenchmarkPrivacyInput,
): void {
  const artifacts = [
    ['JSON report', json],
    ['Markdown report', markdown],
  ] as const;
  const prohibitedValues = input.prohibitedValues.filter((value): value is string => typeof value === 'string' && value.length > 0);
  const temporaryRoots = input.temporaryRoots.filter((value): value is string => typeof value === 'string' && value.length > 0);
  const fixtureContents = input.fixtureContents.filter((value): value is string => typeof value === 'string' && value.length > 0);
  const rawPrompts = input.rawPrompts.filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const [label, content] of artifacts) {
    assertNoContainedValues(content, label, prohibitedValues);
    assertNoContainedValues(content, label, temporaryRoots);
    assertNoContainedValues(content, label, fixtureContents);
    assertNoContainedValues(content, label, rawPrompts);
    assertNoAbsolutePaths(content, label);
  }
}

export function writeKnowledgeBenchmarkArtifacts(
  outputRoot: string,
  report: KnowledgeBenchmarkReportV1,
  privacy: KnowledgeBenchmarkPrivacyInput,
): { jsonPath: string; markdownPath: string } {
  if (report.gates.passed !== true) {
    throw new Error('Refusing to write benchmark artifacts for a report with failed gates');
  }
  const normalizedOutputRoot = path.resolve(assertNonEmptyString(outputRoot, 'outputRoot'));
  fileSystem.mkdirSync(normalizedOutputRoot, { recursive: true });

  const jsonPath = path.join(normalizedOutputRoot, JSON_FILENAME);
  const markdownPath = path.join(normalizedOutputRoot, MARKDOWN_FILENAME);
  if (path.dirname(jsonPath) !== normalizedOutputRoot || path.dirname(markdownPath) !== normalizedOutputRoot) {
    throw new Error('output artifact paths must remain inside the output root');
  }

  const jsonTemp = `${jsonPath}.tmp-${process.pid}`;
  const markdownTemp = `${markdownPath}.tmp-${process.pid}`;
  const jsonBackup = `${jsonPath}.bak-${process.pid}`;
  const markdownBackup = `${markdownPath}.bak-${process.pid}`;
  const transitions = [
    { targetPath: jsonPath, tempPath: jsonTemp, backupPath: jsonBackup, originalExisted: false, backedUp: false, promoted: false },
    { targetPath: markdownPath, tempPath: markdownTemp, backupPath: markdownBackup, originalExisted: false, backedUp: false, promoted: false },
  ];
  try {
    const json = serializeKnowledgeBenchmarkJson(report);
    const markdown = renderKnowledgeBenchmarkMarkdown(report);

    fileSystem.writeFileSync(jsonTemp, json, 'utf8');
    fileSystem.writeFileSync(markdownTemp, markdown, 'utf8');

    JSON.parse(fileSystem.readFileSync(jsonTemp, 'utf8'));
    assertKnowledgeBenchmarkPrivacy(
      fileSystem.readFileSync(jsonTemp, 'utf8'),
      fileSystem.readFileSync(markdownTemp, 'utf8'),
      privacy,
    );

    for (const transition of transitions) {
      fileSystem.rmSync(transition.backupPath, { force: true, recursive: true });
      transition.originalExisted = fileSystem.existsSync(transition.targetPath);
      if (transition.originalExisted) {
        fileSystem.renameSync(transition.targetPath, transition.backupPath);
        transition.backedUp = true;
      }
    }

    for (const transition of transitions) {
      fileSystem.renameSync(transition.tempPath, transition.targetPath);
      transition.promoted = true;
    }

    for (const transition of transitions) {
      if (transition.backedUp) {
        fileSystem.rmSync(transition.backupPath, { force: true, recursive: true });
      }
    }
    return { jsonPath, markdownPath };
  } catch (error: unknown) {
    const failures: unknown[] = [error];
    const attempt = (step: () => void): void => {
      try {
        step();
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    };
    for (const transition of [...transitions].reverse()) {
      if (transition.promoted) {
        attempt(() => fileSystem.rmSync(transition.targetPath, { force: true, recursive: true }));
      }
      if (transition.backedUp) {
        attempt(() => {
          fileSystem.renameSync(transition.backupPath, transition.targetPath);
          transition.backedUp = false;
        });
      }
    }
    attempt(() => fileSystem.rmSync(jsonTemp, { force: true, recursive: true }));
    attempt(() => fileSystem.rmSync(markdownTemp, { force: true, recursive: true }));
    // A backup that could not be restored is the only copy of the original; keep it.
    for (const transition of transitions) {
      if (!transition.backedUp) {
        attempt(() => fileSystem.rmSync(transition.backupPath, { force: true, recursive: true }));
      }
    }
    if (failures.length === 1) {
      throw error;
    }
    throw new AggregateError(failures, 'Benchmark artifact write failed and rollback was incomplete', { cause: error });
  }
}

export function __setKnowledgeBenchmarkReportFileSystemForTest(next?: FileSystemAdapter): void {
  fileSystem = next ?? fs;
}
