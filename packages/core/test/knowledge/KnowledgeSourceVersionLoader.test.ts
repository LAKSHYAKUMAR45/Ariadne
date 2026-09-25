import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import {
  KnowledgeSourceVersionLoadError,
  loadKnowledgeSourceVersion,
} from '../../src/knowledge/KnowledgeSourceVersionLoader.js';

describe('KnowledgeSourceVersionLoader', () => {
  let db: Database.Database;
  let store: KnowledgeSourceStore;
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-source-version-loader-test-'));
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    db.prepare(
      `INSERT INTO knowledge_projects
       (id, workspace_root, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run('project_1', workspaceRoot, 'Loader Test', new Date().toISOString(), new Date().toISOString());
    store = new KnowledgeSourceStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('loads immutable version content from registered source storage after the workspace file changes', () => {
    const workspaceFile = writeWorkspaceFile('docs/guide.md', 'version one\n');
    const storedPath = 'sources/metadata/docs-guide-v1.md';
    writeStoredContent(storedPath, Buffer.from('version one\n', 'utf8'));
    const source = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/guide.md',
      content: 'version one\n',
      contentPath: storedPath,
      mimeType: 'text/markdown',
    });
    const version = latestVersion(source.id);

    writeFileSync(workspaceFile, 'version two\n', 'utf8');

    expect(loadKnowledgeSourceVersion(db, { projectId: 'project_1', sourceVersionId: version.id })).toEqual({
      projectId: 'project_1',
      sourceId: source.id,
      sourceVersionId: version.id,
      sourceKind: 'file',
      sourcePath: 'docs/guide.md',
      contentPath: storedPath,
      contentHash: version.contentHash,
      mimeType: 'text/markdown',
      byteLength: version.byteLength,
      content: 'version one\n',
    });
  });

  it('fails when the requested source version does not exist', () => {
    expectLoadError(
      () => loadKnowledgeSourceVersion(db, { projectId: 'project_1', sourceVersionId: 'source-version_missing' }),
      'source_version_missing',
    );
  });

  it('fails when the stored content file is missing', () => {
    const source = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/missing.md',
      content: 'missing\n',
      contentPath: 'sources/metadata/docs-missing.md',
      mimeType: 'text/markdown',
    });
    const version = latestVersion(source.id);

    expectLoadError(
      () => loadKnowledgeSourceVersion(db, { projectId: 'project_1', sourceVersionId: version.id }),
      'source_content_missing',
    );
  });

  it('fails when stored content does not match the recorded hash', () => {
    writeStoredContent('sources/metadata/docs-hash.md', Buffer.from('tampered\n', 'utf8'));
    const source = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/hash.md',
      content: 'expected\n',
      contentPath: 'sources/metadata/docs-hash.md',
      mimeType: 'text/markdown',
    });
    const version = latestVersion(source.id);

    expectLoadError(
      () => loadKnowledgeSourceVersion(db, { projectId: 'project_1', sourceVersionId: version.id }),
      'source_hash_mismatch',
    );
  });

  it('rejects stored paths that escape the approved source storage root', () => {
    writeStoredFileRelativeToWorkspace('.ariadne/knowledge/escape.txt', Buffer.from('escape\n', 'utf8'));
    const source = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/escape.md',
      content: 'escape\n',
      contentPath: 'sources/metadata/docs-escape.md',
      mimeType: 'text/markdown',
    });
    const version = latestVersion(source.id);
    db.prepare('UPDATE knowledge_source_versions SET content_path = ? WHERE id = ?').run('../escape.txt', version.id);

    expectLoadError(
      () => loadKnowledgeSourceVersion(db, { projectId: 'project_1', sourceVersionId: version.id }),
      'source_path_rejected',
    );
  });

  it('rejects stored paths that traverse symbolic links', () => {
    const targetDir = join(workspaceRoot, 'linked-target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'content.md'), 'through symlink\n', 'utf8');
    mkdirSync(join(workspaceRoot, '.ariadne', 'knowledge', 'sources'), { recursive: true });
    symlinkSync(targetDir, join(workspaceRoot, '.ariadne', 'knowledge', 'sources', 'linked'));
    const source = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/link.md',
      content: 'through symlink\n',
      contentPath: 'sources/linked/content.md',
      mimeType: 'text/markdown',
    });
    const version = latestVersion(source.id);

    expectLoadError(
      () => loadKnowledgeSourceVersion(db, { projectId: 'project_1', sourceVersionId: version.id }),
      'source_path_rejected',
    );
  });

  it('fails when the stored source exceeds the byte limit', () => {
    writeStoredContent('sources/metadata/docs-large.md', Buffer.from('12345', 'utf8'));
    const source = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/large.md',
      content: '12345',
      contentPath: 'sources/metadata/docs-large.md',
      mimeType: 'text/plain',
    });
    const version = latestVersion(source.id);

    expectLoadError(
      () => loadKnowledgeSourceVersion(db, { projectId: 'project_1', sourceVersionId: version.id, maxBytes: 4 }),
      'source_too_large',
    );
  });

  it('rejects invalid utf-8 and binary stored content', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    writeStoredContent('sources/media/docs-binary.bin', bytes);
    const source = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/binary.bin',
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      contentPath: 'sources/media/docs-binary.bin',
      mimeType: 'application/octet-stream',
    });
    const version = latestVersion(source.id);
    db.prepare('UPDATE knowledge_source_versions SET byte_length = ? WHERE id = ?').run(bytes.byteLength, version.id);

    expectLoadError(
      () => loadKnowledgeSourceVersion(db, { projectId: 'project_1', sourceVersionId: version.id }),
      'unsupported_source',
    );
  });

  function writeWorkspaceFile(relativePath: string, content: string): string {
    const absolutePath = join(workspaceRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
    return absolutePath;
  }

  function writeStoredContent(relativePath: string, content: Buffer): void {
    writeStoredFileRelativeToWorkspace(`.ariadne/knowledge/${relativePath}`, content);
  }

  function writeStoredFileRelativeToWorkspace(relativePath: string, content: Buffer): void {
    const absolutePath = join(workspaceRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }

  function latestVersion(sourceId: string) {
    const version = store.listVersions('project_1', sourceId as never).at(-1);
    expect(version).toBeDefined();
    return version!;
  }

  function expectLoadError(action: () => unknown, code: KnowledgeSourceVersionLoadError['code']): void {
    try {
      action();
      throw new Error(`Expected load to fail with ${code}`);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(KnowledgeSourceVersionLoadError);
      expect((error as KnowledgeSourceVersionLoadError).code).toBe(code);
    }
  }
});
