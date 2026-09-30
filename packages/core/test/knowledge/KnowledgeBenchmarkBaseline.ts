import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { relative, resolve } from 'node:path';
import type { KnowledgeBenchmarkRunOptions } from './KnowledgeBenchmarkRunner.js';

export interface GitStatusEntry {
  code: string;
  path: string;
  originalPath?: string;
}

export interface FilteredGitStatusEntries {
  allowedEntries: GitStatusEntry[];
  dirtyEntries: GitStatusEntry[];
}

export const REPO_ROOT = resolve(process.cwd(), '..', '..');
export const BENCHMARK_OUTPUT_ROOT = resolve(REPO_ROOT, 'docs', 'benchmarks');
export const REPORT_JSON_PATH = resolve(BENCHMARK_OUTPUT_ROOT, 'knowledge-baseline-v1.json');
export const REPORT_MARKDOWN_PATH = resolve(BENCHMARK_OUTPUT_ROOT, 'knowledge-baseline-v1.md');
export const REPORT_PATH_ALLOWLIST = new Set([
  relative(REPO_ROOT, REPORT_JSON_PATH),
  relative(REPO_ROOT, REPORT_MARKDOWN_PATH),
]);

const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function parseGitStatusPath(path: string): Pick<GitStatusEntry, 'path' | 'originalPath'> {
  const renameSeparator = ' -> ';
  if (!path.includes(renameSeparator)) {
    return { path };
  }

  const separatorIndex = path.lastIndexOf(renameSeparator);
  return {
    originalPath: path.slice(0, separatorIndex).trim(),
    path: path.slice(separatorIndex + renameSeparator.length).trim(),
  };
}

export function parseGitStatusEntries(output: string): GitStatusEntry[] {
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
        ...parseGitStatusPath(line.slice(3)),
      };
    });
}

export function filterKnowledgeBenchmarkGitStatusEntries(entries: readonly GitStatusEntry[]): FilteredGitStatusEntries {
  const allowedEntries: GitStatusEntry[] = [];
  const dirtyEntries: GitStatusEntry[] = [];

  for (const entry of entries) {
    const involvedPaths = entry.originalPath === undefined
      ? [entry.path]
      : [entry.originalPath, entry.path];
    if (involvedPaths.every((path) => REPORT_PATH_ALLOWLIST.has(path))) {
      allowedEntries.push(entry);
      continue;
    }

    dirtyEntries.push(entry);
  }

  return { allowedEntries, dirtyEntries };
}

export function isKnowledgeBenchmarkGitDirty(entries: readonly GitStatusEntry[]): boolean {
  return filterKnowledgeBenchmarkGitStatusEntries(entries).dirtyEntries.length > 0;
}

export function collectSanitizedGitMetadata(): KnowledgeBenchmarkRunOptions['git'] {
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
  const filteredEntries = filterKnowledgeBenchmarkGitStatusEntries(statusEntries);
  if (filteredEntries.dirtyEntries.length > 0) {
    throw new Error(
      `Benchmark baseline requires a clean branch before execution; found dirty paths: ${filteredEntries.dirtyEntries.map((entry) => `${entry.code} ${entry.path}`).join(', ')}`,
    );
  }

  return {
    commit,
    dirty: isKnowledgeBenchmarkGitDirty(statusEntries),
  };
}

export function collectSanitizedEnvironmentMetadata(): KnowledgeBenchmarkRunOptions['environment'] {
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
