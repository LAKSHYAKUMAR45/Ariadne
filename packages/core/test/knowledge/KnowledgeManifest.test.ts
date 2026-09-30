import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildKnowledgeManifest, readKnowledgeManifest, writeKnowledgeManifest } from '../../src/knowledge/KnowledgeManifest.js';

describe('KnowledgeManifest', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('round-trips a manifest and writes it atomically', () => {
    const root = mkdtempSync(join(process.cwd(), '.knowledge-manifest-test-'));
    directories.push(root);
    const manifest = buildKnowledgeManifest('project_123', '2026-09-24T00:00:00.000Z');

    writeKnowledgeManifest(root, manifest);

    expect(readKnowledgeManifest(root, manifest.projectId)).toEqual(manifest);
    expect(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))).toEqual(manifest);
    expect(existsSync(join(root, '.manifest.json.tmp'))).toBe(false);
  });

  it('rejects mismatched project ids and unsupported versions', () => {
    const root = mkdtempSync(join(process.cwd(), '.knowledge-manifest-test-'));
    directories.push(root);
    const manifest = buildKnowledgeManifest('project_123');
    writeKnowledgeManifest(root, manifest);

    expect(() => readKnowledgeManifest(root, 'project_other')).toThrow(/project ID/);
    expect(() =>
      writeKnowledgeManifest(root, { ...manifest, manifestVersion: 99 as 1 }),
    ).toThrow(/manifest version/);
  });
});
