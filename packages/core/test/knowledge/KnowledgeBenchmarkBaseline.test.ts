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
});
