import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createKnowledgeId } from './KnowledgeIds.js';
import { KnowledgePageStore } from './KnowledgePageStore.js';
import { KnowledgeSearchIndex } from './KnowledgeSearchIndex.js';
import { KnowledgeSourceStore } from './KnowledgeSourceStore.js';
import type {
  KnowledgePageId,
  KnowledgePageType,
  KnowledgeProvenanceRef,
  KnowledgeSourceId,
} from './KnowledgeTypes.js';

export interface ReconciliationRunOptions {
  beforeCommit?: () => void;
}

export interface KnowledgeReconciliationOptions {
  now?: () => string;
}

export interface SourceReconciliationResult {
  projectId: string;
  sourceId: KnowledgeSourceId;
  archivedPageIds: KnowledgePageId[];
  supersededPageIds: KnowledgePageId[];
  stalePageIds: KnowledgePageId[];
  reviewIds: string[];
  insightIds: string[];
}

interface SourceRow {
  id: string;
  project_id: string;
  status: string;
}

interface SourceVersionRow {
  id: string;
  source_id: string;
  version_number: number;
}

interface CurrentPageRow {
  page_id: string;
  project_id: string;
  page_type: KnowledgePageType;
  title: string;
  slug: string;
  status: 'active' | 'archived' | 'stale';
  version_id: string;
  summary: string | null;
}

interface EdgeRow {
  id: string;
  evidence_json: string;
}

interface StoredEvidence {
  evidence?: string[];
  weight?: number;
  provenance?: KnowledgeProvenanceRef[];
}

interface ParsedStoredEvidence {
  value: StoredEvidence;
  invalid: boolean;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`Knowledge reconciliation ${label} must not be empty`);
}

function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function rowOrder(left: CurrentPageRow, right: CurrentPageRow): number {
  return left.slug.localeCompare(right.slug) || left.page_id.localeCompare(right.page_id);
}

function emptyResult(projectId: string, sourceId: KnowledgeSourceId): SourceReconciliationResult {
  return {
    projectId,
    sourceId,
    archivedPageIds: [],
    supersededPageIds: [],
    stalePageIds: [],
    reviewIds: [],
    insightIds: [],
  };
}

function parseStoredEvidence(value: string): ParsedStoredEvidence {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: {}, invalid: true };
    }
    const stored = parsed as StoredEvidence;
    if (stored.provenance !== undefined && !Array.isArray(stored.provenance)) {
      return { value: stored, invalid: true };
    }
    return { value: stored, invalid: false };
  } catch {
    return { value: {}, invalid: true };
  }
}

export class KnowledgeReconciliation {
  private readonly now: () => string;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeReconciliationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public reconcileChangedSource(
    sourceId: KnowledgeSourceId,
    options: ReconciliationRunOptions = {},
  ): SourceReconciliationResult {
    requireNonEmpty(sourceId, 'source ID');
    const source = this.requireSource(sourceId);
    const result = emptyResult(source.project_id, sourceId);

    this.db.transaction(() => {
      const versions = this.listSourceVersions(source.project_id, sourceId);
      if (versions.length === 0) throw new Error(`Knowledge source has no versions: ${sourceId}`);
      const currentVersion = new KnowledgeSourceStore(this.db).currentVersion(source.project_id, sourceId);
      if (currentVersion === null) throw new Error(`Knowledge source has no current version: ${sourceId}`);
      const staleVersionIds = new Set(versions.filter((version) => version.id !== currentVersion.id).map((version) => version.id));
      if (staleVersionIds.size === 0) {
        options.beforeCommit?.();
        return;
      }

      for (const page of this.listCurrentPages(source.project_id).sort(rowOrder)) {
        if (page.status !== 'active') continue;
        const sourceVersionIds = this.listPageSourceVersionIds(page.version_id);
        const referencesStaleVersion = sourceVersionIds.some((id) => staleVersionIds.has(id));
        if (!referencesStaleVersion) continue;
        this.markPageStatus(source.project_id, page.page_id, 'stale');
        this.removePageLinks(source.project_id, [page.page_id]);
        this.removePageGraphNodes(source.project_id, [page.page_id]);
        result.stalePageIds.push(page.page_id as KnowledgePageId);
        const summary = `Knowledge page ${page.page_id} references a stale version of source ${sourceId}`;
        result.reviewIds.push(this.ensureReview(source.project_id, page.version_id, summary));
        result.insightIds.push(
          this.ensureInsight(source.project_id, 'stale', {
            pageId: page.page_id,
            sourceId,
            sourceVersionId: currentVersion.id,
            staleVersionIds: [...staleVersionIds].sort(),
          }),
        );
      }

      options.beforeCommit?.();
    })();

    return {
      ...result,
      archivedPageIds: uniqueSorted(result.archivedPageIds),
      supersededPageIds: uniqueSorted(result.supersededPageIds),
      stalePageIds: uniqueSorted(result.stalePageIds),
      reviewIds: uniqueSorted(result.reviewIds),
      insightIds: uniqueSorted(result.insightIds),
    };
  }

  public reconcileDeletedSource(
    sourceId: KnowledgeSourceId,
    options: ReconciliationRunOptions = {},
  ): SourceReconciliationResult {
    requireNonEmpty(sourceId, 'source ID');
    const source = this.requireSource(sourceId);
    const result = emptyResult(source.project_id, sourceId);

    this.db.transaction(() => {
      const deletedVersionIds = new Set(this.listSourceVersions(source.project_id, sourceId).map((version) => version.id));
      if (deletedVersionIds.size === 0) throw new Error(`Knowledge source has no versions: ${sourceId}`);
      this.markSourceDeleted(source.project_id, sourceId);

      const archivedPageIds: KnowledgePageId[] = [];
      for (const page of this.listCurrentPages(source.project_id).sort(rowOrder)) {
        if (page.status !== 'active') continue;
        const sourceVersionIds = this.listPageSourceVersionIds(page.version_id);
        const provenance = this.listPageProvenance(page.version_id);
        const referencesDeletedVersion = sourceVersionIds.some((id) => deletedVersionIds.has(id));
        const referencesDeletedSource = provenance.some((reference) => reference.kind === 'source' && reference.id === sourceId);
        if (!referencesDeletedVersion && !referencesDeletedSource) continue;

        const remainingSourceVersionIds = sourceVersionIds.filter((id) => !deletedVersionIds.has(id));
        const remainingProvenance = provenance.filter((reference) => !(reference.kind === 'source' && reference.id === sourceId));
        const hasRemainingSourceReference =
          remainingSourceVersionIds.length > 0 ||
          remainingProvenance.some((reference) => reference.kind === 'source' && reference.id !== sourceId);

        if (!hasRemainingSourceReference) {
          this.markPageStatus(source.project_id, page.page_id, 'archived');
          archivedPageIds.push(page.page_id as KnowledgePageId);
          result.archivedPageIds.push(page.page_id as KnowledgePageId);
          continue;
        }

        this.supersedeWithoutDeletedSource(page, remainingSourceVersionIds, remainingProvenance, sourceId);
        result.supersededPageIds.push(page.page_id as KnowledgePageId);
      }

      const affectedPageIds = [...result.archivedPageIds, ...result.supersededPageIds];
      if (affectedPageIds.length > 0) this.removePageLinks(source.project_id, affectedPageIds);
      if (archivedPageIds.length > 0) this.removePageGraphNodes(source.project_id, archivedPageIds);
      this.removeSourceGraphNodes(source.project_id, sourceId);
      result.reviewIds.push(...this.pruneGraphEdgeProvenance(source.project_id, sourceId));
      options.beforeCommit?.();
    })();

    return {
      ...result,
      archivedPageIds: uniqueSorted(result.archivedPageIds),
      supersededPageIds: uniqueSorted(result.supersededPageIds),
      stalePageIds: uniqueSorted(result.stalePageIds),
      reviewIds: uniqueSorted(result.reviewIds),
      insightIds: uniqueSorted(result.insightIds),
    };
  }

  private requireSource(sourceId: KnowledgeSourceId): SourceRow {
    const row = this.db.prepare('SELECT id, project_id, status FROM knowledge_sources WHERE id = ?').get(sourceId) as
      | SourceRow
      | undefined;
    if (row === undefined) throw new Error(`Knowledge source not found: ${sourceId}`);
    return row;
  }

  private listSourceVersions(projectId: string, sourceId: KnowledgeSourceId): SourceVersionRow[] {
    return this.db
      .prepare(
        `SELECT id, source_id, version_number
         FROM knowledge_source_versions
         WHERE project_id = ? AND source_id = ?
         ORDER BY version_number ASC`,
      )
      .all(projectId, sourceId) as SourceVersionRow[];
  }

  private listCurrentPages(projectId: string): CurrentPageRow[] {
    return this.db
      .prepare(
        `SELECT p.id AS page_id, p.project_id, p.page_type, p.title, p.slug, p.status,
                v.id AS version_id, v.summary
         FROM knowledge_pages p
         JOIN knowledge_page_versions v
           ON v.project_id = p.project_id
          AND v.page_id = p.id
          AND v.version_number = (
            SELECT MAX(version_number)
            FROM knowledge_page_versions latest
            WHERE latest.project_id = p.project_id AND latest.page_id = p.id
          )
         WHERE p.project_id = ?`,
      )
      .all(projectId) as CurrentPageRow[];
  }

  private listPageSourceVersionIds(pageVersionId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT source_version_id
           FROM knowledge_page_sources
           WHERE page_version_id = ?
           ORDER BY source_version_id`,
        )
        .all(pageVersionId) as Array<{ source_version_id: string }>
    ).map((row) => row.source_version_id);
  }

  private listPageProvenance(pageVersionId: string): KnowledgeProvenanceRef[] {
    return (
      this.db
        .prepare(
          `SELECT source_kind, source_id, confidence
           FROM knowledge_page_provenance
           WHERE page_version_id = ?
           ORDER BY rowid ASC`,
        )
        .all(pageVersionId) as Array<{ source_kind: KnowledgeProvenanceRef['kind']; source_id: string; confidence: number }>
    ).map((row) => ({ kind: row.source_kind, id: row.source_id, confidence: row.confidence }));
  }

  private markSourceDeleted(projectId: string, sourceId: KnowledgeSourceId): void {
    this.db
      .prepare(
        `UPDATE knowledge_sources
         SET status = 'stale', updated_at = @updatedAt
         WHERE project_id = @projectId AND id = @sourceId`,
      )
      .run({ projectId, sourceId, updatedAt: this.now() });
    new KnowledgeSearchIndex(this.db).markSourceStale(projectId, sourceId);
  }

  private markPageStatus(projectId: string, pageId: string, status: 'archived' | 'stale'): void {
    this.db
      .prepare(
        `UPDATE knowledge_pages
         SET status = @status, updated_at = @updatedAt
         WHERE project_id = @projectId AND id = @pageId`,
      )
      .run({ projectId, pageId, status, updatedAt: this.now() });
  }

  private supersedeWithoutDeletedSource(
    page: CurrentPageRow,
    sourceVersionIds: string[],
    provenance: KnowledgeProvenanceRef[],
    deletedSourceId: KnowledgeSourceId,
  ): void {
    new KnowledgePageStore(this.db).supersedePageVersion({
      projectId: page.project_id,
      pageId: page.page_id as KnowledgePageId,
      type: page.page_type,
      title: page.title,
      slug: page.slug,
      content: this.reconciledContent(page, deletedSourceId),
      contentPath: `pages/${page.page_type}/${page.slug}.md`,
      summary: page.summary,
      sourceVersionIds,
      provenance,
      createdAt: this.now(),
    });
  }

  private reconciledContent(page: CurrentPageRow, deletedSourceId: KnowledgeSourceId): string {
    const summary = page.summary?.trim();
    return [
      `# ${page.title}`,
      '',
      summary && summary.length > 0 ? summary : `Preserved shared page ${page.slug}.`,
      '',
      `Reconciled after removing source ${deletedSourceId}.`,
    ].join('\n');
  }

  private removePageLinks(projectId: string, pageIds: readonly string[]): void {
    const deleteLinks = this.db.prepare(
      `DELETE FROM knowledge_page_links
       WHERE project_id = @projectId AND (source_page_id = @pageId OR target_page_id = @pageId)`,
    );
    for (const pageId of pageIds) deleteLinks.run({ projectId, pageId });
  }

  private removeSourceGraphNodes(projectId: string, sourceId: KnowledgeSourceId): void {
    this.db
      .prepare(
        `DELETE FROM knowledge_graph_nodes
         WHERE project_id = ? AND source_kind = 'source' AND source_id = ?`,
      )
      .run(projectId, sourceId);
  }

  private removePageGraphNodes(projectId: string, pageIds: readonly string[]): void {
    const remove = this.db.prepare(
      `DELETE FROM knowledge_graph_nodes
       WHERE project_id = @projectId AND source_kind = 'page' AND source_id = @pageId`,
    );
    for (const pageId of pageIds) remove.run({ projectId, pageId });
  }

  private pruneGraphEdgeProvenance(projectId: string, sourceId: KnowledgeSourceId): string[] {
    const reviewIds: string[] = [];
    const rows = this.db
      .prepare('SELECT id, evidence_json FROM knowledge_graph_edges WHERE project_id = ? ORDER BY id')
      .all(projectId) as EdgeRow[];
    const remove = this.db.prepare('DELETE FROM knowledge_graph_edges WHERE project_id = ? AND id = ?');
    const update = this.db.prepare(
      `UPDATE knowledge_graph_edges
       SET evidence_json = @evidenceJson, updated_at = @updatedAt
       WHERE project_id = @projectId AND id = @id`,
    );

    for (const row of rows) {
      const parsed = parseStoredEvidence(row.evidence_json);
      if (parsed.invalid) {
        reviewIds.push(
          this.ensureProjectReview(
            projectId,
            `Knowledge graph edge ${row.id} has invalid evidence JSON during source reconciliation`,
          ),
        );
        continue;
      }
      const stored = parsed.value;
      const provenance = stored.provenance ?? [];
      const filteredProvenance = provenance.filter((reference) => !(reference.kind === 'source' && reference.id === sourceId));
      if (filteredProvenance.length === provenance.length) continue;
      if (filteredProvenance.length === 0) {
        remove.run(projectId, row.id);
        continue;
      }
      update.run({
        projectId,
        id: row.id,
        evidenceJson: JSON.stringify({ ...stored, provenance: filteredProvenance }),
        updatedAt: this.now(),
      });
    }
    return reviewIds;
  }

  private ensureReview(projectId: string, pageVersionId: string, summary: string): string {
    const existing = this.db
      .prepare(
        `SELECT id FROM knowledge_reviews
         WHERE project_id = ? AND page_version_id = ? AND status = 'pending' AND summary = ?
         ORDER BY requested_at, id
         LIMIT 1`,
      )
      .get(projectId, pageVersionId, summary) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = createKnowledgeId('review', `${projectId}:${pageVersionId}:${summary}`);
    this.db
      .prepare(
        `INSERT INTO knowledge_reviews
         (id, project_id, page_version_id, status, requested_at, summary)
         VALUES (@id, @projectId, @pageVersionId, 'pending', @requestedAt, @summary)`,
      )
      .run({ id, projectId, pageVersionId, requestedAt: this.now(), summary });
    return id;
  }

  private ensureProjectReview(projectId: string, summary: string): string {
    const existing = this.db
      .prepare(
        `SELECT id FROM knowledge_reviews
         WHERE project_id = ? AND page_version_id IS NULL AND status = 'pending' AND summary = ?
         ORDER BY requested_at, id
         LIMIT 1`,
      )
      .get(projectId, summary) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = createKnowledgeId('review', `${projectId}:project:${summary}`);
    this.db
      .prepare(
        `INSERT INTO knowledge_reviews
         (id, project_id, page_version_id, status, requested_at, summary)
         VALUES (@id, @projectId, NULL, 'pending', @requestedAt, @summary)`,
      )
      .run({ id, projectId, requestedAt: this.now(), summary });
    return id;
  }

  private ensureInsight(projectId: string, type: 'stale', evidence: Record<string, unknown>): string {
    const fingerprint = stableFingerprint({ type, evidence });
    const contentPath = `reconciliation/${type}/${fingerprint}.json`;
    const existing = this.db
      .prepare(
        `SELECT id FROM knowledge_insights
         WHERE project_id = ? AND graph_snapshot_id IS NULL AND insight_type = ? AND content_path = ?
         LIMIT 1`,
      )
      .get(projectId, type, contentPath) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = createKnowledgeId('insight', `${projectId}:${type}:${fingerprint}`);
    this.db
      .prepare(
        `INSERT INTO knowledge_insights
         (id, project_id, graph_snapshot_id, insight_type, content_path, confidence, created_at)
         VALUES (@id, @projectId, NULL, @type, @contentPath, 1, @createdAt)`,
      )
      .run({ id, projectId, type, contentPath, createdAt: this.now() });
    return id;
  }
}

export function reconcileChangedSource(
  db: Database.Database,
  sourceId: KnowledgeSourceId,
  options?: ReconciliationRunOptions,
): SourceReconciliationResult {
  return new KnowledgeReconciliation(db).reconcileChangedSource(sourceId, options);
}

export function reconcileDeletedSource(
  db: Database.Database,
  sourceId: KnowledgeSourceId,
  options?: ReconciliationRunOptions,
): SourceReconciliationResult {
  return new KnowledgeReconciliation(db).reconcileDeletedSource(sourceId, options);
}
