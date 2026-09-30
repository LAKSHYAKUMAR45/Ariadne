import * as fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeBenchmarkQualityMetrics, MetricCountRate } from './KnowledgeBenchmarkMetrics.js';
import {
  __setKnowledgeBenchmarkReportFileSystemForTest,
  KNOWLEDGE_BENCHMARK_SCHEMA_VERSION,
  assertKnowledgeBenchmarkPrivacy,
  createKnowledgeBenchmarkReport,
  renderKnowledgeBenchmarkMarkdown,
  serializeKnowledgeBenchmarkJson,
  writeKnowledgeBenchmarkArtifacts,
  type KnowledgeBenchmarkPrivacyInput,
  type KnowledgeBenchmarkReportV1,
} from './KnowledgeBenchmarkReport.js';

function metric(count: number, total: number, rate: number): MetricCountRate {
  return { count, total, rate };
}

function qualityMetrics(): KnowledgeBenchmarkQualityMetrics {
  return {
    recallAt1: metric(8, 10, 0.8),
    recallAt3: metric(9, 10, 0.9),
    recallAt10: metric(10, 10, 1),
    meanReciprocalRank: 0.876543,
    ndcgAt10: 0.912345,
    zeroResultRate: metric(0, 10, 0),
    ambiguityRate: metric(1, 10, 0.1),
    exactSpanCitationRate: metric(10, 10, 1),
    typedGraphEvidenceRate: metric(9, 10, 0.9),
  };
}

function validReportInput(): Omit<KnowledgeBenchmarkReportV1, 'schemaVersion' | 'benchmarkId'> {
  return {
    generatedAt: '2026-09-30T07:00:00.000Z',
    git: {
      commit: '0123456789abcdef0123456789abcdef01234567',
      dirty: false,
    },
    environment: {
      node: 'v22.10.0',
      platform: 'linux',
      architecture: 'x64',
      cpuModel: 'Benchmark CPU',
      logicalCpuCount: 16,
      totalMemoryBytes: 68_719_476_736,
    },
    configuration: {
      corpusVersion: 'naas-v1',
      corpusDigest: 'a'.repeat(64),
      sourceCount: 8,
      sourceBytes: 4_096,
      requiredQuestionCount: 10,
      searchWarmupRounds: 1,
      searchTimedRounds: 30,
      searchSampleCount: 300,
    },
    gates: {
      passed: true,
      quality: { passed: true, violations: [] },
      correctness: { passed: true, violations: [] },
      privacy: { passed: true, violations: [] },
      determinism: { passed: true, violations: [] },
    },
    quality: qualityMetrics(),
    performance: {
      policy: 'observational',
      coldConstructionMs: 123.456,
      workerDrainMs: 78.9,
      completedJobsPerSecond: 0.101112,
      sourceBytesPerSecond: 12.131415,
      incrementalUpdateMs: 16.171,
      searchLatencyMs: { p50: 1.234, p95: 2.345, p99: 3.456 },
      sqliteBytes: { main: 2_048, wal: 1_024, shm: 512, total: 3_584 },
      storageAmplification: 0.875,
      rssBytes: { start: 100_000_000, peak: 150_000_000, delta: 50_000_000 },
    },
    determinism: {
      digestAlgorithm: 'sha256',
      firstRunDigest: 'b'.repeat(64),
      secondRunDigest: 'b'.repeat(64),
      matched: true,
    },
    publicBenchmarks: [
      {
        name: 'CodeSearchNet',
        status: 'not_measured',
        reason: 'Baseline v1 measures the repository-owned NAAS fixture only.',
      },
      {
        name: 'RepoBench',
        status: 'not_measured',
        reason: 'No reviewed offline RepoBench adapter or dataset import is bundled in baseline v1.',
      },
      {
        name: 'BEIR/MTEB',
        status: 'not_measured',
        reason: 'Public retrieval benchmarks are deferred until a reviewed offline adapter is implemented.',
      },
      {
        name: 'ALCE',
        status: 'not_measured',
        reason: 'ALCE measurements require a reviewed adapter that baseline v1 does not include.',
      },
      {
        name: 'VIBE',
        status: 'not_measured',
        reason: 'VIBE remains out of scope until an offline adapter and dataset are approved.',
      },
    ],
  };
}

function createScratchDir(name: string): string {
  const root = path.join(process.cwd(), '.scratch-knowledge-benchmark-report-tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupScratchRoot(): void {
  fs.rmSync(path.join(process.cwd(), '.scratch-knowledge-benchmark-report-tests'), {
    force: true,
    recursive: true,
  });
}

function privacyInput(extra?: Partial<KnowledgeBenchmarkPrivacyInput>): KnowledgeBenchmarkPrivacyInput {
  return {
    prohibitedValues: ['sk-test-canary-123', 'person@example.invalid', ...(extra?.prohibitedValues ?? [])],
    temporaryRoots: ['/tmp/private-benchmark-root', ...(extra?.temporaryRoots ?? [])],
    fixtureContents: ['def secret_fixture_body(): pass', ...(extra?.fixtureContents ?? [])],
    rawPrompts: ['raw benchmark prompt', ...(extra?.rawPrompts ?? [])],
  };
}

afterEach(() => {
  cleanupScratchRoot();
  delete process.env.KNOWLEDGE_BENCHMARK_REPORT_TEST_SECRET;
  __setKnowledgeBenchmarkReportFileSystemForTest();
  vi.restoreAllMocks();
});

describe('createKnowledgeBenchmarkReport', () => {
  it('creates the allowlisted schema with stable top-level ordering and deterministic JSON', () => {
    const report = createKnowledgeBenchmarkReport(validReportInput());

    expect(report.schemaVersion).toBe(KNOWLEDGE_BENCHMARK_SCHEMA_VERSION);
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
    expect(renderKnowledgeBenchmarkMarkdown(report)).toBe(
      renderKnowledgeBenchmarkMarkdown(structuredClone(report)),
    );
  });

  it('requires the exact public benchmark allowlist with not_measured status and no score field', () => {
    const report = createKnowledgeBenchmarkReport(validReportInput());

    expect(report.publicBenchmarks.map((benchmark) => benchmark.name)).toEqual([
      'CodeSearchNet',
      'RepoBench',
      'BEIR/MTEB',
      'ALCE',
      'VIBE',
    ]);
    for (const benchmark of report.publicBenchmarks) {
      expect(benchmark.status).toBe('not_measured');
      expect(benchmark).not.toHaveProperty('score');
    }
  });

  it('rejects public benchmark entries with unexpected own properties', () => {
    const input = validReportInput();
    const benchmarkWithScore = {
      ...input.publicBenchmarks[0],
      score: 0.91,
    };

    expect(() =>
      createKnowledgeBenchmarkReport({
        ...input,
        publicBenchmarks: [
          benchmarkWithScore,
          ...input.publicBenchmarks.slice(1),
        ] as KnowledgeBenchmarkReportV1['publicBenchmarks'],
      }),
    ).toThrow(/publicBenchmarks\[0\].*unexpected/i);
  });

  it('rejects count and rate metrics whose rate does not match count divided by total', () => {
    expect(() =>
      createKnowledgeBenchmarkReport({
        ...validReportInput(),
        quality: {
          ...qualityMetrics(),
          recallAt1: metric(8, 10, 0.81),
        },
      }),
    ).toThrow(/quality\.recallAt1\.rate/i);
  });

  it('rejects count and rate metrics whose total differs from requiredQuestionCount', () => {
    expect(() =>
      createKnowledgeBenchmarkReport({
        ...validReportInput(),
        quality: {
          ...qualityMetrics(),
          ambiguityRate: metric(1, 9, 0.111111),
        },
      }),
    ).toThrow(/quality\.ambiguityRate\.total|requiredQuestionCount/i);
  });
});

describe('assertKnowledgeBenchmarkPrivacy', () => {
  it.each([
    ['prohibited canary', 'sk-test-canary-123', {}],
    ['PII canary', 'person@example.invalid', {}],
    ['unix temp root', '/tmp/private-benchmark-root/run-1', {}],
    ['windows path', 'C:\\private-benchmark-root\\run-1', { temporaryRoots: ['C:\\private-benchmark-root'] }],
    ['fixture contents', 'def secret_fixture_body(): pass', {}],
    ['raw prompt', 'raw benchmark prompt', {}],
  ])('rejects %s in serialized outputs', (_name, leak, extraPrivacy) => {
    const json = `${JSON.stringify({ leak })}\n`;
    const markdown = `# Report\n\n${leak}\n`;

    expect(() =>
      assertKnowledgeBenchmarkPrivacy(json, markdown, privacyInput(extraPrivacy)),
    ).toThrow(/privacy|prohibited|path|fixture|prompt/i);
  });

  it('rejects an environment value supplied as a prohibited value', () => {
    process.env.KNOWLEDGE_BENCHMARK_REPORT_TEST_SECRET = 'env-secret-canary';
    const json = `${JSON.stringify({ leak: 'env-secret-canary' })}\n`;
    const markdown = '# Report\n\nenv-secret-canary\n';

    expect(() =>
      assertKnowledgeBenchmarkPrivacy(
        json,
        markdown,
        privacyInput({ prohibitedValues: [process.env.KNOWLEDGE_BENCHMARK_REPORT_TEST_SECRET ?? ''] }),
      ),
    ).toThrow(/prohibited/i);
  });
});

describe('writeKnowledgeBenchmarkArtifacts', () => {
  it('writes deterministic JSON and Markdown artifacts atomically', () => {
    const outputRoot = createScratchDir('artifacts');
    const report = createKnowledgeBenchmarkReport(validReportInput());

    const paths = writeKnowledgeBenchmarkArtifacts(outputRoot, report, privacyInput());

    const json = fs.readFileSync(paths.jsonPath, 'utf8');
    const markdown = fs.readFileSync(paths.markdownPath, 'utf8');

    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(report);
    expect(markdown).toContain('# Knowledge Benchmark Baseline Report');
    expect(markdown).toContain('Machine-dependent values are observational');
    expect(markdown).toContain('CodeSearchNet');
  });

  it('leaves existing targets untouched and removes temp files when validation fails before rename', () => {
    const outputRoot = createScratchDir('atomicity');
    const jsonPath = path.join(outputRoot, 'knowledge-baseline-v1.json');
    const markdownPath = path.join(outputRoot, 'knowledge-baseline-v1.md');
    fs.writeFileSync(jsonPath, '{"stable":true}\n', 'utf8');
    fs.writeFileSync(markdownPath, '# Existing\n', 'utf8');

    const report = createKnowledgeBenchmarkReport({
      ...validReportInput(),
      environment: {
        ...validReportInput().environment,
        cpuModel: 'CPU /tmp/private-benchmark-root leak',
      },
    });

    expect(() => writeKnowledgeBenchmarkArtifacts(outputRoot, report, privacyInput())).toThrow(/privacy|path|prohibited/i);

    expect(fs.readFileSync(jsonPath, 'utf8')).toBe('{"stable":true}\n');
    expect(fs.readFileSync(markdownPath, 'utf8')).toBe('# Existing\n');
    expect(fs.existsSync(`${jsonPath}.tmp-${process.pid}`)).toBe(false);
    expect(fs.existsSync(`${markdownPath}.tmp-${process.pid}`)).toBe(false);
  });

  it('restores both original targets and removes temp plus backup files when the second target transition fails', () => {
    const outputRoot = createScratchDir('rollback');
    const jsonPath = path.join(outputRoot, 'knowledge-baseline-v1.json');
    const markdownPath = path.join(outputRoot, 'knowledge-baseline-v1.md');
    fs.writeFileSync(jsonPath, '{"stable":true}\n', 'utf8');
    fs.writeFileSync(markdownPath, '# Existing\n', 'utf8');

    const markdownTempPath = `${markdownPath}.tmp-${process.pid}`;
    __setKnowledgeBenchmarkReportFileSystemForTest({
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      readFileSync: fs.readFileSync,
      rmSync: fs.rmSync,
      writeFileSync: fs.writeFileSync,
      renameSync(from, to) {
        if (from === markdownTempPath && to === markdownPath) {
          throw new Error('simulated markdown rename failure');
        }
        return fs.renameSync(from, to);
      },
    });

    const report = createKnowledgeBenchmarkReport(validReportInput());

    expect(() => writeKnowledgeBenchmarkArtifacts(outputRoot, report, privacyInput())).toThrow(
      /simulated markdown rename failure/,
    );

    expect(fs.readFileSync(jsonPath, 'utf8')).toBe('{"stable":true}\n');
    expect(fs.readFileSync(markdownPath, 'utf8')).toBe('# Existing\n');
    expect(fs.existsSync(`${jsonPath}.tmp-${process.pid}`)).toBe(false);
    expect(fs.existsSync(`${markdownPath}.tmp-${process.pid}`)).toBe(false);
    expect(fs.existsSync(`${jsonPath}.bak-${process.pid}`)).toBe(false);
    expect(fs.existsSync(`${markdownPath}.bak-${process.pid}`)).toBe(false);
  });

  it('rejects a report whose gates failed without writing any target', () => {
    const outputRoot = createScratchDir('failed-gates');
    const input = validReportInput();
    const report = createKnowledgeBenchmarkReport({
      ...input,
      gates: {
        ...input.gates,
        passed: false,
        quality: { passed: false, violations: ['Recall@1 below threshold'] },
      },
    });

    expect(() => writeKnowledgeBenchmarkArtifacts(outputRoot, report, privacyInput())).toThrow(/gates/i);

    expect(fs.readdirSync(outputRoot)).toEqual([]);
  });

  it('preserves the original failure, attempts every rollback step, and keeps an unrestorable backup', () => {
    const outputRoot = createScratchDir('rollback-failure');
    const jsonPath = path.join(outputRoot, 'knowledge-baseline-v1.json');
    const markdownPath = path.join(outputRoot, 'knowledge-baseline-v1.md');
    fs.writeFileSync(jsonPath, '{"stable":true}\n', 'utf8');
    fs.writeFileSync(markdownPath, '# Existing\n', 'utf8');

    const markdownTempPath = `${markdownPath}.tmp-${process.pid}`;
    const jsonBackupPath = `${jsonPath}.bak-${process.pid}`;
    __setKnowledgeBenchmarkReportFileSystemForTest({
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      readFileSync: fs.readFileSync,
      rmSync: fs.rmSync,
      writeFileSync: fs.writeFileSync,
      renameSync(from, to) {
        if (from === markdownTempPath && to === markdownPath) {
          throw new Error('simulated markdown rename failure');
        }
        if (from === jsonBackupPath && to === jsonPath) {
          throw new Error('simulated json restore failure');
        }
        return fs.renameSync(from, to);
      },
    });

    const report = createKnowledgeBenchmarkReport(validReportInput());
    let caught: unknown;
    try {
      writeKnowledgeBenchmarkArtifacts(outputRoot, report, privacyInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const messages = (caught as AggregateError).errors.map((error: Error) => error.message);
    expect(messages).toEqual(expect.arrayContaining([
      'simulated markdown rename failure',
      'simulated json restore failure',
    ]));
    expect(fs.readFileSync(markdownPath, 'utf8')).toBe('# Existing\n');
    expect(fs.readFileSync(jsonBackupPath, 'utf8')).toBe('{"stable":true}\n');
    expect(fs.existsSync(`${jsonPath}.tmp-${process.pid}`)).toBe(false);
    expect(fs.existsSync(markdownTempPath)).toBe(false);
  });
});
