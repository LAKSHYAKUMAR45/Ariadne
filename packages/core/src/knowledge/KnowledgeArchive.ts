import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { renderKnowledgePage } from './KnowledgeRenderer.js';

export const KNOWLEDGE_ARCHIVE_VERSION = 1 as const;

export interface KnowledgeArchiveEntry {
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
}

export interface KnowledgeArchiveManifest {
  archiveVersion: typeof KNOWLEDGE_ARCHIVE_VERSION;
  format: 'ariadne-knowledge-archive';
  projectId: string;
  generatedAt: string;
  entries: KnowledgeArchiveEntry[];
  omitted: string[];
}

export type KnowledgeArchiveFile = string | Uint8Array;

export interface KnowledgeArchive {
  manifest: KnowledgeArchiveManifest;
  files: Record<string, KnowledgeArchiveFile>;
}

export interface ExportKnowledgeProjectOptions {
  projectId: string;
  generatedAt?: string;
  contentRoot?: string;
  pageContents?: Record<string, string>;
  includeObsidian?: boolean;
}

export interface ImportKnowledgeProjectOptions {
  replaceExisting?: boolean;
}

export interface ImportResult {
  projectId: string;
  tables: number;
  rows: number;
  files: string[];
}

const TABLES = [
  'knowledge_projects',
  'knowledge_project_roots',
  'knowledge_settings',
  'knowledge_schema_versions',
  'knowledge_sources',
  'knowledge_source_versions',
  'knowledge_source_assets',
  'knowledge_source_spans',
  'knowledge_extractions',
  'knowledge_pages',
  'knowledge_page_versions',
  'knowledge_page_sources',
  'knowledge_page_provenance',
  'knowledge_page_aliases',
  'knowledge_page_links',
  'knowledge_graph_nodes',
  'knowledge_graph_edges',
  'knowledge_graph_snapshots',
  'knowledge_communities',
  'knowledge_insights',
  'knowledge_jobs',
  'knowledge_job_events',
  'knowledge_reviews',
  'knowledge_review_actions',
  'knowledge_research_runs',
  'knowledge_research_results',
  'knowledge_conversations',
  'knowledge_messages',
  'knowledge_outputs',
  'knowledge_operation_log',
] as const;

const OMITTED_TABLES = ['knowledge_provider_profiles'];

function assertSafePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || path.posix.normalize(normalized) !== normalized) {
    throw new Error(`Knowledge archive path traversal rejected: ${value}`);
  }
  return normalized;
}

function bytes(value: KnowledgeArchiveFile): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mediaType(filePath: string): string {
  if (filePath.endsWith('.md')) return 'text/markdown';
  if (filePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function addFile(files: Record<string, KnowledgeArchiveFile>, filePath: string, content: KnowledgeArchiveFile): void {
  files[assertSafePath(filePath)] = content;
}

function rowsFor(db: Database.Database, table: string, projectId: string): Record<string, unknown>[] {
  if (table === 'knowledge_projects') {
    const row = db.prepare('SELECT * FROM knowledge_projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
    return row ? [row] : [];
  }
  return db.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(projectId) as Record<string, unknown>[];
}

function redactProviderProfiles(db: Database.Database, projectId: string): Record<string, unknown>[] {
  return (db.prepare('SELECT * FROM knowledge_provider_profiles WHERE project_id = ?').all(projectId) as Record<string, unknown>[])
    .map(({ configuration_json: _configuration, ...profile }) => profile);
}

function pageMarkdown(
  db: Database.Database,
  page: Record<string, unknown>,
  contentRoot?: string,
  pageContents?: Record<string, string>,
): string {
  const version = db
    .prepare('SELECT * FROM knowledge_page_versions WHERE project_id = ? AND page_id = ? ORDER BY version_number DESC LIMIT 1')
    .get(page.project_id, page.id) as Record<string, unknown> | undefined;
  let content = '';
  if (pageContents?.[String(page.id)] !== undefined) {
    content = pageContents[String(page.id)];
  } else if (contentRoot && version?.content_path && existsSync(path.join(contentRoot, String(version.content_path)))) {
    content = readFileSync(path.join(contentRoot, String(version.content_path)), 'utf8');
  }
  const rendered = renderKnowledgePage({
    id: String(page.id),
    type: String(page.page_type) as never,
    title: String(page.title),
    slug: String(page.slug),
    status: String(page.status),
    content,
    version: Number(version?.version_number ?? 1),
    generatedAt: String(version?.created_at ?? page.updated_at),
  });
  return rendered.replace(/\[([^\]]+)\]\(pages\/[^/]+\/([^/)]+)\.md\)/g, '[[$2|$1]]');
}

export function exportKnowledgeProject(db: Database.Database, options: ExportKnowledgeProjectOptions): KnowledgeArchive {
  const project = db.prepare('SELECT * FROM knowledge_projects WHERE id = ?').get(options.projectId) as Record<string, unknown> | undefined;
  if (!project) throw new Error(`Knowledge project not found: ${options.projectId}`);
  const files: Record<string, KnowledgeArchiveFile> = {};
  for (const table of TABLES) addFile(files, `data/${table}.json`, json(rowsFor(db, table, options.projectId)));
  addFile(files, 'data/knowledge_provider_profiles.json', json(redactProviderProfiles(db, options.projectId)));
  addFile(files, 'project.json', json(project));
  const pages = rowsFor(db, 'knowledge_pages', options.projectId);
  for (const page of pages) {
    addFile(files, `pages/${page.page_type}/${page.slug}.md`, pageMarkdown(db, page, options.contentRoot, options.pageContents));
  }
  const graph = {
    nodes: rowsFor(db, 'knowledge_graph_nodes', options.projectId),
    edges: rowsFor(db, 'knowledge_graph_edges', options.projectId),
  };
  addFile(files, 'graph.json', json(graph));
  if (options.includeObsidian) addFile(files, '.obsidian/app.json', json({ alwaysUpdateLinks: true, newFileLocation: 'folder' }));
  const omitted = [...OMITTED_TABLES].map((table) => `${table}.configuration_json`);
  const entries = Object.entries(files)
    .map(([filePath, content]) => ({ path: filePath, size: bytes(content).byteLength, sha256: createHash('sha256').update(bytes(content)).digest('hex'), mediaType: mediaType(filePath) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    manifest: {
      archiveVersion: KNOWLEDGE_ARCHIVE_VERSION,
      format: 'ariadne-knowledge-archive',
      projectId: options.projectId,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      entries,
      omitted,
    },
    files,
  };
}

function validateArchive(archive: KnowledgeArchive): void {
  if (archive.manifest.archiveVersion !== KNOWLEDGE_ARCHIVE_VERSION) {
    throw new Error(`Unsupported knowledge archive version: ${String(archive.manifest.archiveVersion)}`);
  }
  if (archive.manifest.format !== 'ariadne-knowledge-archive') throw new Error('Invalid knowledge archive format');
  if (!archive.manifest.projectId.trim()) throw new Error('Knowledge archive project ID must not be empty');
  for (const entry of archive.manifest.entries) {
    assertSafePath(entry.path);
    const content = archive.files[entry.path];
    if (content === undefined) throw new Error(`Knowledge archive entry is missing: ${entry.path}`);
    const actual = bytes(content);
    if (actual.byteLength !== entry.size || createHash('sha256').update(actual).digest('hex') !== entry.sha256) {
      throw new Error(`Knowledge archive entry checksum mismatch: ${entry.path}`);
    }
  }
  for (const filePath of Object.keys(archive.files)) assertSafePath(filePath);
}

function tableRows(archive: KnowledgeArchive, table: string): Record<string, unknown>[] {
  const file = archive.files[`data/${table}.json`];
  if (file === undefined) return [];
  const value: unknown = JSON.parse(Buffer.from(bytes(file)).toString('utf8'));
  if (!Array.isArray(value)) throw new Error(`Knowledge archive table is not an array: ${table}`);
  return value as Record<string, unknown>[];
}

export function importKnowledgeProject(
  db: Database.Database,
  archive: KnowledgeArchive,
  options: ImportKnowledgeProjectOptions = {},
): ImportResult {
  validateArchive(archive);
  const projectId = archive.manifest.projectId;
  const existing = db.prepare('SELECT id FROM knowledge_projects WHERE id = ?').get(projectId);
  if (existing && !options.replaceExisting) throw new Error(`Knowledge project already exists: ${projectId}`);
  const result = db.transaction(() => {
    if (existing) db.prepare('DELETE FROM knowledge_projects WHERE id = ?').run(projectId);
    let rows = 0;
    let tables = 0;
    for (const table of TABLES) {
      const tableRowsValue = tableRows(archive, table);
      if (tableRowsValue.length === 0) continue;
      const columns = Object.keys(tableRowsValue[0]);
      const statement = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `@${column}`).join(', ')})`);
      for (const row of tableRowsValue) {
        statement.run(row);
        rows += 1;
      }
      tables += 1;
    }
    return { projectId, tables, rows, files: Object.keys(archive.files).sort() };
  })();
  return result;
}
