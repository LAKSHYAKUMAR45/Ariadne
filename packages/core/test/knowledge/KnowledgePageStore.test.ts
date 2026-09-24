import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';

describe('KnowledgePageStore', () => {
  const databases: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function createStore(): KnowledgePageStore {
    const database = openDatabase(':memory:');
    databases.push(database);
    database
      .prepare(
        `INSERT INTO knowledge_projects
         (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run('project_1', '/workspace', 'Wiki', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    return new KnowledgePageStore(database);
  }

  it('creates versions, selects the current version, and supersedes content', () => {
    const store = createStore();
    const first = store.createPageVersion({
      projectId: 'project_1',
      type: 'concept',
      title: 'SQLite',
      slug: 'sqlite',
      content: 'First',
      createdAt: '2026-01-01T00:00:00.000Z',
      provenance: [{ kind: 'task', id: 'task_1', confidence: 0.8 }],
    });
    const second = store.supersedePageVersion({
      projectId: 'project_1',
      pageId: first.pageId,
      type: 'concept',
      title: 'SQLite',
      slug: 'sqlite',
      content: 'Second',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    expect(first.versionNumber).toBe(1);
    expect(second.versionNumber).toBe(2);
    expect(store.listVersions('project_1', first.pageId).map(({ versionNumber }) => versionNumber)).toEqual([1, 2]);
    expect(store.getCurrentPage('project_1', first.pageId)).toMatchObject({
      id: first.pageId,
      currentVersion: 2,
      currentVersionId: second.id,
      status: 'active',
    });
  });

  it('marks a page stale without deleting its current version', () => {
    const store = createStore();
    const version = store.createPageVersion({
      projectId: 'project_1',
      type: 'failure',
      title: 'Failure',
      slug: 'failure',
      content: 'Details',
    });

    expect(store.markPageStale('project_1', version.pageId)).toMatchObject({
      id: version.pageId,
      status: 'stale',
      currentVersion: 1,
    });
    expect(store.listPages('project_1', 'failure')).toHaveLength(1);
  });
});
