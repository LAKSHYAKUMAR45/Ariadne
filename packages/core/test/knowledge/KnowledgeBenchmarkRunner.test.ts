import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createKnowledgeBenchmarkHarness,
  type KnowledgeBenchmarkHarness,
} from './KnowledgeBenchmarkFixture.js';
import { runKnowledgeBenchmarkArchiveGate } from './KnowledgeBenchmarkArchiveGate.js';
import {
  runKnowledgeBenchmark,
  type KnowledgeBenchmarkRunOptions,
  type KnowledgeBenchmarkRunnerDependencies,
} from './KnowledgeBenchmarkRunner.js';

vi.setConfig({ testTimeout: 120_000 });

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function testEnvironment(): KnowledgeBenchmarkRunOptions['environment'] {
  return {
    node: 'v22.10.0',
    platform: 'linux',
    architecture: 'x64',
    cpuModel: 'Benchmark CPU',
    logicalCpuCount: 4,
    totalMemoryBytes: 8_589_934_592,
  };
}

function runOptions(overrides: Partial<KnowledgeBenchmarkRunOptions> = {}): KnowledgeBenchmarkRunOptions {
  return {
    generatedAt: '2026-09-29T12:00:00.000Z',
    git: { commit: 'a'.repeat(40), dirty: false },
    environment: testEnvironment(),
    timedSearchRounds: 2,
    ...overrides,
  };
}

describe('runKnowledgeBenchmark', () => {
  const created: KnowledgeBenchmarkHarness[] = [];

  afterEach(() => {
    for (const harness of created.splice(0)) harness.cleanup();
  });

  function trackedHarness(
    mutate: (harness: KnowledgeBenchmarkHarness, index: number) => KnowledgeBenchmarkHarness = (harness) => harness,
  ): Partial<KnowledgeBenchmarkRunnerDependencies> {
    return {
      createHarness: (options) => {
        const harness = createKnowledgeBenchmarkHarness(options);
        created.push(harness);
        return mutate(harness, created.length - 1);
      },
    };
  }

  it('runs the production pipeline and passes all portable gates', async () => {
    const result = await runKnowledgeBenchmark(runOptions());

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
    expect(result.report.performance.policy).toBe('observational');
    expect(result.report.performance.completedJobsPerSecond).toBeGreaterThan(0);
    expect(result.report.performance.storageAmplification).toBeGreaterThan(0);
    expect(result.privacy.rawPrompts.length).toBeGreaterThanOrEqual(10);
    expect(result.privacy.prohibitedValues.length).toBeGreaterThan(0);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects timedSearchRounds %s', async (rounds) => {
    await expect(runKnowledgeBenchmark(runOptions({ timedSearchRounds: rounds }), trackedHarness()))
      .rejects.toThrow(/timedSearchRounds/);
    expect(created).toHaveLength(0);
  });

  it('keeps a sentinel project seeded, completed, and out of benchmark results', async () => {
    let sentinelSources = 0;
    const result = await runKnowledgeBenchmark(runOptions(), trackedHarness((harness) => ({
      ...harness,
      async seedSentinelProject() {
        const sentinel = await harness.seedSentinelProject();
        sentinelSources = (harness.db.prepare(
          `SELECT COUNT(*) AS count FROM knowledge_jobs WHERE project_id = ? AND status = 'completed'`,
        ).get(sentinel.projectId) as { count: number }).count;
        return sentinel;
      },
    })));

    expect(sentinelSources).toBeGreaterThan(0);
    expect(result.report.gates.correctness).toEqual({ passed: true, violations: [] });
  });

  it('fails correctness when benchmark results belong to the sentinel project', async () => {
    const result = await runKnowledgeBenchmark(runOptions(), trackedHarness((harness) => ({
      ...harness,
      async seedSentinelProject() {
        await harness.seedSentinelProject();
        return { projectId: harness.projectId };
      },
    })));

    expect(result.report.gates.passed).toBe(false);
    expect(result.report.gates.correctness.violations.join('\n')).toMatch(/sentinel/i);
  });

  it('fails correctness when a job is owned by a different project than its source version', async () => {
    const result = await runKnowledgeBenchmark(runOptions(), trackedHarness((harness) => ({
      ...harness,
      async seedSentinelProject() {
        const sentinel = await harness.seedSentinelProject();
        const version = harness.db.prepare(
          'SELECT id FROM knowledge_source_versions WHERE project_id = ? LIMIT 1',
        ).get(harness.projectId) as { id: string };
        harness.db.prepare(
          `INSERT OR IGNORE INTO knowledge_jobs
           (id, project_id, job_kind, source_version_id, status, payload_json, requested_at, completed_at)
           VALUES ('wrong-project-job', ?, 'analyze', ?, 'completed', '{}', '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z')`,
        ).run(sentinel.projectId, version.id);
        return sentinel;
      },
    })));

    expect(result.report.gates.correctness.passed).toBe(false);
    expect(result.report.gates.correctness.violations.join('\n')).toMatch(/wrong project/i);
  });

  it('fails correctness on duplicate active jobs', async () => {
    const result = await runKnowledgeBenchmark(runOptions(), trackedHarness((harness) => ({
      ...harness,
      async runWorker(workerId: string) {
        await harness.runWorker(workerId);
        harness.db.exec('DROP INDEX IF EXISTS idx_knowledge_jobs_source_version');
        const job = harness.db.prepare(
          `SELECT job_kind, source_version_id FROM knowledge_jobs WHERE project_id = ? LIMIT 1`,
        ).get(harness.projectId) as { job_kind: string; source_version_id: string };
        for (const id of ['duplicate-a', 'duplicate-b']) {
          harness.db.prepare(
            `INSERT OR IGNORE INTO knowledge_jobs
             (id, project_id, job_kind, source_version_id, status, payload_json, requested_at)
             VALUES (?, ?, ?, ?, 'queued', '{}', '2026-09-29T00:00:00.000Z')`,
          ).run(id, harness.projectId, job.job_kind, job.source_version_id);
        }
      },
    })));

    expect(result.report.gates.correctness.passed).toBe(false);
    expect(result.report.gates.correctness.violations.join('\n')).toMatch(/duplicate active job/i);
  });

  it('fails correctness on duplicate current source versions', async () => {
    const result = await runKnowledgeBenchmark(runOptions(), trackedHarness((harness) => ({
      ...harness,
      async runWorker(workerId: string) {
        await harness.runWorker(workerId);
        harness.db.exec(
          `INSERT OR IGNORE INTO knowledge_sources
           (id, project_id, source_kind, source_path, current_hash, status, created_at, updated_at)
           SELECT 'dup-source', project_id, source_kind, source_path, 'dup-hash', status, created_at, updated_at
           FROM knowledge_sources WHERE source_path = 'task-managers/configlet.py'`,
        );
        harness.db.exec(
          `INSERT OR IGNORE INTO knowledge_source_versions
           (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
           SELECT 'dup-version', project_id, 'dup-source', 1, 'dup-hash', content_path, byte_length, created_at
           FROM knowledge_source_versions LIMIT 1`,
        );
      },
    })));

    expect(result.report.gates.correctness.passed).toBe(false);
    expect(result.report.gates.correctness.violations.join('\n')).toMatch(/duplicate current source version/i);
  });

  it('fails correctness and quality when a required source job failed', async () => {
    const result = await runKnowledgeBenchmark(runOptions(), trackedHarness((harness) => ({
      ...harness,
      async runWorker(workerId: string) {
        await harness.runWorker(workerId);
        harness.db.prepare(
          `UPDATE knowledge_jobs SET status = 'failed', failure_code = 'injected_failure', failure_message = 'x'
           WHERE id = (SELECT id FROM knowledge_jobs WHERE project_id = ? ORDER BY id LIMIT 1)`,
        ).run(harness.projectId);
      },
    })));

    expect(result.report.gates.passed).toBe(false);
    expect(result.report.gates.correctness.violations.join('\n')).toMatch(/required source job failed/i);
  });

  it('fails determinism when the second projection digest differs', async () => {
    let calls = 0;
    const result = await runKnowledgeBenchmark(runOptions(), {
      ...trackedHarness(),
      hashProjection: () => (calls++ === 0 ? DIGEST_A : DIGEST_B),
    });

    expect(result.report.determinism).toMatchObject({
      firstRunDigest: DIGEST_A,
      secondRunDigest: DIGEST_B,
      matched: false,
    });
    expect(result.report.gates.determinism.passed).toBe(false);
    expect(result.report.gates.passed).toBe(false);
  });

  it('removes every temporary workspace after success', async () => {
    await runKnowledgeBenchmark(runOptions(), trackedHarness());

    expect(created).toHaveLength(2);
    for (const harness of created) expect(existsSync(harness.workspaceRoot)).toBe(false);
  });

  it('removes every temporary workspace after an injected failure', async () => {
    let calls = 0;
    await expect(runKnowledgeBenchmark(runOptions(), {
      ...trackedHarness(),
      hashProjection: () => {
        calls += 1;
        if (calls === 2) throw new Error('injected hash failure');
        return DIGEST_A;
      },
    })).rejects.toThrow('injected hash failure');

    expect(created).toHaveLength(2);
    for (const harness of created) expect(existsSync(harness.workspaceRoot)).toBe(false);
  });

  it('removes the first workspace when the second harness cannot be created', async () => {
    let calls = 0;
    await expect(runKnowledgeBenchmark(runOptions(), {
      createHarness: (options) => {
        calls += 1;
        if (calls === 2) throw new Error('injected create failure');
        const harness = createKnowledgeBenchmarkHarness(options);
        created.push(harness);
        return harness;
      },
    })).rejects.toThrow('injected create failure');

    expect(created).toHaveLength(1);
    expect(existsSync(created[0].workspaceRoot)).toBe(false);
  });
});

describe('runKnowledgeBenchmarkArchiveGate', () => {
  it('exports a benchmark project and rejects mismatched project rows and undeclared columns', async () => {
    const harness = createKnowledgeBenchmarkHarness({ projectId: 'archive-gate-benchmark' });
    try {
      harness.seedInitialSources();
      await harness.runWorker('archive-gate');
      expect(runKnowledgeBenchmarkArchiveGate(harness.db, harness.projectId)).toEqual({ passed: true });
    } finally {
      harness.cleanup();
    }
  });

  it('fails when the benchmark project does not exist', () => {
    const harness = createKnowledgeBenchmarkHarness();
    try {
      expect(() => runKnowledgeBenchmarkArchiveGate(harness.db, 'missing-project')).toThrow();
    } finally {
      harness.cleanup();
    }
  });
});
