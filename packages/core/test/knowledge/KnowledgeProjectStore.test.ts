import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { KnowledgeProjectStore } from '../../src/knowledge/KnowledgeProjectStore.js';

describe('KnowledgeProjectStore', () => {
  const databases: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function createStore(): KnowledgeProjectStore {
    const database = openDatabase(':memory:');
    databases.push(database);
    return new KnowledgeProjectStore(database);
  }

  it('creates, updates, lists, and archives a project with its workspace roots', () => {
    const store = createStore();
    const project = store.create({
      workspaceRoot: '/workspace/wiki',
      name: 'Ariadne Wiki',
      description: 'Project knowledge',
      roots: ['docs', './src'],
    });

    expect(project).toMatchObject({
      id: expect.stringMatching(/^project_/),
      workspaceRoot: '/workspace/wiki',
      name: 'Ariadne Wiki',
      description: 'Project knowledge',
      status: 'active',
      roots: ['docs', 'src'],
    });
    expect(store.get(project.id)).toEqual(project);

    const updated = store.update(project.id, { name: 'Updated Wiki', description: null });
    expect(updated.name).toBe('Updated Wiki');
    expect(updated.description).toBeNull();
    expect(store.list()).toHaveLength(1);

    const archived = store.archive(project.id);
    expect(archived.status).toBe('archived');
    expect(store.list({ status: 'active' })).toEqual([]);
    expect(store.list({ status: 'archived' }).map(({ id }) => id)).toEqual([project.id]);
  });

  it('rejects missing projects and duplicate workspace roots', () => {
    const store = createStore();
    expect(() => store.update('project_missing', { name: 'Nope' })).toThrow(/not found/);
    expect(() => store.archive('project_missing')).toThrow(/not found/);

    store.create({ workspaceRoot: '/workspace/wiki', name: 'One' });
    expect(() => store.create({ workspaceRoot: '/workspace/wiki', name: 'Two' })).toThrow();
  });
});
