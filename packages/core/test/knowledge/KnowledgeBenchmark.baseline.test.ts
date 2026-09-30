import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runKnowledgeBenchmark } from './KnowledgeBenchmarkRunner.js';
import { writeKnowledgeBenchmarkArtifacts } from './KnowledgeBenchmarkReport.js';
import {
  BENCHMARK_OUTPUT_ROOT,
  collectSanitizedEnvironmentMetadata,
  collectSanitizedGitMetadata,
  REPORT_JSON_PATH,
  REPORT_MARKDOWN_PATH,
} from './KnowledgeBenchmarkBaseline.js';
const writeBaseline = process.env.ARIADNE_KNOWLEDGE_BENCHMARK_WRITE === '1';

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
  }, 300_000);
});
