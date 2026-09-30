import type Database from 'better-sqlite3';
import { createKnowledgeId, normalizeKnowledgePath } from './KnowledgeIds.js';
import { KnowledgeSearchIndex } from './KnowledgeSearchIndex.js';
import type { KnowledgeSourceId, KnowledgeSourceKind, KnowledgeSourceRecord } from './KnowledgeTypes.js';
import { computeSourceVersion, sourceIdentitySeed } from './SourceIdentity.js';
import type { SourceContent, SourceVersion } from './SourceIdentity.js';

export { computeSourceVersion } from './SourceIdentity.js';
export type { SourceContent, SourceVersion } from './SourceIdentity.js';

export interface RegisterKnowledgeSourceInput {
  projectId: string;
  kind: KnowledgeSourceKind;
  path?: string;
  canonicalPath?: string;
  url?: string;
  content?: SourceContent;
  contentHash?: string;
  contentPath?: string;
  format?: string;
  mimeType?: string;
}

export interface KnowledgeSourceVersionRecord {
  id: string;
  projectId: string;
  sourceId: KnowledgeSourceId;
  versionNumber: number;
  contentHash: string;
  contentPath: string;
  byteLength: number;
  mimeType: string | null;
  createdAt: string;
}

interface SourceRow {
  id: string;
  project_id: string;
  source_kind: KnowledgeSourceKind;
  source_path: string | null;
  source_url: string | null;
  current_hash: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  project_id: string;
  source_id: string;
  version_number: number;
  content_hash: string;
  content_path: string;
  byte_length: number;
  mime_type: string | null;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function rowToSource(row: SourceRow): KnowledgeSourceRecord {
  const stale = row.status === 'stale';
  const canonicalPath = row.source_path ?? row.source_url ?? '';
  return {
    id: row.id as KnowledgeSourceId,
    projectId: row.project_id as KnowledgeSourceRecord['projectId'],
    kind: row.source_kind,
    canonicalPath,
    contentHash: row.current_hash ?? '',
    format: formatFromPath(canonicalPath),
    extractionStatus: stale ? 'skipped' : 'pending',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: stale ? row.updated_at : null,
  };
}

function formatFromPath(value: string): string {
  const match = value.split(/[/?#]/)[0].match(/\.([A-Za-z0-9]+)$/);
  return match?.[1]?.toLowerCase() ?? 'text';
}

function rowToVersion(row: VersionRow): KnowledgeSourceVersionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id as KnowledgeSourceId,
    versionNumber: row.version_number,
    contentHash: row.content_hash,
    contentPath: row.content_path,
    byteLength: row.byte_length,
    mimeType: row.mime_type,
    createdAt: row.created_at,
  };
}

export class KnowledgeSourceStore {
  public constructor(private readonly db: Database.Database) {}

  public register(input: RegisterKnowledgeSourceInput): KnowledgeSourceRecord {
    const canonicalPath = input.canonicalPath ?? (input.path ? normalizeKnowledgePath(input.path) : input.url);
    if (!canonicalPath) throw new Error('Knowledge source requires a path or URL');
    const contentVersion = input.content === undefined ? undefined : computeSourceVersion(input.content);
    const contentHash = input.contentHash ?? contentVersion?.hash;
    if (!contentHash) throw new Error('Knowledge source requires content or contentHash');
    const sourceId = createKnowledgeId(
      'source',
      sourceIdentitySeed(input.projectId, input.kind, canonicalPath),
    ) as KnowledgeSourceId;
    const timestamp = now();
    const existing = this.get(input.projectId, sourceId);

    const register = this.db.transaction(() => {
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO knowledge_sources
             (id, project_id, source_kind, source_path, source_url, current_hash, status, created_at, updated_at)
             VALUES (@id, @projectId, @kind, @sourcePath, @sourceUrl, @hash, 'active', @now, @now)`,
          )
          .run({
            id: sourceId,
            projectId: input.projectId,
            kind: input.kind,
            sourcePath: input.url ? null : canonicalPath,
            sourceUrl: input.url ?? null,
            hash: contentHash,
            now: timestamp,
          });
        this.insertVersion(input, sourceId, contentHash, contentVersion?.size ?? 0, timestamp, 1);
      } else if (existing.contentHash === contentHash && existing.deletedAt !== null) {
        this.db
          .prepare(
            `UPDATE knowledge_sources SET status = 'active', updated_at = @now
             WHERE project_id = @projectId AND id = @id`,
          )
          .run({ now: timestamp, projectId: input.projectId, id: sourceId });
      } else if (existing.contentHash !== contentHash) {
        if (this.hasVersionWithHash(input.projectId, sourceId, contentHash)) {
          // A→B→A: the existing immutable version for this hash becomes current again; history is not rewritten.
          this.db
            .prepare(
              `UPDATE knowledge_sources
               SET current_hash = @hash, status = 'active', updated_at = @now
               WHERE project_id = @projectId AND id = @id`,
            )
            .run({ hash: contentHash, now: timestamp, projectId: input.projectId, id: sourceId });
          return;
        }
        const nextVersion = this.nextVersion(input.projectId, sourceId);
        this.db
          .prepare(
            `UPDATE knowledge_sources
             SET current_hash = @hash, status = 'active', updated_at = @now
             WHERE project_id = @projectId AND id = @id`,
          )
          .run({ hash: contentHash, now: timestamp, projectId: input.projectId, id: sourceId });
        this.insertVersion(input, sourceId, contentHash, contentVersion?.size ?? 0, timestamp, nextVersion);
      }
    });
    register();
    return this.get(input.projectId, sourceId) as KnowledgeSourceRecord;
  }

  public get(projectId: string, sourceId: KnowledgeSourceId): KnowledgeSourceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM knowledge_sources WHERE project_id = ? AND id = ?')
      .get(projectId, sourceId) as SourceRow | undefined;
    return row ? rowToSource(row) : null;
  }

  public list(projectId: string): KnowledgeSourceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM knowledge_sources WHERE project_id = ? ORDER BY created_at, id')
      .all(projectId) as SourceRow[];
    return rows.map(rowToSource);
  }

  public listVersions(projectId: string, sourceId: KnowledgeSourceId): KnowledgeSourceVersionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_source_versions
         WHERE project_id = ? AND source_id = ? ORDER BY version_number`,
      )
      .all(projectId, sourceId) as VersionRow[];
    return rows.map(rowToVersion);
  }

  /**
   * The version whose content hash is the source's current hash (may be older than the highest version number).
   * Legacy/imported sources with a NULL or unmatched current hash fall back to the highest version, mirroring
   * `currentSourceVersionNumberSql`.
   */
  public currentVersion(projectId: string, sourceId: KnowledgeSourceId): KnowledgeSourceVersionRecord | null {
    const row = this.db
      .prepare(
        `SELECT v.* FROM knowledge_source_versions v
         WHERE v.project_id = @projectId AND v.source_id = @sourceId
         ORDER BY (v.content_hash = (SELECT s.current_hash FROM knowledge_sources s
                                      WHERE s.project_id = @projectId AND s.id = @sourceId)) DESC,
                  v.version_number DESC
         LIMIT 1`,
      )
      .get({ projectId, sourceId }) as VersionRow | undefined;
    return row ? rowToVersion(row) : null;
  }

  public markDeleted(projectId: string, sourceId: KnowledgeSourceId): KnowledgeSourceRecord {
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE knowledge_sources SET status = 'stale', updated_at = @now
           WHERE project_id = @projectId AND id = @id`,
        )
        .run({ now: now(), projectId, id: sourceId });
      if (result.changes === 0) throw new Error(`Knowledge source not found: ${sourceId}`);
      new KnowledgeSearchIndex(this.db).markSourceStale(projectId, sourceId);
    })();
    return this.get(projectId, sourceId) as KnowledgeSourceRecord;
  }

  private hasVersionWithHash(projectId: string, sourceId: KnowledgeSourceId, contentHash: string): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM knowledge_source_versions WHERE project_id = ? AND source_id = ? AND content_hash = ?',
        )
        .get(projectId, sourceId, contentHash) !== undefined
    );
  }

  private nextVersion(projectId: string, sourceId: KnowledgeSourceId): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM knowledge_source_versions WHERE project_id = ? AND source_id = ?',
      )
      .get(projectId, sourceId) as { next_version: number };
    return row.next_version;
  }

  private insertVersion(
    input: RegisterKnowledgeSourceInput,
    sourceId: KnowledgeSourceId,
    contentHash: string,
    byteLength: number,
    createdAt: string,
    versionNumber: number,
  ): void {
    const contentPath = input.contentPath ?? input.canonicalPath ?? input.path ?? input.url;
    if (!contentPath) throw new Error('Knowledge source version requires a content path');
    this.db
      .prepare(
        `INSERT INTO knowledge_source_versions
         (id, project_id, source_id, version_number, content_hash, content_path, byte_length, mime_type, created_at)
         VALUES (@id, @projectId, @sourceId, @versionNumber, @hash, @contentPath, @byteLength, @mimeType, @createdAt)`,
      )
      .run({
        id: createKnowledgeId('source-version', `${sourceId}:${contentHash}`),
        projectId: input.projectId,
        sourceId,
        versionNumber,
        hash: contentHash,
        contentPath,
        byteLength,
        mimeType: input.mimeType ?? null,
        createdAt,
      });
  }
}

export function registerKnowledgeSource(
  db: Database.Database,
  input: RegisterKnowledgeSourceInput,
): KnowledgeSourceRecord {
  return new KnowledgeSourceStore(db).register(input);
}
