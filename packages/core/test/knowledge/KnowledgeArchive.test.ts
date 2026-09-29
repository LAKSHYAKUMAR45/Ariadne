import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import {
  KNOWLEDGE_ARCHIVE_PRESERVED_TABLE_COLUMNS,
  KNOWLEDGE_ARCHIVE_TABLES,
  KNOWLEDGE_ARCHIVE_TABLE_REGISTRY,
  exportKnowledgeProject,
  importKnowledgeProject,
  type KnowledgeArchiveCompatibilityBlock,
} from '../../src/knowledge/KnowledgeArchive.js';
import { KNOWLEDGE_SCHEMA_VERSION } from '../../src/knowledge/knowledgeSchema.js';
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

  it('exports and imports task-history sources without requiring a local artifact', () => {
    const source = database();
    const { projectId } = seed(source);
    source.prepare(
      `INSERT INTO knowledge_sources
       (id, project_id, source_kind, source_path, source_url, title, current_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'source_task_history',
      projectId,
      'task_history',
      'ariadne://task/task-1',
      null,
      'Task history',
      'external-hash',
      'active',
      '2026-01-01',
      '2026-01-01',
    );
    source.prepare(
      `INSERT INTO knowledge_source_versions
       (id, project_id, source_id, version_number, content_hash, content_path, byte_length, mime_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'source_version_task_history',
      projectId,
      'source_task_history',
      1,
      'external-hash',
      'tasks/task-1.md',
      12,
      'text/markdown',
      '2026-01-01',
    );

    const archive = exportKnowledgeProject(source, { projectId });
    expect(archive.files['tasks/task-1.md']).toBeUndefined();

    const taskHistoryRows = tableRows<Record<string, unknown>>(archive, 'knowledge_sources');
    const invalidTaskHistoryArchive = rewriteTableRows(archive, 'knowledge_sources', [
      ...taskHistoryRows.filter((row) => row.id !== 'source_task_history'),
      { ...taskHistoryRows.find((row) => row.id === 'source_task_history'), source_path: null },
    ]);
    expect(() => importKnowledgeProject(database(), invalidTaskHistoryArchive, importOptions())).toThrow(/canonical task URI/i);

    const target = database();
    const imported = importKnowledgeProject(target, archive, importOptions());
    expect(imported.projectId).toBe(projectId);
    expect(target.prepare('SELECT source_kind FROM knowledge_sources WHERE id = ?').get('source_task_history')).toEqual({
      source_kind: 'task_history',
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

  describe('archive v2 compatibility contracts', () => {
    const REGISTRY_CLASSES = {
      knowledge_settings: 'required',
      knowledge_search_indexes: 'derived-rebuild',
      knowledge_search_index_fields: 'derived-rebuild',
      knowledge_search_semantic_models: 'derived-rebuild',
      knowledge_search_semantic_vectors: 'derived-rebuild',
      knowledge_search_semantic_neighbors: 'derived-rebuild',
      knowledge_source_freshness: 'host-local',
      knowledge_project_watchers: 'host-local',
      knowledge_search_regression_runs: 'host-local',
      knowledge_analysis_coverage: 'required',
      knowledge_deferred_relationships: 'required',
      knowledge_graph_reports: 'optional',
      knowledge_graph_ambiguities: 'optional',
      knowledge_semantic_summaries: 'optional',
      knowledge_search_feedback: 'privacy-omitted',
      knowledge_query_analytics_daily: 'privacy-omitted',
      knowledge_provider_profiles: 'privacy-omitted',
    } as const;

    function sha256(content: string): string {
      return createHash('sha256').update(content, 'utf8').digest('hex');
    }

    function insertSetting(db: ReturnType<typeof openDatabase>, projectId: string, key: string, value: string) {
      db.prepare(
        `INSERT INTO knowledge_settings (id, project_id, setting_key, setting_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`setting_${key}`, projectId, key, value, '2026-01-01', '2026-01-01');
    }

    function settingKeys(db: ReturnType<typeof openDatabase>, projectId: string): string[] {
      return (
        db
          .prepare('SELECT setting_key FROM knowledge_settings WHERE project_id = ? ORDER BY setting_key')
          .all(projectId) as Array<{ setting_key: string }>
      ).map((row) => row.setting_key);
    }

    type Archive = ReturnType<typeof exportKnowledgeProject>;

    function compatibilityOf(archive: Archive): KnowledgeArchiveCompatibilityBlock {
      return archive.manifest.compatibility as KnowledgeArchiveCompatibilityBlock;
    }

    function withManifest(archive: Archive, patch: Record<string, unknown>): Archive {
      return { ...archive, manifest: { ...archive.manifest, ...patch } as Archive['manifest'] };
    }

    function withCompatibility(archive: Archive, patch: Record<string, unknown>): Archive {
      return withManifest(archive, { compatibility: { ...compatibilityOf(archive), ...patch } });
    }

    function rewriteV2TableRows(archive: Archive, table: string, rows: Record<string, unknown>[]): Archive {
      const rewritten = rewriteTableRows(archive, table, rows);
      const content = String(rewritten.files[`data/${table}.json`]);
      return withCompatibility(rewritten, {
        tableFingerprints: compatibilityOf(rewritten).tableFingerprints.map((fingerprint) =>
          fingerprint.table === table ? { ...fingerprint, sha256: sha256(content), rowCount: rows.length } : fingerprint,
        ),
      });
    }

    function addArchiveFile(archive: Archive, filePath: string, content: string): Archive {
      return {
        manifest: {
          ...archive.manifest,
          entries: [
            ...archive.manifest.entries,
            { path: filePath, size: Buffer.byteLength(content, 'utf8'), sha256: sha256(content), mediaType: 'application/json' },
          ].sort((left, right) => left.path.localeCompare(right.path)),
        },
        files: { ...archive.files, [filePath]: content },
      };
    }

    function exportV2(db: ReturnType<typeof openDatabase>, projectId: string, extra: Record<string, unknown> = {}): Archive {
      return exportKnowledgeProject(db, { projectId, generatedAt: '2026-01-02', manifestVersion: 2, ...extra });
    }

    function seedWithV2Payload(db: ReturnType<typeof openDatabase>) {
      const seeded = seed(db);
      writeWorkspaceFile(
        seeded.workspaceRoot,
        'conversations/conversation_1/message_1.json',
        JSON.stringify({ schemaVersion: 2, content: 'Imported question', citations: [], retrievalMode: 'knowledge' }),
      );
      return seeded;
    }

    it('classifies every knowledge table and keeps exported tables in the required or optional classes', () => {
      const db = database();
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge\\_%' ESCAPE '\\'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(tables.length).toBeGreaterThan(20);
      for (const table of tables) {
        expect(KNOWLEDGE_ARCHIVE_TABLE_REGISTRY[table], `${table} must have an archive class`).toBeDefined();
      }
      for (const table of KNOWLEDGE_ARCHIVE_TABLES) {
        expect(['required', 'optional']).toContain(KNOWLEDGE_ARCHIVE_TABLE_REGISTRY[table]?.class);
      }
      for (const [table, registration] of Object.entries(KNOWLEDGE_ARCHIVE_TABLE_REGISTRY)) {
        if (tables.includes(table) && ['required', 'optional'].includes(registration.class)) {
          expect(KNOWLEDGE_ARCHIVE_TABLES as readonly string[]).toContain(table);
        }
      }
      for (const [table, archiveClass] of Object.entries(REGISTRY_CLASSES)) {
        expect(KNOWLEDGE_ARCHIVE_TABLE_REGISTRY[table]?.class).toBe(archiveClass);
      }
    });

    it('keeps version 1 by default when the project has no v2-only data', () => {
      const db = database();
      const { projectId } = seed(db);
      const archive = exportKnowledgeProject(db, { projectId });
      expect(archive.manifest.archiveVersion).toBe(1);
      expect(archive.manifest.compatibility).toBeUndefined();
      expect(archive.files['data/knowledge_provider_profiles.json']).toBeDefined();
    });

    it('exports a version 2 manifest with classification-driven omissions and table fingerprints', () => {
      const db = database();
      const { projectId } = seed(db);
      const archive = exportV2(db, projectId);
      const compatibility = compatibilityOf(archive);

      expect(archive.manifest.archiveVersion).toBe(2);
      expect(compatibility.minimumReaderArchiveVersion).toBe(2);
      expect(compatibility.requiredFeatures).toEqual([]);
      expect(compatibility.optionalFeatures).toEqual([]);
      expect(compatibility.producedBy.knowledgeSchemaVersion).toBe(KNOWLEDGE_SCHEMA_VERSION);
      expect(compatibility.omissions).toEqual(
        expect.arrayContaining([
          { table: 'knowledge_search_indexes', reason: 'derived_rebuild' },
          { table: 'knowledge_search_semantic_vectors', reason: 'derived_rebuild' },
          { table: 'knowledge_source_freshness', reason: 'host_local_only' },
          { table: 'knowledge_project_watchers', reason: 'host_local_only' },
          { table: 'knowledge_query_analytics_daily', reason: 'privacy_omitted' },
          { table: 'knowledge_provider_profiles', reason: 'secret_omitted' },
          { table: 'knowledge_settings', reason: 'host_local_only', rowFilter: { column: 'setting_key', prefix: 'host.' } },
        ]),
      );
      expect(archive.files['data/knowledge_provider_profiles.json']).toBeUndefined();
      expect(compatibility.tableFingerprints.map((fingerprint) => fingerprint.table)).toEqual([...KNOWLEDGE_ARCHIVE_TABLES]);
      for (const fingerprint of compatibility.tableFingerprints) {
        const content = String(archive.files[`data/${fingerprint.table}.json`]);
        expect(fingerprint.sha256).toBe(sha256(content));
        expect(fingerprint.rowCount).toBe((JSON.parse(content) as unknown[]).length);
      }
    });

    it('round-trips both manifest versions and reports derived rebuilds', () => {
      const source = database();
      const { projectId } = seed(source);
      for (const manifestVersion of [1, 2] as const) {
        const archive = exportKnowledgeProject(source, { projectId, manifestVersion });
        const target = database();
        const result = importKnowledgeProject(target, archive, importOptions());
        expect(result.postImport).toEqual({ rebuildRequired: ['search_index', 'semantic_model'] });
        expect(result.warnings.map((warning) => warning.code)).toEqual(
          expect.arrayContaining(['derived_data_rebuild_required', 'authenticity_absent']),
        );
        expect(result.authenticity).toEqual({ state: 'absent' });
        expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({ name: 'Archive Wiki' });
      }
    });

    it('never exports host.* settings and keeps portable settings', () => {
      const db = database();
      const { projectId } = seed(db);
      insertSetting(db, projectId, 'host.worker.concurrency', '4');
      insertSetting(db, projectId, 'host.provider.synthesis_profile', 'private-profile-name');
      insertSetting(db, projectId, 'portable.theme', 'dark');

      for (const manifestVersion of [1, 2] as const) {
        const archive = exportKnowledgeProject(db, { projectId, manifestVersion });
        expect(tableRows<{ setting_key: string }>(archive, 'knowledge_settings').map((row) => row.setting_key)).toEqual([
          'portable.theme',
        ]);
        expect(Object.values(archive.files).map(String).join('\n')).not.toMatch(/host\.|private-profile-name/);
      }
      const v2 = exportV2(db, projectId);
      const settingsFingerprint = compatibilityOf(v2).tableFingerprints.find((entry) => entry.table === 'knowledge_settings');
      expect(settingsFingerprint).toEqual({
        table: 'knowledge_settings',
        sha256: sha256(String(v2.files['data/knowledge_settings.json'])),
        rowCount: 1,
      });
    });

    it.each([1, 2] as const)('rejects a host.* settings row in a version %i archive without echoing it', (manifestVersion) => {
      const db = database();
      const { projectId } = seed(db);
      const archive = exportKnowledgeProject(db, { projectId, manifestVersion });
      const hostRow = {
        id: 'setting_leak',
        project_id: projectId,
        setting_key: 'host.analytics.salt',
        setting_value: 'super-secret-salt',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      };
      const tampered =
        manifestVersion === 1
          ? rewriteTableRows(archive, 'knowledge_settings', [hostRow])
          : rewriteV2TableRows(archive, 'knowledge_settings', [hostRow]);
      const target = database();
      let message = '';
      try {
        importKnowledgeProject(target, tampered, importOptions());
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/host-local setting/i);
      expect(message).not.toMatch(/host\.analytics|super-secret-salt/);
      expect(target.prepare('SELECT COUNT(*) AS count FROM knowledge_projects').get()).toEqual({ count: 0 });
    });

    it.each([
      ['knowledge_source_freshness', /host-local/i],
      ['knowledge_search_indexes', /derived/i],
      ['knowledge_query_analytics_daily', /privacy/i],
      ['knowledge_unclassified_table', /no archive classification/i],
    ])('rejects archives that contain a data file for %s', (table, pattern) => {
      const db = database();
      const { projectId } = seed(db);
      for (const archive of [exportKnowledgeProject(db, { projectId }), exportV2(db, projectId)]) {
        const tampered = addArchiveFile(archive, `data/${table}.json`, '[]\n');
        expect(() => importKnowledgeProject(database(), tampered, importOptions())).toThrow(pattern);
      }
    });

    it('keeps an explicit column allowlist for every preserved table', () => {
      const preserved = Object.entries(KNOWLEDGE_ARCHIVE_TABLE_REGISTRY)
        .filter(([table, registration]) => registration.class === 'privacy-omitted' || table === 'knowledge_settings')
        .map(([table]) => table)
        .sort();
      expect(Object.keys(KNOWLEDGE_ARCHIVE_PRESERVED_TABLE_COLUMNS).sort()).toEqual(preserved);
      for (const [table, columns] of Object.entries(KNOWLEDGE_ARCHIVE_PRESERVED_TABLE_COLUMNS)) {
        expect(table).toMatch(/^knowledge_[a-z_]+$/);
        expect(columns).toContain('id');
        expect(columns).toContain('project_id');
        expect(new Set(columns).size).toBe(columns.length);
        for (const column of columns) expect(column).toMatch(/^[a-z_]+$/);
      }
    });

    it('imports a version 2 archive with a fingerprinted unsupported optional table and warns', () => {
      const db = database();
      const { projectId } = seed(db);
      const content = '[{"id":"report_1"}]\n';
      const base = exportV2(db, projectId);
      const archive = withCompatibility(addArchiveFile(base, 'data/knowledge_graph_reports.json', content), {
        tableFingerprints: [
          ...compatibilityOf(base).tableFingerprints,
          { table: 'knowledge_graph_reports', sha256: sha256(content), rowCount: 1 },
        ],
      });
      const target = database();
      const result = importKnowledgeProject(target, archive, importOptions());
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'optional_table_unsupported' }));
      expect(target.prepare('SELECT COUNT(*) AS count FROM knowledge_pages WHERE project_id = ?').get(projectId)).not.toEqual({ count: 0 });
    });

    it('still verifies the fingerprint of an ignored optional table and of imported tables', () => {
      const db = database();
      const { projectId } = seed(db);
      const content = '[{"id":"report_1"}]\n';
      const base = exportV2(db, projectId);
      const withFile = addArchiveFile(base, 'data/knowledge_graph_reports.json', content);
      const tampered = withCompatibility(withFile, {
        tableFingerprints: [
          ...compatibilityOf(base).tableFingerprints,
          { table: 'knowledge_graph_reports', sha256: sha256('[]\n'), rowCount: 1 },
        ],
      });
      expect(() => importKnowledgeProject(database(), tampered, importOptions())).toThrow(/fingerprint mismatch/i);
      const dropped = withCompatibility(base, {
        tableFingerprints: compatibilityOf(base).tableFingerprints.filter((fingerprint) => fingerprint.table !== 'knowledge_pages'),
      });
      expect(() => importKnowledgeProject(database(), dropped, importOptions())).toThrow(/fingerprint/i);
    });

    it('rejects a version 2 archive that still contains an omitted provider profile table', () => {
      const db = database();
      const { projectId } = seed(db);
      const tampered = addArchiveFile(exportV2(db, projectId), 'data/knowledge_provider_profiles.json', '[]\n');
      expect(() => importKnowledgeProject(database(), tampered, importOptions())).toThrow(/secret_omitted|omitted/i);
    });

    it('does not leak provider endpoints, models, key variables, or profile names in any export', () => {
      const db = database();
      const { projectId } = seed(db);
      db.prepare('UPDATE knowledge_provider_profiles SET configuration_json = ? WHERE project_id = ?').run(
        JSON.stringify({ endpoint: 'https://provider.example/v1', model: 'gpt-secret-model', apiKeyEnv: 'PROVIDER_SECRET_ENV' }),
        projectId,
      );
      insertSetting(db, projectId, 'host.provider.summary_profile', 'default');
      for (const manifestVersion of [1, 2] as const) {
        const archive = exportKnowledgeProject(db, { projectId, manifestVersion });
        const serialized = `${JSON.stringify(archive.manifest)}\n${Object.values(archive.files).map(String).join('\n')}`;
        expect(serialized).not.toMatch(/provider\.example|gpt-secret-model|PROVIDER_SECRET_ENV|host\.provider/);
      }
    });

    it('selects version 2 automatically for a V2 chat payload and fails closed for an explicit version 1', () => {
      const db = database();
      const { projectId } = seedWithV2Payload(db);
      const auto = exportKnowledgeProject(db, { projectId });
      expect(auto.manifest.archiveVersion).toBe(2);
      expect(compatibilityOf(auto).requiredFeatures).toEqual(['knowledge-chat-payload-v2']);
      expect(() => exportKnowledgeProject(db, { projectId, manifestVersion: 1 })).toThrow(/manifest_version_incompatible/);

      const target = database();
      const imported = importOptions();
      importKnowledgeProject(target, auto, imported);
      expect(readFileSync(join(imported.workspaceRoot, 'conversations', 'conversation_1', 'message_1.json'), 'utf8')).toContain(
        '"schemaVersion":2',
      );
    });

    it('rejects a V2 chat payload in an archive that does not declare the required feature', () => {
      const db = database();
      const { projectId } = seedWithV2Payload(db);
      const archive = exportKnowledgeProject(db, { projectId });
      expect(() => importKnowledgeProject(database(), withCompatibility(archive, { requiredFeatures: [] }), importOptions())).toThrow(
        /knowledge-chat-payload-v2/,
      );
    });

    it('rejects unsupported versions, unknown required features, and readers that are too old', () => {
      const db = database();
      const { projectId } = seed(db);
      const v2 = exportV2(db, projectId);

      expect(() => importKnowledgeProject(database(), withManifest(v2, { archiveVersion: 3 }), importOptions())).toThrow(
        /Unsupported knowledge archive version/,
      );
      expect(() =>
        importKnowledgeProject(database(), v2, importOptions({ compatibilityPolicy: { maxSupportedArchiveVersion: 1 } })),
      ).toThrow(/Unsupported knowledge archive version/);
      expect(() =>
        importKnowledgeProject(database(), withCompatibility(v2, { requiredFeatures: ['knowledge-future-feature-v9'] }), importOptions()),
      ).toThrow(/required feature/i);
      expect(() =>
        importKnowledgeProject(database(), withCompatibility(v2, { requiredFeatures: ['knowledge-analysis-coverage-v1'] }), importOptions()),
      ).toThrow(/required feature/i);
      expect(() =>
        importKnowledgeProject(database(), withCompatibility(v2, { minimumReaderArchiveVersion: 3 }), importOptions()),
      ).toThrow(/newer reader/i);
    });

    it('warns about unknown optional features unless the caller accepts them', () => {
      const db = database();
      const { projectId } = seed(db);
      const archive = withCompatibility(exportV2(db, projectId), { optionalFeatures: ['knowledge-graph-reports-v1'] });

      const warned = importKnowledgeProject(database(), archive, importOptions());
      expect(warned.warnings).toContainEqual(expect.objectContaining({ code: 'optional_feature_ignored' }));
      const accepted = importKnowledgeProject(
        database(),
        archive,
        importOptions({
          compatibilityPolicy: {
            maxSupportedArchiveVersion: 2,
            acceptedOptionalFeatures: new Set(['knowledge-graph-reports-v1']),
          },
        }),
      );
      expect(accepted.warnings.map((warning) => warning.code)).not.toContain('optional_feature_ignored');
    });

    it.each([
      ['a missing compatibility block', (archive: Archive) => withManifest(archive, { compatibility: undefined }), /compatibility/i],
      ['a version 1 manifest carrying a compatibility block', (archive: Archive) => withManifest(archive, { archiveVersion: 1 }), /version 1/i],
      ['a malformed fingerprint', (archive: Archive) => withCompatibility(archive, { tableFingerprints: [{ table: 'knowledge_pages', sha256: 'xyz', rowCount: 1 }] }), /fingerprint/i],
      ['a non-array feature list', (archive: Archive) => withCompatibility(archive, { requiredFeatures: 'none' }), /requiredFeatures/],
      [
        'a fingerprint hash mismatch',
        (archive: Archive) =>
          withCompatibility(archive, {
            tableFingerprints: compatibilityOf(archive).tableFingerprints.map((entry) =>
              entry.table === 'knowledge_pages' ? { ...entry, sha256: '0'.repeat(64) } : entry,
            ),
          }),
        /fingerprint mismatch/i,
      ],
      [
        'a fingerprint row-count mismatch',
        (archive: Archive) =>
          withCompatibility(archive, {
            tableFingerprints: compatibilityOf(archive).tableFingerprints.map((entry) =>
              entry.table === 'knowledge_pages' ? { ...entry, rowCount: 99 } : entry,
            ),
          }),
        /fingerprint mismatch/i,
      ],
      [
        'a missing fingerprint',
        (archive: Archive) =>
          withCompatibility(archive, {
            tableFingerprints: compatibilityOf(archive).tableFingerprints.filter((entry) => entry.table !== 'knowledge_pages'),
          }),
        /fingerprint/i,
      ],
      [
        'an omission that hides a required table',
        (archive: Archive) =>
          withCompatibility(archive, {
            omissions: [...compatibilityOf(archive).omissions, { table: 'knowledge_pages', reason: 'privacy_omitted' }],
          }),
        /omission/i,
      ],
      [
        'an omission with the wrong reason',
        (archive: Archive) =>
          withCompatibility(archive, {
            omissions: [{ table: 'knowledge_source_freshness', reason: 'derived_rebuild' }],
          }),
        /omission/i,
      ],
      [
        'an omission for an unclassified table',
        (archive: Archive) =>
          withCompatibility(archive, { omissions: [{ table: 'knowledge_mystery', reason: 'privacy_omitted' }] }),
        /omission/i,
      ],
      [
        'a settings omission with a different row filter',
        (archive: Archive) =>
          withCompatibility(archive, {
            omissions: [
              { table: 'knowledge_settings', reason: 'host_local_only', rowFilter: { column: 'setting_key', prefix: 'other.' } },
            ],
          }),
        /omission/i,
      ],
    ])('rejects %s', (_label, mutate, pattern) => {
      const db = database();
      const { projectId } = seed(db);
      const target = database();
      expect(() => importKnowledgeProject(target, mutate(exportV2(db, projectId)), importOptions())).toThrow(pattern);
      expect(target.prepare('SELECT COUNT(*) AS count FROM knowledge_projects').get()).toEqual({ count: 0 });
    });

    describe('authenticity', () => {
      function signer() {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        return {
          signer: {
            keyId: 'test-key',
            signerHint: 'unit-test',
            signManifestSha256: (digest: string) => sign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64'),
          },
          verifier: {
            verify: (input: { signatureBase64: string }, digest: string) =>
              verify(null, Buffer.from(digest, 'utf8'), publicKey, Buffer.from(input.signatureBase64, 'base64'))
                ? ('verified' as const)
                : ('invalid' as const),
          },
        };
      }

      it('signs a version 2 archive and verifies it locally', () => {
        const db = database();
        const { projectId } = seed(db);
        const { signer: authenticitySigner, verifier } = signer();
        const archive = exportKnowledgeProject(db, { projectId, generatedAt: '2026-01-02', authenticitySigner });
        expect(archive.manifest.archiveVersion).toBe(2);
        expect(archive.manifest.authenticity).toMatchObject({ algorithm: 'ed25519-detached', keyId: 'test-key', signerHint: 'unit-test' });

        const verified = importKnowledgeProject(database(), archive, importOptions({ authenticityVerifier: verifier }));
        expect(verified.authenticity).toEqual({ state: 'verified', keyId: 'test-key' });

        const unverified = importKnowledgeProject(database(), archive, importOptions());
        expect(unverified.authenticity).toEqual({ state: 'unverified', keyId: 'test-key' });
        expect(unverified.warnings.map((warning) => warning.code)).toContain('authenticity_unverified');
      });

      it('rejects explicit version 1 exports that request signing', () => {
        const db = database();
        const { projectId } = seed(db);
        expect(() =>
          exportKnowledgeProject(db, { projectId, manifestVersion: 1, authenticitySigner: signer().signer }),
        ).toThrow(/manifest_version_incompatible/);
      });

      it('rejects malformed authenticity metadata and signer output', () => {
        const db = database();
        const { projectId } = seed(db);
        const { signer: authenticitySigner } = signer();
        const signed = exportKnowledgeProject(db, { projectId, authenticitySigner });
        const authenticity = signed.manifest.authenticity as unknown as Record<string, unknown>;
        for (const patch of [
          { algorithm: 'rsa' },
          { keyId: '' },
          { signedManifestSha256: 'nothex' },
          { signatureBase64: '***' },
          { signedAt: 42 },
        ]) {
          expect(() =>
            importKnowledgeProject(database(), withManifest(signed, { authenticity: { ...authenticity, ...patch } }), importOptions()),
          ).toThrow(/authenticity/i);
        }
        expect(() =>
          importKnowledgeProject(database(), withManifest(signed, { authenticity: 'signed' }), importOptions()),
        ).toThrow(/authenticity/i);
        expect(() =>
          exportKnowledgeProject(db, { projectId, authenticitySigner: { ...authenticitySigner, signManifestSha256: () => '***' } }),
        ).toThrow(/signature/i);
      });

      it('rejects invalid signatures and manifests changed after signing', () => {
        const db = database();
        const { projectId } = seed(db);
        const { signer: authenticitySigner, verifier } = signer();
        const signed = exportKnowledgeProject(db, { projectId, generatedAt: '2026-01-02', authenticitySigner });

        const other = signer();
        expect(() =>
          importKnowledgeProject(database(), signed, importOptions({ authenticityVerifier: other.verifier })),
        ).toThrow(/authenticity verification failed/i);
        expect(() =>
          importKnowledgeProject(database(), withManifest(signed, { generatedAt: '2030-01-01' }), importOptions({ authenticityVerifier: verifier })),
        ).toThrow(/authenticity/i);
        expect(() =>
          importKnowledgeProject(database(), withManifest(signed, { generatedAt: '2030-01-01' }), importOptions()),
        ).toThrow(/authenticity/i);
      });
    });

    describe('replaceExisting', () => {
      function createHostTables(db: ReturnType<typeof openDatabase>) {
        for (const table of ['knowledge_search_indexes', 'knowledge_source_freshness']) {
          db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL)`);
        }
        db.exec(
          `CREATE TABLE knowledge_query_analytics_daily (
             id TEXT PRIMARY KEY,
             project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
             day TEXT NOT NULL,
             search_mode TEXT NOT NULL,
             total_queries INTEGER NOT NULL,
             zero_result_queries INTEGER NOT NULL,
             ambiguous_top_results INTEGER NOT NULL,
             citationless_top_results INTEGER NOT NULL,
             accepted_result_count INTEGER NOT NULL,
             rejected_result_count INTEGER NOT NULL,
             total_result_count INTEGER NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
           )`,
        );
        db.exec(
          `CREATE TABLE knowledge_search_feedback (
             id TEXT PRIMARY KEY,
             project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
             query_fingerprint TEXT NOT NULL,
             search_mode TEXT NOT NULL,
             result_kind TEXT NOT NULL,
             result_ref TEXT NOT NULL,
             feedback_kind TEXT NOT NULL,
             rank_position INTEGER NOT NULL,
             ambiguity_state TEXT,
             citation_present INTEGER NOT NULL,
             feedback_count INTEGER NOT NULL DEFAULT 1,
             first_day TEXT NOT NULL,
             last_day TEXT NOT NULL
           )`,
        );
      }

      it('preserves host.* settings, replaces portable settings, and clears derived and freshness rows', () => {
        const source = database();
        const { projectId } = seed(source);
        insertSetting(source, projectId, 'portable.theme', 'from-archive');
        const archive = exportKnowledgeProject(source, { projectId });

        const target = database();
        const imported = importOptions({ replaceExisting: true });
        new KnowledgeProjectStore(target).create({ id: projectId as never, workspaceRoot: imported.workspaceRoot, name: 'Old target' });
        insertSetting(target, projectId, 'host.worker.concurrency', '3');
        insertSetting(target, projectId, 'portable.theme', 'stale-local');
        insertSetting(target, projectId, 'portable.local_only', 'stale-local');
        createHostTables(target);
        target.prepare('INSERT INTO knowledge_search_indexes VALUES (?, ?, ?)').run('idx_1', projectId, 'derived');
        target.prepare('INSERT INTO knowledge_source_freshness VALUES (?, ?, ?)').run('fresh_1', projectId, 'host');
        target.prepare('INSERT INTO knowledge_source_freshness VALUES (?, ?, ?)').run('fresh_other', 'project_unrelated', 'host');
        target
          .prepare('INSERT INTO knowledge_query_analytics_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('analytics_1', projectId, '2026-01-01', 'lexical', 5, 1, 0, 2, 3, 1, 9, '2026-01-01', '2026-01-02');
        target
          .prepare('INSERT INTO knowledge_search_feedback VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('feedback_1', projectId, 'fp_1', 'lexical', 'page', 'ref_1', 'accepted', 2, null, 1, 4, '2026-01-01', '2026-01-02');

        importKnowledgeProject(target, archive, imported);

        expect(settingKeys(target, projectId)).toEqual(['host.worker.concurrency', 'portable.theme']);
        expect(
          target.prepare("SELECT setting_value FROM knowledge_settings WHERE setting_key = 'host.worker.concurrency'").get(),
        ).toEqual({ setting_value: '3' });
        expect(target.prepare("SELECT setting_value FROM knowledge_settings WHERE setting_key = 'portable.theme'").get()).toEqual({
          setting_value: 'from-archive',
        });
        expect(target.prepare('SELECT COUNT(*) AS count FROM knowledge_search_indexes WHERE project_id = ?').get(projectId)).toEqual({
          count: 0,
        });
        expect(target.prepare('SELECT id FROM knowledge_source_freshness').all()).toEqual([{ id: 'fresh_other' }]);
        expect(target.prepare('SELECT id, day, total_queries, total_result_count FROM knowledge_query_analytics_daily').all()).toEqual([
          { id: 'analytics_1', day: '2026-01-01', total_queries: 5, total_result_count: 9 },
        ]);
        expect(target.prepare('SELECT id, result_ref, feedback_count, ambiguity_state FROM knowledge_search_feedback').all()).toEqual([
          { id: 'feedback_1', result_ref: 'ref_1', feedback_count: 4, ambiguity_state: null },
        ]);
      });

      it('preserves host provider profiles that host.provider.* settings refer to', () => {
        const source = database();
        const { projectId } = seed(source);
        const archive = exportKnowledgeProject(source, { projectId });

        const target = database();
        const imported = importOptions({ replaceExisting: true });
        new KnowledgeProjectStore(target).create({ id: projectId as never, workspaceRoot: imported.workspaceRoot, name: 'Old target' });
        insertSetting(target, projectId, 'host.provider.summary_profile', 'local-profile');
        target
          .prepare(
            `INSERT INTO knowledge_provider_profiles
             (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
             VALUES ('provider_local', ?, 'remote', 'local-profile', '{}', '2026-01-01', '2026-01-01')`,
          )
          .run(projectId);

        importKnowledgeProject(target, archive, imported);
        expect(target.prepare('SELECT profile_name FROM knowledge_provider_profiles WHERE project_id = ?').all(projectId)).toEqual([
          { profile_name: 'local-profile' },
        ]);
        expect(settingKeys(target, projectId)).toContain('host.provider.summary_profile');
      });

      it('keeps preserved host.* settings when the archive reuses their row id', () => {
        const source = database();
        const { projectId } = seed(source);
        insertSetting(source, projectId, 'portable.theme', 'from-archive');
        const archive = exportKnowledgeProject(source, { projectId });

        const target = database();
        const imported = importOptions({ replaceExisting: true });
        new KnowledgeProjectStore(target).create({ id: projectId as never, workspaceRoot: imported.workspaceRoot, name: 'Old target' });
        target
          .prepare(
            `INSERT INTO knowledge_settings (id, project_id, setting_key, setting_value, created_at, updated_at)
             VALUES ('setting_portable.theme', ?, 'host.worker.concurrency', '2', '2026-01-01', '2026-01-01')`,
          )
          .run(projectId);

        importKnowledgeProject(target, archive, imported);
        expect(settingKeys(target, projectId)).toEqual(['host.worker.concurrency', 'portable.theme']);
      });

      it('leaves the previous project, host settings, and derived rows untouched when the replacement is rejected', () => {
        const source = database();
        const { projectId } = seed(source);
        const archive = exportV2(source, projectId);
        const tampered = withCompatibility(archive, { requiredFeatures: ['knowledge-future-feature-v9'] });

        const target = database();
        const imported = importOptions({ replaceExisting: true });
        new KnowledgeProjectStore(target).create({ id: projectId as never, workspaceRoot: imported.workspaceRoot, name: 'Old target' });
        insertSetting(target, projectId, 'host.worker.concurrency', '3');
        createHostTables(target);
        target.prepare('INSERT INTO knowledge_search_indexes VALUES (?, ?, ?)').run('idx_1', projectId, 'derived');

        expect(() => importKnowledgeProject(target, tampered, imported)).toThrow(/required feature/i);
        expect(target.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId)).toEqual({ name: 'Old target' });
        expect(settingKeys(target, projectId)).toEqual(['host.worker.concurrency']);
        expect(target.prepare('SELECT COUNT(*) AS count FROM knowledge_search_indexes').get()).toEqual({ count: 1 });
      });
    });
  });
});
