import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import { exportKnowledgeProject, importKnowledgeProject } from '../../src/knowledge/KnowledgeArchive.js';
import { loadKnowledgeSourceVersion } from '../../src/knowledge/KnowledgeSourceVersionLoader.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';
import { KnowledgeProjectStore } from '../../src/knowledge/KnowledgeProjectStore.js';

describe('KnowledgeArchive', () => {
  const databases: Array<{ close: () => void }> = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  function database() {
    const db = openDatabase(':memory:');
    databases.push(db);
    return db;
  }

  function importOptions(overrides: Parameters<typeof importKnowledgeProject>[2] = {}) {
    return {
      workspaceRoot: overrides.workspaceRoot ?? createWorkspaceRoot('.knowledge-archive-import-'),
      ...overrides,
    };
  }

  function rewriteArchiveFile(
    archive: ReturnType<typeof exportKnowledgeProject>,
    filePath: string,
    content: string,
  ): ReturnType<typeof exportKnowledgeProject> {
    const files = {
      ...archive.files,
      [filePath]: content,
    };
    const entries = archive.manifest.entries
      .map((entry) =>
        entry.path === filePath
          ? {
              ...entry,
              size: Buffer.byteLength(content, 'utf8'),
              sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
            }
          : entry,
      )
      .sort((left, right) => left.path.localeCompare(right.path));
    return {
      manifest: {
        ...archive.manifest,
        entries,
      },
      files,
    };
  }

  function removeArchiveFile(
    archive: ReturnType<typeof exportKnowledgeProject>,
    filePath: string,
  ): ReturnType<typeof exportKnowledgeProject> {
    const { [filePath]: _removed, ...files } = archive.files;
    return {
      manifest: {
        ...archive.manifest,
        entries: archive.manifest.entries.filter((entry) => entry.path !== filePath),
      },
      files,
    };
  }

  function tableRows<T extends Record<string, unknown>>(
    archive: ReturnType<typeof exportKnowledgeProject>,
    table: string,
  ): T[] {
    return JSON.parse(String(archive.files[`data/${table}.json`])) as T[];
  }

  function rewriteTableRows<T extends Record<string, unknown>>(
    archive: ReturnType<typeof exportKnowledgeProject>,
    table: string,
    rows: T[],
  ): ReturnType<typeof exportKnowledgeProject> {
    return rewriteArchiveFile(archive, `data/${table}.json`, `${JSON.stringify(rows, null, 2)}\n`);
  }

  function createWorkspaceRoot(prefix: string): string {
    const directory = mkdtempSync(join(process.cwd(), prefix));
    directories.push(directory);
    return directory;
  }

  function writeWorkspaceFile(workspaceRoot: string, relativePath: string, content: string): void {
    const absolutePath = join(workspaceRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  }

  function seed(db: ReturnType<typeof openDatabase>) {
    const workspaceRoot = createWorkspaceRoot('.knowledge-archive-workspace-');
    const project = new KnowledgeProjectStore(db).create({
      id: 'project_archive' as never,
      workspaceRoot,
      name: 'Archive Wiki',
      description: 'Portable',
      roots: ['docs'],
    });
    const pageContent = `---
title: SQLite
type: concept
slug: sqlite
status: active
version: 1
generated_at: 2026-01-01T00:00:00.000Z
---

See [[graph|the graph]].
`;
    const sourceContent = '# SQLite source\n';
    const sourceHash = createHash('sha256').update(sourceContent, 'utf8').digest('hex');
    writeWorkspaceFile(workspaceRoot, '.ariadne/knowledge/pages/concept/sqlite.md', pageContent);
    writeWorkspaceFile(workspaceRoot, '.ariadne/knowledge/sources/workspace/docs/sqlite-hash.md', sourceContent);
    writeWorkspaceFile(
      workspaceRoot,
      'conversations/conversation_1/message_1.json',
      JSON.stringify({ content: 'Imported question', citations: [], retrievalMode: 'knowledge' }),
    );
    new KnowledgePageStore(db).createPageVersion({
      projectId: project.id,
      type: 'concept',
      title: 'SQLite',
      slug: 'sqlite',
      content: 'See [the graph](pages/architecture/graph.md).',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const page = db.prepare('SELECT id FROM knowledge_pages WHERE project_id = ?').get(project.id) as { id: string };
    const pageVersion = db.prepare('SELECT id FROM knowledge_page_versions WHERE project_id = ?').get(project.id) as { id: string };
    db.prepare(
      `INSERT INTO knowledge_sources
       (id, project_id, source_kind, source_path, source_url, title, current_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('source_1', project.id, 'file', 'docs/sqlite.md', null, 'SQLite source', sourceHash, 'active', '2026-01-01', '2026-01-01');
    db.prepare(
      `INSERT INTO knowledge_source_versions
       (id, project_id, source_id, version_number, content_hash, content_path, byte_length, mime_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'source_version_1',
      project.id,
      'source_1',
      1,
      sourceHash,
      'sources/workspace/docs/sqlite-hash.md',
      Buffer.byteLength(sourceContent, 'utf8'),
      'text/markdown',
      '2026-01-01',
    );
    db.prepare(
      `INSERT INTO knowledge_source_spans
       (id, project_id, source_version_id, start_offset, end_offset, start_line, start_column, end_line, end_column, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('source_span_1', project.id, 'source_version_1', 0, 10, 1, 1, 1, 11, 'heading', '2026-01-01');
    db.prepare(
      `INSERT INTO knowledge_page_sources
       (page_version_id, project_id, source_version_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(pageVersion.id, project.id, 'source_version_1', '2026-01-01');
    db.prepare(
      `INSERT INTO knowledge_page_provenance
       (id, project_id, page_version_id, source_kind, source_id, source_span_id, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('provenance_1', project.id, pageVersion.id, 'source', 'source_1', 'source_span_1', 1, '2026-01-01');
    db.prepare(
      `INSERT INTO knowledge_graph_nodes
       (id, project_id, node_type, label, source_kind, source_id, qualified_name, source_version_id, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('graph_node_source', project.id, 'file', 'SQLite source', 'source', 'source_1', 'docs/sqlite.md', 'source_version_1', 1, '2026-01-01', '2026-01-01');
    db.prepare(
      `INSERT INTO knowledge_graph_nodes
       (id, project_id, node_type, label, source_kind, source_id, qualified_name, source_version_id, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('graph_node_page', project.id, 'page', 'SQLite', 'page', page.id, 'sqlite', null, 1, '2026-01-01', '2026-01-01');
    db.prepare(
      `INSERT INTO knowledge_graph_edges
       (id, project_id, source_node_id, target_node_id, edge_type, evidence_json, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'graph_edge_1',
      project.id,
      'graph_node_source',
      'graph_node_page',
      'references',
      JSON.stringify({
        evidence: ['explicit_link'],
        weight: 1,
        provenance: [{ kind: 'source', id: 'source_1', sourceVersionId: 'source_version_1', confidence: 1 }],
      }),
      1,
      '2026-01-01',
      '2026-01-01',
    );
    db.prepare(
      `INSERT INTO knowledge_jobs
       (id, project_id, job_kind, source_version_id, status, payload_json, result_json, result_processing_mode, requested_at, started_at, completed_at, retry_count, max_retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'job_1',
      project.id,
      'analyze',
      'source_version_1',
      'completed',
      '{"kind":"analyze"}',
      '{"processingMode":"deterministic"}',
      'deterministic',
      '2026-01-01',
      '2026-01-01',
      '2026-01-01',
      0,
      3,
    );
    db.prepare(
      `INSERT INTO knowledge_job_events
       (id, project_id, job_id, event_kind, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('job_event_1', project.id, 'job_1', 'completed', '{"status":"completed"}', '2026-01-01');
    db.prepare(
      `INSERT INTO knowledge_reviews
       (id, project_id, page_version_id, status, requested_at, reviewed_at, reviewer_id, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('review_1', project.id, pageVersion.id, 'approved', '2026-01-01', '2026-01-02', 'reviewer', 'Looks good');
    db.prepare(
      `INSERT INTO knowledge_review_actions
       (id, project_id, review_id, action_kind, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('review_action_1', project.id, 'review_1', 'approve', 'Ship it', '2026-01-02');
    db.prepare(
      `INSERT INTO knowledge_conversations
       (id, project_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('conversation_1', project.id, 'Archive chat', '2026-01-01', '2026-01-01');
    db.prepare(
      `INSERT INTO knowledge_messages
       (id, project_id, conversation_id, role, content_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('message_1', project.id, 'conversation_1', 'user', 'conversations/conversation_1/message_1.json', '2026-01-01');
    db.prepare(
      `INSERT INTO knowledge_provider_profiles
       (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('provider_1', project.id, 'remote', 'default', '{"apiKey":"secret"}', '2026-01-01', '2026-01-01');
    return { projectId: project.id, workspaceRoot };
  }

  it('exports a complete manifest, frontmatter, wikilinks, graph data, and omits secrets', () => {
    const db = database();
    const { projectId, workspaceRoot } = seed(db);
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
    expect(String(archive.files['data/knowledge_projects.json'])).not.toContain(workspaceRoot);
    expect(String(archive.files['project.json'])).not.toContain(workspaceRoot);
    expect(archive.manifest.omitted).toContain('knowledge_provider_profiles.configuration_json');
  });

  it('rejects exporting tampered or symlinked artifact files', () => {
    const db = database();
    const { projectId, workspaceRoot } = seed(db);
    writeWorkspaceFile(workspaceRoot, '.ariadne/knowledge/sources/workspace/docs/sqlite-hash.md', '# Tampered source\n');
    expect(() => exportKnowledgeProject(db, { projectId })).toThrow(/does not match persisted metadata/i);

    writeWorkspaceFile(workspaceRoot, '.ariadne/knowledge/sources/workspace/docs/sqlite-hash.md', '# SQLite source\n');
    const outsideRoot = createWorkspaceRoot('.knowledge-archive-export-outside-');
    mkdirSync(join(outsideRoot, 'conversation_1'), { recursive: true });
    writeFileSync(
      join(outsideRoot, 'conversation_1', 'message_1.json'),
      JSON.stringify({ content: 'Imported question', citations: [], retrievalMode: 'knowledge' }),
      'utf8',
    );
    rmSync(join(workspaceRoot, 'conversations'), { recursive: true, force: true });
    symlinkSync(outsideRoot, join(workspaceRoot, 'conversations'));
    expect(() => exportKnowledgeProject(db, { projectId })).toThrow(/symbolic links/i);
  });

  it('rejects traversal and version mismatch before changing state', () => {
    const db = database();
    const { projectId } = seed(db);
    const archive = exportKnowledgeProject(db, { projectId });
    const original = db.prepare('SELECT COUNT(*) AS count FROM knowledge_projects').get();
    const traversal = {
      ...archive,
      files: { ...archive.files, '../escape.json': 'bad' },
    };
    expect(() => importKnowledgeProject(db, traversal, importOptions())).toThrow(/traversal/);
    expect(() => importKnowledgeProject(db, { ...archive, manifest: { ...archive.manifest, archiveVersion: 99 as 1 } }, importOptions())).toThrow(
      /version/,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_projects').get()).toEqual(original);
  });

  it('rejects malformed manifest project identifiers with a stable import error', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const invalidArchive = {
      ...archive,
      manifest: {
        ...archive.manifest,
        projectId: 123 as unknown as string,
      },
    };

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/project ID must be a non-empty string/i);
  });

  it('rejects an oversized aggregate archive before mutating the database', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const oversizedFiles = { ...archive.files } as Record<string, string | Uint8Array>;
    const oversizedEntries = [...archive.manifest.entries];
    const chunk = new Uint8Array(16 * 1024 * 1024);
    for (let index = 0; index < 17; index += 1) {
      const filePath = `payloads/chunk-${index}.bin`;
      oversizedFiles[filePath] = chunk;
      oversizedEntries.push({
        path: filePath,
        size: chunk.byteLength,
        sha256: createHash('sha256').update(chunk).digest('hex'),
        mediaType: 'application/octet-stream',
      });
    }
    const invalidArchive = {
      ...archive,
      files: oversizedFiles,
      manifest: { ...archive.manifest, entries: oversizedEntries },
    };
    const target = database();
    const targetWorkspaceRoot = importOptions().workspaceRoot;
    new KnowledgeProjectStore(target).create({
      id: projectId as never,
      workspaceRoot: targetWorkspaceRoot,
      name: 'Existing target',
    });

    expect(() =>
      importKnowledgeProject(target, invalidArchive, importOptions({ replaceExisting: true, workspaceRoot: targetWorkspaceRoot })),
    ).toThrow(
      /maximum supported total file size/i,
    );
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({
      name: 'Existing target',
    });
  });

  it('rejects malformed manifest entry structures with a stable import error', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const invalidArchive = {
      ...archive,
      manifest: {
        ...archive.manifest,
        entries: {} as unknown as typeof archive.manifest.entries,
      },
    };

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/manifest entries must be an array/i);
  });

  it('rejects unlisted archive payload files that bypass manifest checksums', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const invalidArchive = {
      ...archive,
      files: {
        ...archive.files,
        'data/knowledge_messages.json': `${JSON.stringify([{ invalid: true }], null, 2)}\n`,
      },
      manifest: {
        ...archive.manifest,
        entries: archive.manifest.entries.filter((entry) => entry.path !== 'data/knowledge_messages.json'),
      },
    };

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/not declared in the manifest|must match exactly/i);
  });

  it('imports atomically and supports replacing an existing project', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const target = database();
    const imported = importOptions();
    expect(importKnowledgeProject(target, archive, imported)).toMatchObject({ projectId, rows: expect.any(Number) });
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({ name: 'Archive Wiki' });
    expect(() => importKnowledgeProject(target, archive, importOptions())).toThrow(/already exists/);
    expect(loadKnowledgeSourceVersion(target, { projectId, sourceVersionId: 'source_version_1' }).content).toBe('# SQLite source\n');
    expect(
      readFileSync(join(imported.workspaceRoot, 'conversations', 'conversation_1', 'message_1.json'), 'utf8'),
    ).toContain('Imported question');
    expect(
      readFileSync(join(imported.workspaceRoot, '.ariadne', 'knowledge', 'pages', 'concept', 'sqlite.md'), 'utf8'),
    ).toContain('[[graph|the graph]]');

    const broken = {
      ...archive,
      manifest: {
        ...archive.manifest,
        entries: archive.manifest.entries.map((entry) =>
          entry.path === 'project.json' ? { ...entry, sha256: createHash('sha256').update('broken').digest('hex') } : entry,
        ),
      },
    };
    expect(() => importKnowledgeProject(target, broken, importOptions({ replaceExisting: true }))).toThrow(/checksum/);
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({ name: 'Archive Wiki' });
  });

  it('rejects archives that omit required table files before replacing anything', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const invalidArchive = removeArchiveFile(archive, 'data/knowledge_messages.json');

    const target = database();
    new KnowledgeProjectStore(target).create({
      id: projectId as never,
      workspaceRoot: '/workspace/existing',
      name: 'Existing target',
    });

    expect(() => importKnowledgeProject(target, invalidArchive, importOptions({ replaceExisting: true }))).toThrow(
      /table knowledge_messages is required/i,
    );
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({
      name: 'Existing target',
    });
  });

  it('rejects a knowledge archive with extra project rows before replacing anything', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const projects = tableRows<Record<string, unknown>>(archive, 'knowledge_projects');
    const invalidArchive = rewriteTableRows(archive, 'knowledge_projects', [
      ...projects,
      {
        ...projects[0],
        id: 'project_extra',
        workspace_root: '/workspace/extra',
        name: 'Extra',
      },
    ]);

    const target = database();
    new KnowledgeProjectStore(target).create({
      id: projectId as never,
      workspaceRoot: '/workspace/existing',
      name: 'Existing target',
    });
    const unrelatedProject = new KnowledgeProjectStore(target).create({
      id: 'project_other' as never,
      workspaceRoot: '/workspace/other',
      name: 'Other project',
    });

    expect(() => importKnowledgeProject(target, invalidArchive, importOptions({ replaceExisting: true }))).toThrow(/exactly one project row/i);
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({ name: 'Existing target' });
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(unrelatedProject.id)).toEqual({
      name: 'Other project',
    });
  });

  it('rejects a project table row whose id does not match manifest.projectId', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const projects = tableRows<Record<string, unknown>>(archive, 'knowledge_projects');
    const invalidArchive = rewriteTableRows(archive, 'knowledge_projects', [
      {
        ...projects[0],
        id: 'project_other',
      },
    ]);

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/matches manifest\.projectId/i);
  });

  it.each(['knowledge_project_roots', 'knowledge_pages', 'knowledge_job_events'])(
    'rejects direct project ownership mismatches in %s',
    (table) => {
      const source = database();
      const { projectId } = seed(source);
      const archive = exportKnowledgeProject(source, { projectId });
      const rows = tableRows<Record<string, unknown>>(archive, table);
      const invalidArchive = rewriteTableRows(archive, table, rows.map((row, index) => (index === 0 ? { ...row, project_id: 'project_other' } : row)));

      expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/project ownership mismatch/i);
    },
  );

  it.each([
    ['knowledge_page_versions', 'page_id', 'page_missing'],
    ['knowledge_review_actions', 'review_id', 'review_missing'],
    ['knowledge_graph_edges', 'source_node_id', 'graph_node_missing'],
  ])('rejects dangling archive references in %s.%s', (table, column, value) => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const rows = tableRows<Record<string, unknown>>(archive, table);
    const invalidArchive = rewriteTableRows(
      archive,
      table,
      rows.map((row, index) => (index === 0 ? { ...row, [column]: value } : row)),
    );

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/reference/i);
  });

  it('rejects indirect cross-project provenance and graph evidence references', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const provenanceRows = tableRows<Record<string, unknown>>(archive, 'knowledge_page_provenance').map((row, index) =>
      index === 0 ? { ...row, source_id: 'source_missing' } : row,
    );
    const archiveWithInvalidProvenance = rewriteTableRows(archive, 'knowledge_page_provenance', provenanceRows);
    expect(() => importKnowledgeProject(database(), archiveWithInvalidProvenance, importOptions())).toThrow(/provenance/i);

    const edgeRows = tableRows<Record<string, unknown>>(archive, 'knowledge_graph_edges').map((row, index) =>
      index === 0
        ? {
            ...row,
            evidence_json: JSON.stringify({
              evidence: ['explicit_link'],
              weight: 1,
              provenance: [{ kind: 'source', id: 'source_missing', sourceVersionId: 'source_version_1', confidence: 1 }],
            }),
          }
        : row,
    );
    const archiveWithInvalidEdgeProvenance = rewriteTableRows(archive, 'knowledge_graph_edges', edgeRows);
    expect(() => importKnowledgeProject(database(), archiveWithInvalidEdgeProvenance, importOptions())).toThrow(/graph edge provenance/i);
  });

  it.each([
    ['knowledge_projects', { "id) VALUES ('pwned'); --": 'bad' }],
    ['knowledge_projects', Object.fromEntries([['__proto__', 'bad']])],
  ])('rejects malicious archive column keys in %s', (table, maliciousColumns) => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const rows = tableRows<Record<string, unknown>>(archive, table);
    const invalidArchive = rewriteTableRows(archive, table, [{ ...rows[0], ...maliciousColumns }]);

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/unknown column/i);
  });

  it('rejects unknown and missing columns with a stable archive validation error', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const pageRows = tableRows<Record<string, unknown>>(archive, 'knowledge_pages');
    const archiveWithUnknownColumn = rewriteTableRows(archive, 'knowledge_pages', [
      { ...pageRows[0], unknown_column: 'bad' },
    ]);
    expect(() => importKnowledgeProject(database(), archiveWithUnknownColumn, importOptions())).toThrow(/unknown column/i);

    const { updated_at: _updatedAt, ...missingColumnRow } = pageRows[0] as Record<string, unknown>;
    const archiveWithMissingColumn = rewriteTableRows(archive, 'knowledge_pages', [missingColumnRow]);
    expect(() => importKnowledgeProject(database(), archiveWithMissingColumn, importOptions())).toThrow(/missing required column/i);
  });

  it('rejects incorrect column types before insertion', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const pageVersionRows = tableRows<Record<string, unknown>>(archive, 'knowledge_page_versions');
    const invalidArchive = rewriteTableRows(archive, 'knowledge_page_versions', [
      {
        ...pageVersionRows[0],
        version_number: 'one',
      },
    ]);

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/version_number must be a finite integer/i);
  });

  it.each([
    ['knowledge_messages', 'content_path', '../escape.json'],
    ['knowledge_source_versions', 'content_path', '../outside-source.txt'],
  ])('rejects unsafe imported path values in %s.%s', (table, column, value) => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const rows = tableRows<Record<string, unknown>>(archive, table);
    const invalidArchive = rewriteTableRows(
      archive,
      table,
      rows.map((row, index) => (index === 0 ? { ...row, [column]: value } : row)),
    );

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/must stay within|Knowledge path must stay within the workspace/i);
  });

  it('rejects imported page versions that do not use the canonical page content path', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const rows = tableRows<Record<string, unknown>>(archive, 'knowledge_page_versions');
    const invalidArchive = rewriteTableRows(archive, 'knowledge_page_versions', [
      {
        ...rows[0],
        content_path: 'pages/concept/other.md',
      },
    ]);

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/content_path must match pages\/concept\/sqlite\.md/i);
  });

  it('rejects cross-conversation or destructive chat payload bindings in imported archives', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const messageRows = tableRows<Record<string, unknown>>(archive, 'knowledge_messages');
    const invalidContentPathArchive = rewriteTableRows(archive, 'knowledge_messages', [
      {
        ...messageRows[0],
        content_path: 'conversations/other_conversation/message_1.json',
      },
    ]);
    expect(() => importKnowledgeProject(database(), invalidContentPathArchive, importOptions())).toThrow(/content_path must match/i);

    const conversationRows = tableRows<Record<string, unknown>>(archive, 'knowledge_conversations');
    const invalidConversationArchive = rewriteTableRows(archive, 'knowledge_conversations', [
      {
        ...conversationRows[0],
        id: '.',
      },
    ]);
    expect(() => importKnowledgeProject(database(), invalidConversationArchive, importOptions())).toThrow(/safe single path segment/i);
  });

  it('rejects imported chat payload files with invalid JSON content', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const invalidArchive = rewriteArchiveFile(
      archive,
      'conversations/conversation_1/message_1.json',
      '{"content":',
    );

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(/must contain valid JSON/i);
  });

  it('rejects imported chat payload files with invalid citation or retrieval mode shapes', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const invalidArchive = rewriteArchiveFile(
      archive,
      'conversations/conversation_1/message_1.json',
      JSON.stringify({ content: 'Imported question', citations: ['bad'], retrievalMode: 'unsupported' }),
    );

    expect(() => importKnowledgeProject(database(), invalidArchive, importOptions())).toThrow(
      /citation 1 must be a plain object|supported search mode/i,
    );
  });

  it('rejects imported conversation payload paths when conversations/ traverses a symlink', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });

    const target = database();
    const workspaceRoot = createWorkspaceRoot('.knowledge-archive-import-');
    const outsideRoot = createWorkspaceRoot('.knowledge-archive-outside-');
    mkdirSync(outsideRoot, { recursive: true });
    symlinkSync(outsideRoot, join(workspaceRoot, 'conversations'));

    expect(() => importKnowledgeProject(target, archive, importOptions({ workspaceRoot }))).toThrow(/symbolic links/i);
  });

  it('rejects archive staging when .ariadne/knowledge traverses a symlink', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });

    const target = database();
    const workspaceRoot = createWorkspaceRoot('.knowledge-archive-import-');
    const outsideRoot = createWorkspaceRoot('.knowledge-archive-knowledge-root-');
    mkdirSync(join(workspaceRoot, '.ariadne'), { recursive: true });
    symlinkSync(outsideRoot, join(workspaceRoot, '.ariadne', 'knowledge'));

    expect(() => importKnowledgeProject(target, archive, importOptions({ workspaceRoot }))).toThrow(/symbolic links/i);
  });

  it('rejects archive import when the workspace root itself is a symlink', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });

    const target = database();
    const actualRoot = createWorkspaceRoot('.knowledge-archive-import-target-');
    const symlinkRoot = join(createWorkspaceRoot('.knowledge-archive-import-link-parent-'), 'workspace-link');
    symlinkSync(actualRoot, symlinkRoot);

    expect(() => importKnowledgeProject(target, archive, importOptions({ workspaceRoot: symlinkRoot }))).toThrow(/symbolic links/i);
  });

  it('replaces only the target project on a valid import', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });

    const target = database();
    const imported = importOptions({ replaceExisting: true });
    new KnowledgeProjectStore(target).create({
      id: projectId as never,
      workspaceRoot: imported.workspaceRoot,
      name: 'Old import target',
    });

    const untouchedProject = new KnowledgeProjectStore(target).create({
      id: 'project_unrelated' as never,
      workspaceRoot: '/workspace/unrelated',
      name: 'Unrelated project',
    });

    const result = importKnowledgeProject(target, archive, imported);
    expect(result).toMatchObject({ projectId, rows: expect.any(Number) });
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({ name: 'Archive Wiki' });
    expect(target.prepare('SELECT workspace_root FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({
      workspace_root: imported.workspaceRoot,
    });
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(untouchedProject.id)).toEqual({
      name: 'Unrelated project',
    });
  });

  it('preserves the legacy import call shape when replacing an existing project', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });
    const target = database();
    const workspaceRoot = importOptions().workspaceRoot;
    new KnowledgeProjectStore(target).create({
      id: projectId as never,
      workspaceRoot,
      name: 'Old import target',
    });

    expect(importKnowledgeProject(target, archive, { replaceExisting: true })).toMatchObject({ projectId });
    expect(target.prepare('SELECT workspace_root FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({
      workspace_root: workspaceRoot,
    });
  });

  it('rejects replacing a project rooted in a different workspace', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });

    const target = database();
    new KnowledgeProjectStore(target).create({
      id: projectId as never,
      workspaceRoot: createWorkspaceRoot('.knowledge-archive-old-root-'),
      name: 'Old import target',
    });

    const imported = importOptions({ replaceExisting: true });
    expect(() => importKnowledgeProject(target, archive, imported)).toThrow(/different workspace root/i);
    expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({
      name: 'Old import target',
    });
  });

  it('rejects imports that would overwrite knowledge artifacts used by another project in the same workspace', () => {
    const source = database();
    const { projectId } = seed(source);
    const archive = exportKnowledgeProject(source, { projectId });

    const target = database();
    const imported = importOptions();
    const otherProject = new KnowledgeProjectStore(target).create({
      id: 'project_other' as never,
      workspaceRoot: imported.workspaceRoot,
      name: 'Other project',
    });
    new KnowledgePageStore(target).createPageVersion({
      projectId: otherProject.id,
      type: 'concept',
      title: 'Other SQLite',
      slug: 'sqlite',
      content: 'Other page',
      contentPath: 'pages/concept/sqlite.md',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    expect(() => importKnowledgeProject(target, archive, imported)).toThrow(/another project in this workspace/i);
  });
});
