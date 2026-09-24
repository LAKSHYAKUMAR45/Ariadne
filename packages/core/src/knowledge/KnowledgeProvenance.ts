import type Database from 'better-sqlite3';
import { createKnowledgeId } from './KnowledgeIds.js';
import type { KnowledgeProvenanceKind, KnowledgeProvenanceRef } from './KnowledgeTypes.js';

const PROVENANCE_KINDS = new Set<KnowledgeProvenanceKind>([
  'task',
  'checkpoint',
  'decision',
  'file',
  'commit',
  'source',
  'page',
]);

interface KnowledgeProvenanceRow {
  source_kind: KnowledgeProvenanceKind;
  source_id: string;
  confidence: number;
}

export interface RecordKnowledgeProvenanceInput extends KnowledgeProvenanceRef {
  projectId: string;
  targetId: string;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Knowledge provenance ${label} must not be empty`);
  }
}

function validateReference(reference: RecordKnowledgeProvenanceInput): void {
  requireNonEmpty(reference.projectId, 'project ID');
  requireNonEmpty(reference.targetId, 'target ID');
  requireNonEmpty(reference.id, 'source ID');

  if (!PROVENANCE_KINDS.has(reference.kind)) {
    throw new Error(`Unsupported knowledge provenance kind: ${reference.kind}`);
  }

  if (
    reference.confidence !== undefined &&
    (!Number.isFinite(reference.confidence) || reference.confidence < 0 || reference.confidence > 1)
  ) {
    throw new Error('Knowledge provenance confidence must be between 0 and 1');
  }
}

/**
 * Persists page-version provenance in the knowledge schema. The source can
 * originate in either Ariadne task state or imported knowledge content, so
 * source references intentionally remain foreign-key-like rather than direct
 * cross-domain foreign keys.
 */
export class KnowledgeProvenance {
  constructor(private readonly db: Database.Database) {}

  recordKnowledgeProvenance(reference: RecordKnowledgeProvenanceInput): void {
    validateReference(reference);

    this.db
      .prepare(
        `INSERT INTO knowledge_page_provenance (
          id, project_id, page_version_id, source_kind, source_id, confidence, created_at
        )
        SELECT @id, @projectId, @targetId, @kind, @sourceId, @confidence, @createdAt
        WHERE NOT EXISTS (
          SELECT 1
          FROM knowledge_page_provenance
          WHERE project_id = @projectId
            AND page_version_id = @targetId
            AND source_kind = @kind
            AND source_id = @sourceId
            AND confidence = @confidence
        )`,
      )
      .run({
        id: createKnowledgeId('provenance'),
        projectId: reference.projectId,
        targetId: reference.targetId,
        kind: reference.kind,
        sourceId: reference.id,
        confidence: reference.confidence ?? 1,
        createdAt: new Date().toISOString(),
      });
  }

  listKnowledgeProvenance(targetId: string): KnowledgeProvenanceRef[] {
    requireNonEmpty(targetId, 'target ID');

    const rows = this.db
      .prepare(
        `SELECT source_kind, source_id, confidence
         FROM knowledge_page_provenance
         WHERE page_version_id = ?
        ORDER BY rowid ASC`,
      )
      .all(targetId) as KnowledgeProvenanceRow[];

    return rows.map((row) => ({
      kind: row.source_kind,
      id: row.source_id,
      confidence: row.confidence,
    }));
  }
}
