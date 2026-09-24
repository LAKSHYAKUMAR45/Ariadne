import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import {
  KnowledgeSourceStore,
  computeSourceVersion,
} from '../../src/knowledge/KnowledgeSourceStore.js';

describe('KnowledgeSourceStore', () => {
  let db: Database.Database;
  let store: KnowledgeSourceStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    db.prepare(
      `INSERT INTO knowledge_projects
       (id, workspace_root, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run('project_1', '/workspace', 'Test', new Date().toISOString(), new Date().toISOString());
    store = new KnowledgeSourceStore(db);
  });

  it('creates a deterministic source and skips an unchanged content hash', () => {
    const first = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/readme.md',
      content: 'hello',
      format: 'markdown',
    });
    const second = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: './docs/readme.md',
      content: 'hello',
      format: 'markdown',
    });

    expect(second.id).toBe(first.id);
    expect(store.listVersions('project_1', first.id)).toHaveLength(1);
    expect(computeSourceVersion('hello')).toEqual({
      hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      size: 5,
    });
  });

  it('creates a new version when content changes', () => {
    const first = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/readme.md',
      content: 'one',
    });
    store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/readme.md',
      content: 'two',
    });

    const versions = store.listVersions('project_1', first.id);
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);
    expect(store.get('project_1', first.id)?.contentHash).toBe(computeSourceVersion('two').hash);
  });

  it('marks missing sources stale instead of deleting them', () => {
    const source = store.register({
      projectId: 'project_1',
      kind: 'file',
      path: 'docs/readme.md',
      content: 'one',
    });

    const stale = store.markDeleted('project_1', source.id);
    expect(stale.deletedAt).not.toBeNull();
    expect(store.get('project_1', source.id)?.deletedAt).not.toBeNull();
    expect(store.list('project_1')).toHaveLength(1);
  });
});
