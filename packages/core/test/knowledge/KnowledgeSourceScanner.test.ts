import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanKnowledgeSources } from '../../src/knowledge/KnowledgeSourceScanner.js';

describe('scanKnowledgeSources', () => {
  let workspaceRoot: string;

  afterEach(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('recursively returns eligible files in stable path order with directory context', async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ariadne-knowledge-scan-'));
    await mkdir(path.join(workspaceRoot, 'docs', 'guides'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'z.md'), 'z');
    await writeFile(path.join(workspaceRoot, 'docs', 'readme.md'), 'readme');
    await writeFile(path.join(workspaceRoot, 'docs', 'guides', 'start.md'), 'start');

    const sources = await scanKnowledgeSources(workspaceRoot, { workspaceRoot });

    expect(sources.map((source) => source.path)).toEqual([
      'docs/guides/start.md',
      'docs/readme.md',
      'z.md',
    ]);
    expect(sources.map((source) => source.directory)).toEqual(['docs/guides', 'docs', '.']);
    expect(sources[0]).toMatchObject({
      absolutePath: path.join(workspaceRoot, 'docs', 'guides', 'start.md'),
      size: 5,
    });
  });

  it('excludes paths rejected or skipped by the source policy', async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ariadne-knowledge-scan-'));
    await mkdir(path.join(workspaceRoot, 'docs', 'generated'), { recursive: true });
    await mkdir(path.join(workspaceRoot, 'node_modules', 'package'), { recursive: true });
    await writeFile(path.join(workspaceRoot, '.env'), 'DATABASE_PASSWORD=nope');
    await writeFile(path.join(workspaceRoot, 'docs', 'generated', 'api.md'), 'generated');
    await writeFile(path.join(workspaceRoot, 'docs', 'keep.md'), 'keep');
    await writeFile(path.join(workspaceRoot, 'node_modules', 'package', 'index.js'), 'module');

    const sources = await scanKnowledgeSources(workspaceRoot, {
      workspaceRoot,
      ignorePatterns: ['docs/generated/**'],
    });

    expect(sources.map((source) => source.path)).toEqual(['docs/keep.md']);
  });
});
