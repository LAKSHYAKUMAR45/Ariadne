import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/db.js';
import { exportKnowledgeProject, importKnowledgeProject } from '../../src/knowledge/KnowledgeArchive.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';
import { KnowledgeProjectStore } from '../../src/knowledge/KnowledgeProjectStore.js';

describe('KnowledgeArchive', () => {
  const databases: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function database() {
    const db = openDatabase(':memory:');
    databases.push(db);
    return db;
  }

  function seed(db: ReturnType<typeof openDatabase>) {
    const project = new KnowledgeProjectStore(db).create({
      id: 'project_archive' as never,
      workspaceRoot: '/workspace/wiki',
      name: 'Archive Wiki',
      description: 'Portable',
      roots: ['docs'],
    });
    new KnowledgePageStore(db).createPageVersion({
      projectId: project.id,
      type: 'concept',
      title: 'SQLite',
      slug: 'sqlite',
      content: 'See [the graph](pages/architecture/graph.md).',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    db.prepare(
      `INSERT INTO knowledge_provider_profiles
       (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('provider_1', project.id, 'remote', 'default', '{"apiKey":"secret"}', '2026-01-01', '2026-01-01');
    return project.id;
  }

  it('exports a complete manifest, frontmatter, wikilinks, graph data, and omits secrets', () => {
    const db = database();
    const projectId = seed(db);
    const page = db.prepare('SELECT id FROM knowledge_pages WHERE project_id = ?').get(projectId) as { id: string };
    const archive = exportKnowledgeProject(db, {
      projectId,
      pageContents: { [page.id]: 'See [the graph](pages/architecture/graph.md).' },
      includeObsidian: true,
      generatedAt: '2026-01-02',
    });

    expect(archive.manifest).toMatchObject({
      archiveVersion: 1,
      format: 'ariadne-knowledge-archive',
      projectId,
      generatedAt: '2026-01-02',
    });
    expect(archive.manifest.entries.map(({ path }) => path)).toEqual(
      expect.arrayContaining(['project.json', 'graph.json', 'data/knowledge_pages.json', 'pages/concept/sqlite.md', '.obsidian/app.json']),
    );
    expect(String(archive.files['pages/concept/sqlite.md'])).toContain('---');
    expect(String(archive.files['pages/concept/sqlite.md'])).toContain('[[graph|the graph]]');
    expect(String(archive.files['data/knowledge_provider_profiles.json'])).not.toContain('secret');
    expect(archive.manifest.omitted).toContain('knowledge_provider_profiles.configuration_json');
  });

  it('rejects traversal and version mismatch before changing state', () => {
    const db = database();
    const projectId = seed(db);
    const archive = exportKnowledgeProject(db, { projectId });
    const original = db.prepare('SELECT COUNT(*) AS count FROM knowledge_projects').get();
    const traversal = {
      ...archive,
      files: { ...archive.files, '../escape.json': 'bad' },
    };
    expect(() => importKnowledgeProject(db, traversal)).toThrow(/traversal/);
    expect(() => importKnowledgeProject(db, { ...archive, manifest: { ...archive.manifest, archiveVersion: 99 as 1 } })).toThrow(
      /version/,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_projects').get()).toEqual(original);
  });

  it('imports atomically and supports replacing an existing project', () => {
    const source = database();
    const projectId = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const target = database();
    expect(importKnowledgeProject(target, archive)).toMatchObject({ projectId, rows: expect.any(Number) });
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({ name: 'Archive Wiki' });
    expect(() => importKnowledgeProject(target, archive)).toThrow(/already exists/);

    const broken = {
      ...archive,
      manifest: {
        ...archive.manifest,
        entries: archive.manifest.entries.map((entry) =>
          entry.path === 'project.json' ? { ...entry, sha256: createHash('sha256').update('broken').digest('hex') } : entry,
        ),
      },
    };
    expect(() => importKnowledgeProject(target, broken, { replaceExisting: true })).toThrow(/checksum/);
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({ name: 'Archive Wiki' });
  });
});
