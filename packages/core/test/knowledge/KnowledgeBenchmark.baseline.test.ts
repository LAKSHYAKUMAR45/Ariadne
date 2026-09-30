import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runKnowledgeBenchmark,
  type KnowledgeBenchmarkRunOptions,
} from './KnowledgeBenchmarkRunner.js';
import { writeKnowledgeBenchmarkArtifacts } from './KnowledgeBenchmarkReport.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const BENCHMARK_OUTPUT_ROOT = resolve(REPO_ROOT, 'docs', 'benchmarks');
const REPORT_JSON_PATH = resolve(BENCHMARK_OUTPUT_ROOT, 'knowledge-baseline-v1.json');
const REPORT_MARKDOWN_PATH = resolve(BENCHMARK_OUTPUT_ROOT, 'knowledge-baseline-v1.md');
const REPORT_PATH_ALLOWLIST = new Set([
  relative(REPO_ROOT, REPORT_JSON_PATH),
  relative(REPO_ROOT, REPORT_MARKDOWN_PATH),
]);
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const writeBaseline = process.env.ARIADNE_KNOWLEDGE_BENCHMARK_WRITE === '1';

interface GitStatusEntry {
  code: string;
  path: string;
}

function parseGitStatusEntries(output: string): GitStatusEntry[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.length < 4 || line[2] !== ' ') {
        throw new Error(`Unsupported git status line: ${line}`);
      }
      return {
        code: line.slice(0, 2),
        path: line.slice(3),
      };
    });
}

function isAllowedAbsentArtifact(entry: GitStatusEntry): boolean {
  return REPORT_PATH_ALLOWLIST.has(entry.path)
    && /^[ D]+$/.test(entry.code)
    && entry.code.includes('D');
}

function collectSanitizedGitMetadata(): KnowledgeBenchmarkRunOptions['git'] {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    throw new Error('Benchmark baseline requires a 40-character lowercase Git commit hash');
  }

  const statusOutput = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const statusEntries = parseGitStatusEntries(statusOutput);
  const disallowedEntries = statusEntries.filter((entry) => !isAllowedAbsentArtifact(entry));
  if (disallowedEntries.length > 0) {
    throw new Error(
      `Benchmark baseline requires a clean branch before execution; found dirty paths: ${disallowedEntries.map((entry) => `${entry.code} ${entry.path}`).join(', ')}`,
    );
  }

  return {
    commit,
    dirty: statusEntries.length > 0,
  };
}

function collectSanitizedEnvironmentMetadata(): KnowledgeBenchmarkRunOptions['environment'] {
  const cpuDetails = cpus();
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpuModel: cpuDetails[0]?.model.trim() || 'unknown',
    logicalCpuCount: cpuDetails.length,
    totalMemoryBytes: totalmem(),
  };
}

describe('knowledge benchmark baseline artifact', () => {
  it.skipIf(!writeBaseline)('writes a clean authoritative local baseline', async () => {
    const git = collectSanitizedGitMetadata();
    const environment = collectSanitizedEnvironmentMetadata();
    const result = await runKnowledgeBenchmark({
      generatedAt: new Date().toISOString(),
      git,
      environment,
      timedSearchRounds: 30,
    });

    expect(result.report.git).toEqual(git);
    expect(result.report.environment).toEqual(environment);
    expect(result.report.configuration.searchTimedRounds).toBe(30);
    expect(result.report.gates).toMatchObject({
      passed: true,
      quality: { passed: true },
      correctness: { passed: true },
      privacy: { passed: true },
      determinism: { passed: true },
    });

    const paths = writeKnowledgeBenchmarkArtifacts(
      BENCHMARK_OUTPUT_ROOT,
      result.report,
      result.privacy,
    );
    expect(paths).toEqual({
      jsonPath: REPORT_JSON_PATH,
      markdownPath: REPORT_MARKDOWN_PATH,
    });
    expect(existsSync(REPORT_JSON_PATH)).toBe(true);
    expect(existsSync(REPORT_MARKDOWN_PATH)).toBe(true);
  });
});
