import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createKnowledgeId } from './KnowledgeIds.js';
import type {
  KnowledgePageId,
  KnowledgePageRecord,
  KnowledgePageType,
  KnowledgeProjectId,
  KnowledgeProvenanceRef,
} from './KnowledgeTypes.js';

export interface KnowledgePageVersion {
  id: string;
  projectId: KnowledgeProjectId;
  pageId: KnowledgePageId;
  versionNumber: number;
  contentHash: string;
  contentPath: string;
  content: string;
  summary: string | null;
  sourceVersionIds: string[];
  provenance: KnowledgeProvenanceRef[];
  confidence: number | null;
  generatorVersion: string | null;
  createdAt: string;
}

export interface KnowledgePage extends KnowledgePageRecord {
  currentVersionId: string | null;
  content: string | null;
  contentPath: string | null;
  sourceVersionIds: string[];
  provenance: KnowledgeProvenanceRef[];
  generatorVersion: string | null;
}

export interface CreatePageVersionInput {
  projectId: string;
  pageId?: KnowledgePageId;
  type: KnowledgePageType;
  title: string;
  slug: string;
  content: string;
  contentPath?: string;
  summary?: string | null;
  sourceVersionIds?: string[];
  provenance?: KnowledgeProvenanceRef[];
  confidence?: number | null;
  generatorVersion?: string | null;
  createdAt?: string;
}

export interface SupersedePageVersionInput extends CreatePageVersionInput {
  pageId: KnowledgePageId;
}

interface PageRow {
  id: string;
  project_id: string;
  page_type: KnowledgePageType;
  title: string;
  slug: string;
  status: 'active' | 'archived' | 'stale';
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  project_id: string;
  page_id: string;
  version_number: number;
  content_hash: string;
  content_path: string;
  summary: string | null;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`Knowledge page ${label} must not be empty`);
}

function validateConfidence(confidence: number | null | undefined): void {
  if (
    confidence !== undefined &&
    confidence !== null &&
    (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    throw new Error('Knowledge page confidence must be between 0 and 1');
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function pagePath(type: KnowledgePageType, slug: string): string {
  return `pages/${type}/${slug}.md`;
}

function parseProvenance(db: Database.Database, versionId: string): KnowledgeProvenanceRef[] {
  const rows = db
    .prepare(
      `SELECT source_kind, source_id, confidence
       FROM knowledge_page_provenance
       WHERE page_version_id = ?
       ORDER BY rowid ASC`,
    )
    .all(versionId) as Array<{ source_kind: KnowledgeProvenanceRef['kind']; source_id: string; confidence: number }>;
  return rows.map((row) => ({ kind: row.source_kind, id: row.source_id, confidence: row.confidence }));
}

function parseSourceVersionIds(db: Database.Database, versionId: string): string[] {
  return (
    db
      .prepare(
        `SELECT source_version_id
         FROM knowledge_page_sources
         WHERE page_version_id = ?
         ORDER BY source_version_id`,
      )
      .all(versionId) as Array<{ source_version_id: string }>
  ).map((row) => row.source_version_id);
}

export class KnowledgePageStore {
  public constructor(private readonly db: Database.Database) {}

  public createPageVersion(input: CreatePageVersionInput): KnowledgePageVersion {
    requireNonEmpty(input.projectId, 'project ID');
    requireNonEmpty(input.title, 'title');
    requireNonEmpty(input.slug, 'slug');
    requireNonEmpty(input.content, 'content');
    validateConfidence(input.confidence);

    const pageId = input.pageId ?? (createKnowledgeId('page', `${input.projectId}:${input.slug}`) as KnowledgePageId);
    const timestamp = input.createdAt ?? now();
    const hash = contentHash(input.content);
    const path = input.contentPath ?? pagePath(input.type, input.slug);

    const create = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id FROM knowledge_pages WHERE project_id = ? AND id = ?')
        .get(input.projectId, pageId) as { id: string } | undefined;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO knowledge_pages
             (id, project_id, page_type, title, slug, status, created_at, updated_at)
             VALUES (@id, @projectId, @type, @title, @slug, 'active', @createdAt, @updatedAt)`,
          )
          .run({
            id: pageId,
            projectId: input.projectId,
            type: input.type,
            title: input.title,
            slug: input.slug,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
      } else {
        this.db
          .prepare(
            `UPDATE knowledge_pages
             SET page_type = @type, title = @title, status = 'active', updated_at = @updatedAt
             WHERE project_id = @projectId AND id = @id`,
          )
          .run({ projectId: input.projectId, id: pageId, type: input.type, title: input.title, updatedAt: timestamp });
      }

      const current = this.db
        .prepare(
          `SELECT version_number, id
           FROM knowledge_page_versions
           WHERE project_id = ? AND page_id = ?
           ORDER BY version_number DESC LIMIT 1`,
        )
        .get(input.projectId, pageId) as { version_number: number; id: string } | undefined;
      const duplicate = this.db
        .prepare('SELECT * FROM knowledge_page_versions WHERE project_id = ? AND page_id = ? AND content_hash = ?')
        .get(input.projectId, pageId, hash) as VersionRow | undefined;
      if (duplicate) return this.toVersion(duplicate);

      const versionNumber = (current?.version_number ?? 0) + 1;
      const versionId = createKnowledgeId('page-version', `${pageId}:${hash}`);
      this.db
        .prepare(
          `INSERT INTO knowledge_page_versions
           (id, project_id, page_id, version_number, content_hash, content_path, summary, created_at)
           VALUES (@id, @projectId, @pageId, @versionNumber, @contentHash, @contentPath, @summary, @createdAt)`,
        )
        .run({
          id: versionId,
          projectId: input.projectId,
          pageId,
          versionNumber,
          contentHash: hash,
          contentPath: path,
          summary: input.summary ?? null,
          createdAt: timestamp,
        });

      const insertSource = this.db.prepare(
        `INSERT INTO knowledge_page_sources (page_version_id, project_id, source_version_id, created_at)
         VALUES (@versionId, @projectId, @sourceVersionId, @createdAt)`,
      );
      for (const sourceVersionId of [...new Set(input.sourceVersionIds ?? [])]) {
        insertSource.run({ versionId, projectId: input.projectId, sourceVersionId, createdAt: timestamp });
      }

      const insertProvenance = this.db.prepare(
        `INSERT INTO knowledge_page_provenance
         (id, project_id, page_version_id, source_kind, source_id, confidence, created_at)
         VALUES (@id, @projectId, @versionId, @kind, @sourceId, @confidence, @createdAt)`,
      );
      for (const reference of input.provenance ?? []) {
        validateConfidence(reference.confidence);
        insertProvenance.run({
          id: createKnowledgeId('provenance', `${versionId}:${reference.kind}:${reference.id}`),
          projectId: input.projectId,
          versionId,
          kind: reference.kind,
          sourceId: reference.id,
          confidence: reference.confidence ?? input.confidence ?? 1,
          createdAt: timestamp,
        });
      }
      return this.getVersion(input.projectId, versionId)!;
    });
    return create();
  }

  public getVersion(projectId: string, versionId: string): KnowledgePageVersion | null {
    const row = this.db
      .prepare('SELECT * FROM knowledge_page_versions WHERE project_id = ? AND id = ?')
      .get(projectId, versionId) as VersionRow | undefined;
    return row ? this.toVersion(row) : null;
  }

  public listVersions(projectId: string, pageId: KnowledgePageId): KnowledgePageVersion[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_page_versions
         WHERE project_id = ? AND page_id = ?
         ORDER BY version_number ASC`,
      )
      .all(projectId, pageId) as VersionRow[];
    return rows.map((row) => this.toVersion(row));
  }

  public getCurrentPage(projectId: string, pageId: KnowledgePageId): KnowledgePage | null {
    const row = this.db
      .prepare('SELECT * FROM knowledge_pages WHERE project_id = ? AND id = ?')
      .get(projectId, pageId) as PageRow | undefined;
    if (!row) return null;
    return this.toPage(row);
  }

  public listPages(projectId: string, type?: KnowledgePageType): KnowledgePage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_pages
         WHERE project_id = @projectId ${type ? 'AND page_type = @type' : ''}
         ORDER BY slug ASC, id ASC`,
      )
      .all(type ? { projectId, type } : { projectId }) as PageRow[];
    return rows.map((row) => this.toPage(row));
  }

  public supersedePageVersion(input: SupersedePageVersionInput): KnowledgePageVersion {
    return this.createPageVersion(input);
  }

  public markPageStale(projectId: string, pageId: KnowledgePageId): KnowledgePage {
    const result = this.db
      .prepare(
        `UPDATE knowledge_pages
         SET status = 'stale', updated_at = @updatedAt
         WHERE project_id = @projectId AND id = @id`,
      )
      .run({ projectId, id: pageId, updatedAt: now() });
    if (result.changes === 0) throw new Error(`Knowledge page not found: ${pageId}`);
    return this.getCurrentPage(projectId, pageId)!;
  }

  public getNextVersionNumber(projectId: string, pageId: KnowledgePageId): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
         FROM knowledge_page_versions
         WHERE project_id = ? AND page_id = ?`,
      )
      .get(projectId, pageId) as { next_version: number };
    return row.next_version;
  }

  private toVersion(row: VersionRow): KnowledgePageVersion {
    return {
      id: row.id,
      projectId: row.project_id as KnowledgeProjectId,
      pageId: row.page_id as KnowledgePageId,
      versionNumber: row.version_number,
      contentHash: row.content_hash,
      contentPath: row.content_path,
      content: '',
      summary: row.summary,
      sourceVersionIds: parseSourceVersionIds(this.db, row.id),
      provenance: parseProvenance(this.db, row.id),
      confidence: null,
      generatorVersion: null,
      createdAt: row.created_at,
    };
  }

  private toPage(row: PageRow): KnowledgePage {
    const version = this.db
      .prepare(
        `SELECT * FROM knowledge_page_versions
         WHERE project_id = ? AND page_id = ?
         ORDER BY version_number DESC LIMIT 1`,
      )
      .get(row.project_id, row.id) as VersionRow | undefined;
    const currentVersion = version?.version_number ?? 0;
    return {
      id: row.id as KnowledgePageId,
      projectId: row.project_id as KnowledgeProjectId,
      type: row.page_type,
      title: row.title,
      slug: row.slug,
      summary: version?.summary ?? null,
      status: row.status,
      currentVersion,
      confidence: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.status === 'archived' ? row.updated_at : null,
      currentVersionId: version?.id ?? null,
      content: null,
      contentPath: version?.content_path ?? null,
      sourceVersionIds: version ? parseSourceVersionIds(this.db, version.id) : [],
      provenance: version ? parseProvenance(this.db, version.id) : [],
      generatorVersion: null,
    };
  }
}

export function createPageVersion(db: Database.Database, input: CreatePageVersionInput): KnowledgePageVersion {
  return new KnowledgePageStore(db).createPageVersion(input);
}

export function getCurrentPage(
  db: Database.Database,
  projectId: string,
  pageId: KnowledgePageId,
): KnowledgePage | null {
  return new KnowledgePageStore(db).getCurrentPage(projectId, pageId);
}

export function listPages(db: Database.Database, projectId: string, type?: KnowledgePageType): KnowledgePage[] {
  return new KnowledgePageStore(db).listPages(projectId, type);
}

export function supersedePageVersion(
  db: Database.Database,
  input: SupersedePageVersionInput,
): KnowledgePageVersion {
  return new KnowledgePageStore(db).supersedePageVersion(input);
}

export function markPageStale(
  db: Database.Database,
  projectId: string,
  pageId: KnowledgePageId,
): KnowledgePage {
  return new KnowledgePageStore(db).markPageStale(projectId, pageId);
}
