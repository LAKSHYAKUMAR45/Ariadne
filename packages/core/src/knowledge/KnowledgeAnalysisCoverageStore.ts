import type Database from 'better-sqlite3';
import {
  ANALYZER_COVERAGE_STATUSES,
  ANALYZER_UNSUPPORTED_REASONS,
  boundCoverageDiagnostics,
  boundCoverageFeatures,
  boundCoverageText,
  type AnalyzerCoverageStatus,
  type AnalyzerCoverageSummary,
  type AnalyzerUnsupportedReason,
} from './analyzers/AnalyzerCoverage.js';
import { sanitizeProvenanceMetadata } from './GraphMetadata.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import {
  DEFERRED_EVIDENCE_KINDS,
  DEFERRED_RESOLUTION_KINDS,
  isExtractedRelationshipType,
  tryValidateSourceSpan,
  type DeferredRelationshipCandidate,
  type DeferredRelationshipEvidenceKind,
  type DeferredRelationshipResolutionKind,
  type ExtractedRelationshipType,
  type ExtractionDiagnostic,
} from './KnowledgeExtraction.js';
import { knowledgeSourceSpanId } from './KnowledgeExtractionStore.js';

export const MAX_DEFERRED_RELATIONSHIPS_PER_SOURCE = 200;
const MAX_DEFERRED_TEXT_LENGTH = 512;

export interface KnowledgeAnalysisCoverageRecord {
  id: string;
  projectId: string;
  sourceVersionId: string;
  status: AnalyzerCoverageStatus;
  analyzerId: string | null;
  analyzerVersion: string | null;
  generatedCode: boolean;
  generatedReason: string | null;
  unsupportedReason: AnalyzerUnsupportedReason | null;
  supportedFeatures: string[];
  missingFeatures: string[];
  diagnostics: ExtractionDiagnostic[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDeferredRelationshipRecord {
  id: string;
  projectId: string;
  sourceVersionId: string;
  relationshipType: ExtractedRelationshipType;
  sourceSymbolId: string | null;
  targetSymbolId: string | null;
  targetReference: string | null;
  resolutionKind: DeferredRelationshipResolutionKind;
  evidenceKind: DeferredRelationshipEvidenceKind;
  confidence: number;
  spanId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface KnowledgeAnalysisCoverageSummaryCounts {
  supported: number;
  partial: number;
  unsupported: number;
  failed: number;
  /** Source versions with no coverage row; they read as `legacy_unknown` until reprocessed. */
  legacyUnknown: number;
  deferredRelationships: number;
}

interface CoverageRow {
  id: string;
  project_id: string;
  source_version_id: string;
  status: AnalyzerCoverageStatus;
  analyzer_id: string | null;
  analyzer_version: string | null;
  generated_code: number;
  generated_reason: string | null;
  unsupported_reason: AnalyzerUnsupportedReason | null;
  supported_features_json: string;
  missing_features_json: string;
  diagnostics_json: string;
  created_at: string;
  updated_at: string;
}

interface DeferredRow {
  id: string;
  project_id: string;
  source_version_id: string;
  relationship_type: ExtractedRelationshipType;
  source_symbol_id: string | null;
  target_symbol_id: string | null;
  target_reference: string | null;
  resolution_kind: DeferredRelationshipResolutionKind;
  evidence_kind: DeferredRelationshipEvidenceKind;
  confidence: number;
  span_id: string | null;
  metadata_json: string;
  created_at: string;
}

interface NormalizedCandidate {
  id: string;
  type: ExtractedRelationshipType;
  sourceSymbolId: string | null;
  targetSymbolId: string | null;
  targetReference: string | null;
  resolutionKind: DeferredRelationshipResolutionKind;
  evidenceKind: DeferredRelationshipEvidenceKind;
  confidence: number;
  span: ReturnType<typeof tryValidateSourceSpan>;
  metadata: Record<string, unknown>;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const bounded = boundCoverageText(value, maxLength);
  return bounded.length > 0 ? bounded : null;
}

function safeMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  try {
    return sanitizeProvenanceMetadata(value, 'Deferred relationship metadata') ?? {};
  } catch {
    return {};
  }
}

function normalizeCandidate(candidate: DeferredRelationshipCandidate): NormalizedCandidate | null {
  if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) return null;
  if (!isExtractedRelationshipType(candidate.type)) return null;
  if (!DEFERRED_RESOLUTION_KINDS.includes(candidate.resolutionKind)) return null;
  if (!DEFERRED_EVIDENCE_KINDS.includes(candidate.evidenceKind)) return null;
  if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence)) return null;
  if (candidate.confidence < 0 || candidate.confidence > 1) return null;
  const targetSymbolId = optionalText(candidate.targetSymbolId, MAX_DEFERRED_TEXT_LENGTH);
  const targetReference = optionalText(candidate.targetReference, MAX_DEFERRED_TEXT_LENGTH);
  if (targetSymbolId === null && targetReference === null) return null;
  const span = candidate.span === null || candidate.span === undefined ? null : tryValidateSourceSpan(candidate.span);
  if (candidate.span !== null && candidate.span !== undefined && span === null) return null;
  return {
    id: candidate.id.trim(),
    type: candidate.type,
    sourceSymbolId: optionalText(candidate.sourceSymbolId, MAX_DEFERRED_TEXT_LENGTH),
    targetSymbolId,
    targetReference,
    resolutionKind: candidate.resolutionKind,
    evidenceKind: candidate.evidenceKind,
    confidence: candidate.confidence,
    span,
    metadata: safeMetadata(candidate.metadata),
  };
}

function parseJsonArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toCoverageRecord(row: CoverageRow): KnowledgeAnalysisCoverageRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceVersionId: row.source_version_id,
    status: row.status,
    analyzerId: row.analyzer_id,
    analyzerVersion: row.analyzer_version,
    generatedCode: row.generated_code === 1,
    generatedReason: row.generated_reason,
    unsupportedReason: row.unsupported_reason,
    supportedFeatures: parseJsonArray<string>(row.supported_features_json),
    missingFeatures: parseJsonArray<string>(row.missing_features_json),
    diagnostics: parseJsonArray<ExtractionDiagnostic>(row.diagnostics_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDeferredRecord(row: DeferredRow): KnowledgeDeferredRelationshipRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceVersionId: row.source_version_id,
    relationshipType: row.relationship_type,
    sourceSymbolId: row.source_symbol_id,
    targetSymbolId: row.target_symbol_id,
    targetReference: row.target_reference,
    resolutionKind: row.resolution_kind,
    evidenceKind: row.evidence_kind,
    confidence: row.confidence,
    spanId: row.span_id,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

export class KnowledgeAnalysisCoverageStore {
  private readonly now: () => string;

  public constructor(
    private readonly db: Database.Database,
    options: { now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Writes the single coverage row for a source version; reanalysis updates it in place. */
  public upsert(input: {
    projectId: string;
    sourceVersionId: string;
    coverage: AnalyzerCoverageSummary;
  }): KnowledgeAnalysisCoverageRecord {
    const { projectId, sourceVersionId, coverage } = input;
    if (!ANALYZER_COVERAGE_STATUSES.includes(coverage.status)) {
      throw new Error(`Knowledge coverage status is invalid: ${String(coverage.status)}`);
    }
    if (coverage.unsupportedReason !== undefined && !ANALYZER_UNSUPPORTED_REASONS.includes(coverage.unsupportedReason)) {
      throw new Error(`Knowledge coverage unsupported reason is invalid: ${String(coverage.unsupportedReason)}`);
    }
    this.requireSourceVersion(projectId, sourceVersionId);
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO knowledge_analysis_coverage
         (id, project_id, source_version_id, status, analyzer_id, analyzer_version, generated_code, generated_reason,
          unsupported_reason, supported_features_json, missing_features_json, diagnostics_json, created_at, updated_at)
         VALUES (@id, @projectId, @sourceVersionId, @status, @analyzerId, @analyzerVersion, @generatedCode,
                 @generatedReason, @unsupportedReason, @supportedFeatures, @missingFeatures, @diagnostics, @now, @now)
         ON CONFLICT (project_id, source_version_id) DO UPDATE SET
           status = excluded.status,
           analyzer_id = excluded.analyzer_id,
           analyzer_version = excluded.analyzer_version,
           generated_code = excluded.generated_code,
           generated_reason = excluded.generated_reason,
           unsupported_reason = excluded.unsupported_reason,
           supported_features_json = excluded.supported_features_json,
           missing_features_json = excluded.missing_features_json,
           diagnostics_json = excluded.diagnostics_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: createKnowledgeId('coverage', `${projectId}:${sourceVersionId}`),
        projectId,
        sourceVersionId,
        status: coverage.status,
        analyzerId: optionalText(coverage.analyzerId, MAX_DEFERRED_TEXT_LENGTH),
        analyzerVersion: optionalText(coverage.analyzerVersion, MAX_DEFERRED_TEXT_LENGTH),
        generatedCode: coverage.generatedCode ? 1 : 0,
        generatedReason: optionalText(coverage.generatedReason, MAX_DEFERRED_TEXT_LENGTH),
        unsupportedReason: coverage.unsupportedReason ?? null,
        supportedFeatures: JSON.stringify(boundCoverageFeatures(coverage.supportedFeatures)),
        missingFeatures: JSON.stringify(boundCoverageFeatures(coverage.missingFeatures)),
        diagnostics: JSON.stringify(boundCoverageDiagnostics(coverage.warnings)),
        now: timestamp,
      });
    const record = this.get(projectId, sourceVersionId);
    if (!record) throw new Error(`Knowledge coverage row was not persisted for ${sourceVersionId}`);
    return record;
  }

  public get(projectId: string, sourceVersionId: string): KnowledgeAnalysisCoverageRecord | null {
    const row = this.db
      .prepare('SELECT * FROM knowledge_analysis_coverage WHERE project_id = ? AND source_version_id = ?')
      .get(projectId, sourceVersionId) as CoverageRow | undefined;
    return row ? toCoverageRecord(row) : null;
  }

  /**
   * Replaces the deferred candidates of a source version. Invalid, duplicate, and over-limit candidates are dropped
   * and counted; nothing here creates graph nodes or edges.
   */
  public replaceDeferredRelationships(input: {
    projectId: string;
    sourceVersionId: string;
    candidates: readonly DeferredRelationshipCandidate[];
  }): { stored: number; dropped: number } {
    const { projectId, sourceVersionId } = input;
    return this.db.transaction(() => {
      this.requireSourceVersion(projectId, sourceVersionId);
      const seen = new Set<string>();
      const accepted: NormalizedCandidate[] = [];
      let dropped = 0;
      for (const raw of input.candidates) {
        const candidate = normalizeCandidate(raw);
        if (candidate === null || seen.has(candidate.id) || accepted.length >= MAX_DEFERRED_RELATIONSHIPS_PER_SOURCE) {
          dropped += 1;
          continue;
        }
        seen.add(candidate.id);
        accepted.push(candidate);
      }
      this.db
        .prepare('DELETE FROM knowledge_deferred_relationships WHERE project_id = ? AND source_version_id = ?')
        .run(projectId, sourceVersionId);
      const insertSpan = this.db.prepare(
        `INSERT OR IGNORE INTO knowledge_source_spans
         (id, project_id, source_version_id, start_offset, end_offset, start_line, start_column, end_line, end_column, label, created_at)
         VALUES (@id, @projectId, @sourceVersionId, @startOffset, @endOffset, @startLine, @startColumn, @endLine, @endColumn, @label, @now)`,
      );
      const insert = this.db.prepare(
        `INSERT INTO knowledge_deferred_relationships
         (id, project_id, source_version_id, relationship_type, source_symbol_id, target_symbol_id, target_reference,
          resolution_kind, evidence_kind, confidence, span_id, metadata_json, created_at)
         VALUES (@id, @projectId, @sourceVersionId, @type, @sourceSymbolId, @targetSymbolId, @targetReference,
                 @resolutionKind, @evidenceKind, @confidence, @spanId, @metadata, @now)`,
      );
      const timestamp = this.now();
      for (const candidate of accepted) {
        let spanId: string | null = null;
        if (candidate.span) {
          spanId = knowledgeSourceSpanId(sourceVersionId, candidate.span);
          insertSpan.run({
            id: spanId,
            projectId,
            sourceVersionId,
            startOffset: candidate.span.startOffset,
            endOffset: candidate.span.endOffset,
            startLine: candidate.span.startLine,
            startColumn: candidate.span.startColumn,
            endLine: candidate.span.endLine,
            endColumn: candidate.span.endColumn,
            label: candidate.span.label ?? null,
            now: timestamp,
          });
        }
        insert.run({
          id: createKnowledgeId('deferred', `${projectId}:${sourceVersionId}:${candidate.id}`),
          projectId,
          sourceVersionId,
          type: candidate.type,
          sourceSymbolId: candidate.sourceSymbolId,
          targetSymbolId: candidate.targetSymbolId,
          targetReference: candidate.targetReference,
          resolutionKind: candidate.resolutionKind,
          evidenceKind: candidate.evidenceKind,
          confidence: candidate.confidence,
          spanId,
          metadata: JSON.stringify(candidate.metadata),
          now: timestamp,
        });
      }
      return { stored: accepted.length, dropped };
    })();
  }

  public listDeferredRelationships(projectId: string, sourceVersionId: string): KnowledgeDeferredRelationshipRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_deferred_relationships
         WHERE project_id = ? AND source_version_id = ?
         ORDER BY rowid`,
      )
      .all(projectId, sourceVersionId) as DeferredRow[];
    return rows.map(toDeferredRecord);
  }

  /** Counts only; never returns diagnostics text, paths, or source content. */
  public summarize(projectId: string): KnowledgeAnalysisCoverageSummaryCounts {
    const byStatus = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM knowledge_analysis_coverage WHERE project_id = ? GROUP BY status')
      .all(projectId) as Array<{ status: AnalyzerCoverageStatus; count: number }>;
    const counts = new Map(byStatus.map((row) => [row.status, row.count]));
    const legacy = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM knowledge_source_versions v
         LEFT JOIN knowledge_analysis_coverage c
           ON c.project_id = v.project_id AND c.source_version_id = v.id
         WHERE v.project_id = ? AND c.id IS NULL`,
      )
      .get(projectId) as { count: number };
    const deferred = this.db
      .prepare('SELECT COUNT(*) AS count FROM knowledge_deferred_relationships WHERE project_id = ?')
      .get(projectId) as { count: number };
    return {
      supported: counts.get('supported') ?? 0,
      partial: counts.get('partial') ?? 0,
      unsupported: counts.get('unsupported') ?? 0,
      failed: counts.get('failed') ?? 0,
      legacyUnknown: legacy.count,
      deferredRelationships: deferred.count,
    };
  }

  private requireSourceVersion(projectId: string, sourceVersionId: string): void {
    const row = this.db
      .prepare('SELECT 1 AS present FROM knowledge_source_versions WHERE project_id = ? AND id = ?')
      .get(projectId, sourceVersionId) as { present: number } | undefined;
    if (!row) {
      throw new Error(`Knowledge source version not found in project ${projectId}: ${sourceVersionId}`);
    }
  }
}
