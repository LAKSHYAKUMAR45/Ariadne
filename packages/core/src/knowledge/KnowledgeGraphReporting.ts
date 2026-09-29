import type Database from 'better-sqlite3';
import { boundCoverageText } from './analyzers/AnalyzerCoverage.js';
import {
  GRAPH_AMBIGUITY_KINDS,
  GRAPH_AMBIGUITY_SEVERITIES,
  type BuildKnowledgeGraphReportInput,
  type GraphCompletenessWarning,
  type KnowledgeGraphAmbiguity,
  type KnowledgeGraphAmbiguityKind,
  type KnowledgeGraphAmbiguitySeverity,
  type KnowledgeGraphCompletenessReport,
  type KnowledgeGraphReportingService,
} from './KnowledgeGraphReportTypes.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import type { DeferredRelationshipResolutionKind } from './KnowledgeExtraction.js';
import { KnowledgeGraph } from './graph/KnowledgeGraph.js';

export * from './KnowledgeGraphReportTypes.js';

export const MAX_GRAPH_AMBIGUITIES_PER_REPORT = 500;
export const MAX_AMBIGUITY_CANDIDATES = 10;
const MAX_ORIGINAL_RELATION_LENGTH = 64;
const LEGACY_METADATA_MARKER = 'legacy metadata omitted';

interface SourceCoverageRow {
  status: string | null;
}

interface DeferredRow {
  id: string;
  source_version_id: string;
  relationship_type: string;
  source_symbol_id: string | null;
  target_reference: string | null;
  target_symbol_id: string | null;
  resolution_kind: DeferredRelationshipResolutionKind;
  evidence_kind: string;
}

interface AmbiguityDraft {
  id: string;
  ambiguityKind: KnowledgeGraphAmbiguityKind;
  severity: KnowledgeGraphAmbiguitySeverity;
  sourceVersionId: string | null;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  candidateNodeIds?: string[];
  relatedEdgeIds?: string[];
  message: string;
  detail: Record<string, unknown>;
}

interface AmbiguityRow {
  id: string;
  source_version_id: string | null;
  source_node_id: string | null;
  target_node_id: string | null;
  ambiguity_kind: KnowledgeGraphAmbiguityKind;
  severity: KnowledgeGraphAmbiguitySeverity;
  detail_json: string;
}

const SEVERITY_RANK: Readonly<Record<KnowledgeGraphAmbiguitySeverity, number>> = { review: 0, warning: 1, info: 2 };

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Knowledge graph report ${label} must not be empty`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isCountRecord(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => isCount(value[key]));
}

/** A stored report that does not match the current shape reads as "not yet computed" rather than throwing. */
function parseStoredReport(json: string): KnowledgeGraphCompletenessReport | null {
  try {
    const value: unknown = JSON.parse(json);
    if (
      !isRecord(value) ||
      typeof value.projectId !== 'string' ||
      !(value.snapshotId === null || typeof value.snapshotId === 'string') ||
      typeof value.createdAt !== 'string' ||
      !isCountRecord(value.sources, ['activeCount', 'coveredCount', 'partialCount', 'unsupportedCount', 'legacyUnknownCount']) ||
      !isCountRecord(value.relationships, ['materializedCount', 'deferredCount', 'unresolvedCount', 'downgradedCount', 'ambiguousCount']) ||
      !isCountRecord(value.provenance, ['edgeWithProvenanceCount', 'edgeMissingProvenanceCount']) ||
      !Array.isArray(value.warnings)
    ) {
      return null;
    }
    return value as unknown as KnowledgeGraphCompletenessReport;
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;
}

function toAmbiguity(row: AmbiguityRow): KnowledgeGraphAmbiguity {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.detail_json);
    if (isRecord(parsed)) detail = parsed;
  } catch {
    detail = {};
  }
  const candidateNodeIds = parseStringArray(detail.candidateNodeIds);
  const relatedEdgeIds = parseStringArray(detail.relatedEdgeIds);
  return {
    id: row.id,
    ambiguityKind: row.ambiguity_kind,
    severity: row.severity,
    sourceVersionId: row.source_version_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    ...(candidateNodeIds ? { candidateNodeIds } : {}),
    ...(relatedEdgeIds ? { relatedEdgeIds } : {}),
    message: typeof detail.message === 'string' ? detail.message : '',
  };
}

function draftOrder(left: AmbiguityDraft, right: AmbiguityDraft): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    left.ambiguityKind.localeCompare(right.ambiguityKind) ||
    left.id.localeCompare(right.id)
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}`;
}

/**
 * Derives graph completeness and ambiguity reports from persisted state. Reports are optional and recomputable: they
 * never change graph facts, hold only ids, counts, kinds, and bounded diagnostics, and always stay project scoped.
 */
export class KnowledgeGraphReporter implements KnowledgeGraphReportingService {
  private readonly now: () => string;
  private readonly graph: KnowledgeGraph;

  public constructor(
    private readonly db: Database.Database,
    options: { now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.graph = new KnowledgeGraph(db);
  }

  public buildCompletenessReport(input: BuildKnowledgeGraphReportInput): KnowledgeGraphCompletenessReport {
    const projectId = requireText(input.projectId, 'project ID');
    return this.db.transaction(() => {
      this.requireProject(projectId);
      const snapshotId = this.resolveBuildSnapshot(projectId, input.snapshotId);
      const sources = this.countSources(projectId);
      const drafts: AmbiguityDraft[] = [];
      const deferredCount = this.collectDeferredAmbiguities(projectId, snapshotId, drafts);
      const graphCounts = this.collectEdgeAmbiguities(projectId, snapshotId, drafts);
      const unresolvedCount = drafts.filter(
        (draft) =>
          draft.ambiguityKind === 'external_reference_unresolved' ||
          draft.ambiguityKind === 'multiple_candidate_targets',
      ).length;
      const ambiguousCount = drafts.filter((draft) => draft.ambiguityKind === 'multiple_candidate_targets').length;
      const ordered = drafts.sort(draftOrder);
      const stored = ordered.slice(0, MAX_GRAPH_AMBIGUITIES_PER_REPORT);

      const body: Omit<KnowledgeGraphCompletenessReport, 'createdAt'> = {
        projectId,
        snapshotId,
        sources,
        relationships: {
          materializedCount: graphCounts.materialized,
          deferredCount,
          unresolvedCount,
          downgradedCount: graphCounts.downgraded,
          ambiguousCount,
        },
        provenance: {
          edgeWithProvenanceCount: graphCounts.withProvenance,
          edgeMissingProvenanceCount: graphCounts.missingProvenance,
        },
        ambiguities: { totalCount: ordered.length, storedCount: stored.length },
        warnings: [],
      };
      body.warnings = this.buildWarnings(projectId, snapshotId, body, graphCounts.sanitized);
      const report = this.persistReport(projectId, snapshotId, body);
      this.persistAmbiguities(projectId, snapshotId, stored, report.createdAt);
      return report;
    })();
  }

  /** Returns the persisted report, or null when it has not been computed (or cannot be read) for the snapshot. */
  public getCompletenessReport(projectId: string, snapshotId?: string | null): KnowledgeGraphCompletenessReport | null {
    requireText(projectId, 'project ID');
    const resolved = this.resolveReadSnapshot(projectId, snapshotId);
    const row = this.db
      .prepare('SELECT report_json FROM knowledge_graph_reports WHERE project_id = ? AND id = ?')
      .get(projectId, this.reportId(projectId, resolved)) as { report_json: string } | undefined;
    return row ? parseStoredReport(row.report_json) : null;
  }

  public listAmbiguities(projectId: string, snapshotId?: string | null): KnowledgeGraphAmbiguity[] {
    requireText(projectId, 'project ID');
    const resolved = this.resolveReadSnapshot(projectId, snapshotId);
    const rows = this.db
      .prepare(
        `SELECT id, source_version_id, source_node_id, target_node_id, ambiguity_kind, severity, detail_json
         FROM knowledge_graph_ambiguities
         WHERE project_id = ? AND graph_snapshot_id IS ?`,
      )
      .all(projectId, resolved) as AmbiguityRow[];
    return rows
      .filter((row) => GRAPH_AMBIGUITY_KINDS.includes(row.ambiguity_kind) && GRAPH_AMBIGUITY_SEVERITIES.includes(row.severity))
      .map(toAmbiguity)
      .sort(
        (left, right) =>
          SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
          left.ambiguityKind.localeCompare(right.ambiguityKind) ||
          left.id.localeCompare(right.id),
      );
  }

  private requireProject(projectId: string): void {
    const row = this.db.prepare('SELECT 1 AS present FROM knowledge_projects WHERE id = ?').get(projectId);
    if (!row) throw new Error(`Knowledge project not found: ${projectId}`);
  }

  private latestSnapshotId(projectId: string): string | null {
    const row = this.db
      .prepare('SELECT id FROM knowledge_graph_snapshots WHERE project_id = ? ORDER BY snapshot_number DESC LIMIT 1')
      .get(projectId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private resolveBuildSnapshot(projectId: string, snapshotId: string | null | undefined): string | null {
    if (snapshotId === undefined || snapshotId === null) return this.latestSnapshotId(projectId);
    const row = this.db
      .prepare('SELECT 1 AS present FROM knowledge_graph_snapshots WHERE project_id = ? AND id = ?')
      .get(projectId, snapshotId);
    if (!row) throw new Error(`Knowledge graph snapshot not found in project ${projectId}: ${snapshotId}`);
    return snapshotId;
  }

  private resolveReadSnapshot(projectId: string, snapshotId: string | null | undefined): string | null {
    return snapshotId === undefined || snapshotId === null ? this.latestSnapshotId(projectId) : snapshotId;
  }

  private reportId(projectId: string, snapshotId: string | null): string {
    return createKnowledgeId('graph-report', `${projectId}:${snapshotId ?? 'live'}`);
  }

  /** Counts each active source once through its latest version; a version without a coverage row is legacy unknown. */
  private countSources(projectId: string): KnowledgeGraphCompletenessReport['sources'] {
    const rows = this.db
      .prepare(
        `SELECT c.status AS status
         FROM knowledge_sources s
         LEFT JOIN knowledge_source_versions v
           ON v.project_id = s.project_id AND v.source_id = s.id
          AND v.version_number = (
            SELECT MAX(latest.version_number) FROM knowledge_source_versions latest
            WHERE latest.project_id = s.project_id AND latest.source_id = s.id
          )
         LEFT JOIN knowledge_analysis_coverage c
           ON c.project_id = v.project_id AND c.source_version_id = v.id
         WHERE s.project_id = ? AND s.status = 'active'`,
      )
      .all(projectId) as SourceCoverageRow[];
    const counts = { activeCount: rows.length, coveredCount: 0, partialCount: 0, unsupportedCount: 0, legacyUnknownCount: 0 };
    for (const row of rows) {
      if (row.status === 'supported') counts.coveredCount += 1;
      else if (row.status === 'partial') counts.partialCount += 1;
      else if (row.status === 'unsupported' || row.status === 'failed') counts.unsupportedCount += 1;
      else counts.legacyUnknownCount += 1;
    }
    return counts;
  }

  private collectDeferredAmbiguities(projectId: string, snapshotId: string | null, drafts: AmbiguityDraft[]): number {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.source_version_id, d.relationship_type, d.source_symbol_id, d.target_symbol_id,
                d.target_reference, d.resolution_kind, d.evidence_kind
         FROM knowledge_deferred_relationships d
         JOIN knowledge_source_versions v ON v.project_id = d.project_id AND v.id = d.source_version_id
         JOIN knowledge_sources s ON s.project_id = v.project_id AND s.id = v.source_id AND s.status = 'active'
         WHERE d.project_id = ?
           AND v.version_number = (
             SELECT MAX(latest.version_number) FROM knowledge_source_versions latest
             WHERE latest.project_id = v.project_id AND latest.source_id = v.source_id
           )
         ORDER BY d.id`,
      )
      .all(projectId) as DeferredRow[];
    for (const row of rows) {
      drafts.push(this.deferredDraft(projectId, snapshotId, row));
    }
    return rows.length;
  }

  private deferredDraft(projectId: string, snapshotId: string | null, row: DeferredRow): AmbiguityDraft {
    const sourceNodeId = this.symbolNodeId(projectId, row.source_version_id, row.source_symbol_id);
    const targetNodeId = this.symbolNodeId(projectId, row.source_version_id, row.target_symbol_id);
    const base = {
      sourceVersionId: row.source_version_id,
      sourceNodeId,
      targetNodeId,
    };
    const detail = {
      deferredRelationshipId: row.id,
      relationType: row.relationship_type,
      resolutionKind: row.resolution_kind,
      evidenceKind: row.evidence_kind,
    };
    const id = (kind: KnowledgeGraphAmbiguityKind) => this.ambiguityId(projectId, snapshotId, kind, row.id);
    if (row.resolution_kind === 'ambiguous_alias') {
      const candidateNodeIds = this.aliasCandidates(projectId, row.target_reference);
      return {
        ...base,
        id: id('multiple_candidate_targets'),
        ambiguityKind: 'multiple_candidate_targets',
        severity: candidateNodeIds.length >= 2 ? 'review' : 'warning',
        candidateNodeIds,
        message: `A deferred ${row.relationship_type} relationship has ${plural(candidateNodeIds.length, 'candidate target')} and was not materialized.`,
        detail: { ...detail, candidateNodeIds },
      };
    }
    if (row.resolution_kind === 'external_reference') {
      return {
        ...base,
        id: id('external_reference_unresolved'),
        ambiguityKind: 'external_reference_unresolved',
        severity: 'info',
        message: `A deferred ${row.relationship_type} relationship points outside the project and was not materialized.`,
        detail,
      };
    }
    return {
      ...base,
      id: id('generated_relationship_deferred'),
      ambiguityKind: 'generated_relationship_deferred',
      severity: 'info',
      message: `A ${row.resolution_kind.replace(/_/g, ' ')} ${row.relationship_type} relationship was deferred instead of materialized.`,
      detail,
    };
  }

  private symbolNodeId(projectId: string, sourceVersionId: string, symbolId: string | null): string | null {
    if (!symbolId) return null;
    const row = this.db
      .prepare(
        `SELECT id FROM knowledge_graph_nodes
         WHERE project_id = ? AND source_kind = 'deterministic_symbol' AND source_version_id = ? AND source_id = ?
         ORDER BY id LIMIT 1`,
      )
      .get(projectId, sourceVersionId, `${sourceVersionId}:${symbolId}`) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Existing symbol nodes only; the reference text is used for lookup and is never stored. */
  private aliasCandidates(projectId: string, reference: string | null): string[] {
    const text = reference?.trim();
    if (!text) return [];
    const rows = this.db
      .prepare(
        `SELECT nodes.id
         FROM knowledge_graph_nodes nodes
         JOIN knowledge_source_versions versions
           ON versions.project_id = nodes.project_id AND versions.id = nodes.source_version_id
         WHERE nodes.project_id = ? AND nodes.source_kind = 'deterministic_symbol'
           AND (nodes.qualified_name = ? OR nodes.label = ?)
           AND versions.version_number = (
             SELECT MAX(latest.version_number) FROM knowledge_source_versions latest
             WHERE latest.project_id = versions.project_id AND latest.source_id = versions.source_id
           )
         ORDER BY nodes.id
         LIMIT ?`,
      )
      .all(projectId, text, text, MAX_AMBIGUITY_CANDIDATES) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private collectEdgeAmbiguities(
    projectId: string,
    snapshotId: string | null,
    drafts: AmbiguityDraft[],
  ): { materialized: number; downgraded: number; withProvenance: number; missingProvenance: number; sanitized: number } {
    const versionByNode = new Map(
      (
        this.db
          .prepare('SELECT id, source_version_id FROM knowledge_graph_nodes WHERE project_id = ?')
          .all(projectId) as Array<{ id: string; source_version_id: string | null }>
      ).map((row) => [row.id, row.source_version_id]),
    );
    const counts = { materialized: 0, downgraded: 0, withProvenance: 0, missingProvenance: 0, sanitized: 0 };
    for (const edge of this.graph.listGraphEdges(projectId)) {
      counts.materialized += 1;
      const versionId =
        versionByNode.get(edge.sourceNodeId) ??
        edge.provenance.find((reference) => reference.sourceVersionId)?.sourceVersionId ??
        null;
      const base = {
        sourceVersionId: versionId,
        sourceNodeId: edge.sourceNodeId as string,
        targetNodeId: edge.targetNodeId as string,
        relatedEdgeIds: [edge.id],
      };
      const id = (kind: KnowledgeGraphAmbiguityKind) => this.ambiguityId(projectId, snapshotId, kind, edge.id);
      if (edge.provenance.length === 0) {
        counts.missingProvenance += 1;
        drafts.push({
          ...base,
          id: id('provenance_missing'),
          ambiguityKind: 'provenance_missing',
          severity: 'warning',
          message: `A ${edge.edgeType} edge has no provenance.`,
          detail: { relatedEdgeIds: [edge.id], relationType: edge.edgeType },
        });
        continue;
      }
      counts.withProvenance += 1;
      const originalRelation = this.originalRelationType(edge.edgeType, edge.provenance);
      if (originalRelation !== null) {
        counts.downgraded += 1;
        drafts.push({
          ...base,
          id: id('downgraded_relation_type'),
          ambiguityKind: 'downgraded_relation_type',
          severity: 'warning',
          message: `A relation was downgraded to ${edge.edgeType}${originalRelation ? ` (original: ${originalRelation})` : ''}.`,
          detail: { relatedEdgeIds: [edge.id], relationType: edge.edgeType, ...(originalRelation ? { originalRelationType: originalRelation } : {}) },
        });
      }
      if (edge.provenance.some((reference) => this.hasLegacyOmission(reference.metadata))) {
        counts.sanitized += 1;
        drafts.push({
          ...base,
          id: id('legacy_metadata_omitted'),
          ambiguityKind: 'legacy_metadata_omitted',
          severity: 'warning',
          message: `Legacy provenance metadata on a ${edge.edgeType} edge was omitted during normalization.`,
          detail: { relatedEdgeIds: [edge.id], relationType: edge.edgeType },
        });
      }
    }
    return counts;
  }

  /** Returns the bounded original relation label for a generic fallback edge, or null when the edge is not downgraded. */
  private originalRelationType(
    edgeType: string,
    provenance: ReadonlyArray<{ metadata?: Record<string, unknown> }>,
  ): string | null {
    if (edgeType !== 'related_to') return null;
    for (const reference of provenance) {
      const original = reference.metadata?.originalEdgeType;
      if (typeof original === 'string' && original.trim().length > 0 && original.trim() !== 'related_to') {
        return boundCoverageText(original, MAX_ORIGINAL_RELATION_LENGTH);
      }
    }
    return null;
  }

  private hasLegacyOmission(metadata: Record<string, unknown> | undefined): boolean {
    const diagnostic = metadata?.diagnostic;
    return typeof diagnostic === 'string' && diagnostic.startsWith(LEGACY_METADATA_MARKER);
  }

  private ambiguityId(projectId: string, snapshotId: string | null, kind: string, subject: string): string {
    return createKnowledgeId('graph-ambiguity', `${projectId}:${snapshotId ?? 'live'}:${kind}:${subject}`);
  }

  private buildWarnings(
    projectId: string,
    snapshotId: string | null,
    report: Omit<KnowledgeGraphCompletenessReport, 'createdAt'>,
    sanitizedEdgeCount: number,
  ): GraphCompletenessWarning[] {
    const warnings: GraphCompletenessWarning[] = [];
    const { sources, relationships, provenance } = report;
    if (sources.partialCount + sources.unsupportedCount + sources.legacyUnknownCount > 0) {
      warnings.push({
        code: 'partial_source_coverage',
        message:
          `${plural(sources.partialCount, 'partial')}, ${plural(sources.unsupportedCount, 'unsupported')}, and ` +
          `${plural(sources.legacyUnknownCount, 'legacy unknown')} of ${plural(sources.activeCount, 'active source')} ` +
          'are not fully covered by analyzers.',
      });
    }
    if (relationships.deferredCount > 0) {
      warnings.push({
        code: 'deferred_relationships_present',
        message: `${plural(relationships.deferredCount, 'relationship')} were deferred and are not graph edges.`,
      });
    }
    if (relationships.downgradedCount > 0) {
      warnings.push({
        code: 'downgraded_relation_types',
        message: `${plural(relationships.downgradedCount, 'edge')} fell back to a generic relation type.`,
      });
    }
    if (provenance.edgeMissingProvenanceCount + sanitizedEdgeCount > 0) {
      warnings.push({
        code: 'legacy_provenance_omitted',
        message:
          `${plural(provenance.edgeMissingProvenanceCount, 'edge')} lack provenance and ` +
          `${plural(sanitizedEdgeCount, 'edge')} had legacy provenance metadata omitted.`,
      });
    }
    if (snapshotId !== null && this.isSnapshotStale(projectId, snapshotId)) {
      warnings.push({
        code: 'graph_snapshot_stale',
        message: 'The graph changed after this snapshot was taken.',
      });
    }
    return warnings;
  }

  private isSnapshotStale(projectId: string, snapshotId: string): boolean {
    const snapshot = this.db
      .prepare('SELECT created_at FROM knowledge_graph_snapshots WHERE project_id = ? AND id = ?')
      .get(projectId, snapshotId) as { created_at: string } | undefined;
    const latest = this.db
      .prepare(
        `SELECT MAX(changed) AS changed FROM (
           SELECT MAX(updated_at) AS changed FROM knowledge_graph_nodes WHERE project_id = ?
           UNION ALL
           SELECT MAX(updated_at) AS changed FROM knowledge_graph_edges WHERE project_id = ?
         )`,
      )
      .get(projectId, projectId) as { changed: string | null };
    if (!snapshot || !latest.changed) return false;
    const snapshotTime = Date.parse(snapshot.created_at);
    const changedTime = Date.parse(latest.changed);
    return Number.isFinite(snapshotTime) && Number.isFinite(changedTime) && changedTime > snapshotTime;
  }

  /** Keeps the stored timestamp when recomputation produces an identical report so re-reporting is idempotent. */
  private persistReport(
    projectId: string,
    snapshotId: string | null,
    body: Omit<KnowledgeGraphCompletenessReport, 'createdAt'>,
  ): KnowledgeGraphCompletenessReport {
    const id = this.reportId(projectId, snapshotId);
    const existingRow = this.db
      .prepare('SELECT report_json FROM knowledge_graph_reports WHERE project_id = ? AND id = ?')
      .get(projectId, id) as { report_json: string } | undefined;
    const existing = existingRow ? parseStoredReport(existingRow.report_json) : null;
    if (existing) {
      const { createdAt, ...existingBody } = existing;
      if (JSON.stringify(existingBody) === JSON.stringify(body)) return { ...existingBody, createdAt };
    }
    const report: KnowledgeGraphCompletenessReport = { ...body, createdAt: this.now() };
    this.db
      .prepare(
        `INSERT INTO knowledge_graph_reports (id, project_id, graph_snapshot_id, report_json, created_at)
         VALUES (@id, @projectId, @snapshotId, @reportJson, @createdAt)
         ON CONFLICT(id) DO UPDATE SET report_json = excluded.report_json, created_at = excluded.created_at`,
      )
      .run({ id, projectId, snapshotId, reportJson: JSON.stringify(report), createdAt: report.createdAt });
    return report;
  }

  private persistAmbiguities(
    projectId: string,
    snapshotId: string | null,
    drafts: readonly AmbiguityDraft[],
    fallbackCreatedAt: string,
  ): void {
    const existing = new Map(
      (
        this.db
          .prepare('SELECT id, created_at FROM knowledge_graph_ambiguities WHERE project_id = ? AND graph_snapshot_id IS ?')
          .all(projectId, snapshotId) as Array<{ id: string; created_at: string }>
      ).map((row) => [row.id, row.created_at]),
    );
    const remove = this.db.prepare('DELETE FROM knowledge_graph_ambiguities WHERE project_id = ? AND id = ?');
    const keep = new Set(drafts.map((draft) => draft.id));
    for (const id of existing.keys()) {
      if (!keep.has(id)) remove.run(projectId, id);
    }
    const upsert = this.db.prepare(
      `INSERT INTO knowledge_graph_ambiguities
       (id, project_id, graph_snapshot_id, source_version_id, source_node_id, target_node_id, ambiguity_kind, severity,
        detail_json, created_at)
       VALUES (@id, @projectId, @snapshotId, @sourceVersionId, @sourceNodeId, @targetNodeId, @kind, @severity,
               @detailJson, @createdAt)
       ON CONFLICT(id) DO UPDATE SET
         source_version_id = excluded.source_version_id,
         source_node_id = excluded.source_node_id,
         target_node_id = excluded.target_node_id,
         ambiguity_kind = excluded.ambiguity_kind,
         severity = excluded.severity,
         detail_json = excluded.detail_json`,
    );
    for (const draft of drafts) {
      upsert.run({
        id: draft.id,
        projectId,
        snapshotId,
        sourceVersionId: draft.sourceVersionId,
        sourceNodeId: draft.sourceNodeId,
        targetNodeId: draft.targetNodeId,
        kind: draft.ambiguityKind,
        severity: draft.severity,
        detailJson: JSON.stringify({ message: draft.message, ...draft.detail }),
        createdAt: existing.get(draft.id) ?? fallbackCreatedAt,
      });
    }
  }
}
