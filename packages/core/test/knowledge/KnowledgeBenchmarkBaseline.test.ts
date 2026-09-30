import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  filterKnowledgeBenchmarkGitStatusEntries,
  isKnowledgeBenchmarkGitDirty,
  parseGitStatusEntries,
} from './KnowledgeBenchmarkBaseline.js';

describe('knowledge benchmark baseline git status filtering', () => {
  it('ignores an untracked allowed report target', () => {
    const entries = parseGitStatusEntries([
      '?? docs/benchmarks/knowledge-baseline-v1.json',
    ].join('\n'));

    expect(filterKnowledgeBenchmarkGitStatusEntries(entries)).toEqual({
      allowedEntries: [
        { code: '??', path: 'docs/benchmarks/knowledge-baseline-v1.json' },
      ],
      dirtyEntries: [],
    });
    expect(isKnowledgeBenchmarkGitDirty(entries)).toBe(false);
  });

  it('ignores a modified allowed report target', () => {
    const entries = parseGitStatusEntries([
      ' M docs/benchmarks/knowledge-baseline-v1.md',
    ].join('\n'));

    expect(filterKnowledgeBenchmarkGitStatusEntries(entries)).toEqual({
      allowedEntries: [
        { code: ' M', path: 'docs/benchmarks/knowledge-baseline-v1.md' },
      ],
      dirtyEntries: [],
    });
    expect(isKnowledgeBenchmarkGitDirty(entries)).toBe(false);
  });

  it('rejects unrelated dirty paths', () => {
    const entries = parseGitStatusEntries([
      '?? docs/benchmarks/knowledge-baseline-v1.json',
      ' M packages/core/src/knowledge/KnowledgeBenchmarkBaseline.ts',
    ].join('\n'));

    expect(filterKnowledgeBenchmarkGitStatusEntries(entries)).toEqual({
      allowedEntries: [
        { code: '??', path: 'docs/benchmarks/knowledge-baseline-v1.json' },
      ],
      dirtyEntries: [
        { code: ' M', path: 'packages/core/src/knowledge/KnowledgeBenchmarkBaseline.ts' },
      ],
    });
    expect(isKnowledgeBenchmarkGitDirty(entries)).toBe(true);
  });

  it('normalizes dirty to false when only generated targets exist', () => {
    const entries = parseGitStatusEntries([
      '?? docs/benchmarks/knowledge-baseline-v1.json',
      ' M docs/benchmarks/knowledge-baseline-v1.md',
    ].join('\n'));

    expect(isKnowledgeBenchmarkGitDirty(entries)).toBe(false);
  });

  it.each([
    'docs/benchmarks/knowledge-baseline-v1.json',
    'docs/benchmarks/knowledge-baseline-v1.md',
  ])('keeps a tracked file renamed into %s dirty', (destination) => {
    const entries = parseGitStatusEntries([
      `R  docs/benchmarks/previous-baseline.txt -> ${destination}`,
    ].join('\n'));

    expect(filterKnowledgeBenchmarkGitStatusEntries(entries)).toEqual({
      allowedEntries: [],
      dirtyEntries: [{
        code: 'R ',
        originalPath: 'docs/benchmarks/previous-baseline.txt',
        path: destination,
      }],
    });
    expect(isKnowledgeBenchmarkGitDirty(entries)).toBe(true);
  });
});

describe('knowledge benchmark package wiring', () => {
  it('runs the baseline helper tests in the benchmark script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:knowledge:benchmark']).toContain('test/knowledge/KnowledgeBenchmarkBaseline.test.ts');
  });

  it('gives the authoritative baseline run an explicit timeout', () => {
    const source = readFileSync('test/knowledge/KnowledgeBenchmark.baseline.test.ts', 'utf8');
    expect(source).toMatch(/\},\s*300_000,?\s*\);/);
  });
});
