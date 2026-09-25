import type Database from 'better-sqlite3';
import { redactLines } from '../Redactor.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import {
  canonicalizeDeterministicExtraction,
  hashDeterministicExtraction,
  stableExtractionStringify,
  validateDeterministicExtraction,
  type DeterministicExtraction,
  type ExtractionDiagnostic,
  type ExtractedSection,
  type KnowledgeSourceSpan,
} from './KnowledgeExtraction.js';

export {
  offsetToPosition,
  validateDeterministicExtraction,
  type DeterministicExtraction,
  type ExtractedLink,
  type ExtractedRelationship,
  type ExtractedRelationshipType,
  type ExtractedSection,
  type ExtractedSymbol,
  type ExtractedSymbolKind,
  type ExtractionDiagnostic,
  type ExtractionDiagnosticSeverity,
  type KnowledgeSourcePosition,
  type KnowledgeSourceSpan,
} from './KnowledgeExtraction.js';

export interface SaveKnowledgeExtractionInput {
  projectId: string;
  extraction: DeterministicExtraction;
  extractorKind?: string;
  completedAt?: string;
}

export interface PersistedKnowledgeSourceSpan extends KnowledgeSourceSpan {
  id: string;
}

export interface KnowledgeExtractionSectionRecord extends Omit<ExtractedSection, 'span'> {
  extractionId: string;
  projectId: string;
  sourceVersionId: string;
  analyzerId: string;
  analyzerVersion: string;
  span: PersistedKnowledgeSourceSpan;
}

export interface KnowledgeExtractionRecord {
  id: string;
  projectId: string;
  sourceVersionId: string;
  extractorKind: string;
  analyzerId: string;
  analyzerVersion: string;
  extractionHash: string;
  extraction: DeterministicExtraction;
  diagnostics: ExtractionDiagnostic[];
  sections: KnowledgeExtractionSectionRecord[];
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

interface KnowledgeExtractionRow {
  id: string;
  project_id: string;
  source_version_id: string;
  extractor_kind: string;
  analyzer_id: string | null;
  analyzer_version: string | null;
  extraction_hash: string | null;
  result_json: string | null;
  diagnostics_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class KnowledgeExtractionStoreError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KnowledgeExtractionStoreError';
  }
}

function now(): string {
  return new Date().toISOString();
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  return trimmed;
}

function spanSeed(sourceVersionId: string, span: KnowledgeSourceSpan): string {
  return JSON.stringify({
    sourceVersionId,
    startOffset: span.startOffset,
    endOffset: span.endOffset,
    startLine: span.startLine,
    startColumn: span.startColumn,
    endLine: span.endLine,
    endColumn: span.endColumn,
    label: span.label ?? null,
  });
}

function spanId(sourceVersionId: string, span: KnowledgeSourceSpan): string {
  return createKnowledgeId('source-span', spanSeed(sourceVersionId, span));
}

function extractionId(
  projectId: string,
  sourceVersionId: string,
  extractorKind: string,
  analyzerId: string,
  analyzerVersion: string,
): string {
  return createKnowledgeId(
    'extraction',
    [projectId, sourceVersionId, extractorKind, analyzerId, analyzerVersion].join(':'),
  );
}

function resultPath(
  sourceVersionId: string,
  extractorKind: string,
  analyzerId: string,
  analyzerVersion: string,
): string {
  return `knowledge/extractions/${sourceVersionId}/${extractorKind}/${analyzerId}-${analyzerVersion}.json`;
}

function hasNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCompleteRow(row: KnowledgeExtractionRow): boolean {
  return (
    hasNonEmptyString(row.analyzer_id) &&
    hasNonEmptyString(row.analyzer_version) &&
    hasNonEmptyString(row.extraction_hash) &&
    hasNonEmptyString(row.result_json) &&
    hasNonEmptyString(row.completed_at)
  );
}

function redactOptionalString(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return redactLines(value);
}

function redactPersistedSpan(span: KnowledgeSourceSpan): KnowledgeSourceSpan {
  return {
    ...span,
    label: redactOptionalString(span.label) ?? undefined,
  };
}

function redactPersistedExtraction(extraction: DeterministicExtraction): DeterministicExtraction {
  return canonicalizeDeterministicExtraction({
    ...extraction,
    title: redactLines(extraction.title),
    summary: redactLines(extraction.summary),
    sections: extraction.sections.map((section) => ({
      ...section,
      title: redactOptionalString(section.title) ?? undefined,
      text: redactLines(section.text),
      span: redactPersistedSpan(section.span),
    })),
    symbols: extraction.symbols.map((symbol) => ({
      ...symbol,
      name: redactLines(symbol.name),
      qualifiedName: redactOptionalString(symbol.qualifiedName) ?? undefined,
      signature: redactOptionalString(symbol.signature) ?? undefined,
      detail: redactOptionalString(symbol.detail) ?? undefined,
      span: redactPersistedSpan(symbol.span),
    })),
    relationships: extraction.relationships.map((relationship) => ({
      ...relationship,
      detail: redactOptionalString(relationship.detail) ?? undefined,
      span: relationship.span ? redactPersistedSpan(relationship.span) : relationship.span,
    })),
    links: extraction.links.map((link) => ({
      ...link,
      target: redactLines(link.target),
      title: redactOptionalString(link.title) ?? undefined,
      span: link.span ? redactPersistedSpan(link.span) : link.span,
    })),
    diagnostics: extraction.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: redactLines(diagnostic.message),
      span: diagnostic.span ? redactPersistedSpan(diagnostic.span) : diagnostic.span,
    })),
  });
}

function parsePersistedExtraction(row: KnowledgeExtractionRow): DeterministicExtraction {
  if (!row.result_json) throw new Error(`Extraction ${row.id} is missing result_json`);
  try {
    return validateDeterministicExtraction(JSON.parse(row.result_json) as unknown);
  } catch (error: unknown) {
    throw new KnowledgeExtractionStoreError(`KnowledgeExtractionStore could not parse result_json for extraction ${row.id}`, {
      cause: error,
    });
  }
}

function parsePersistedDiagnostics(
  _row: KnowledgeExtractionRow,
  extraction: DeterministicExtraction,
): ExtractionDiagnostic[] {
  return extraction.diagnostics;
}

function loadSections(
  extractionIdValue: string,
  projectId: string,
  extraction: DeterministicExtraction,
): KnowledgeExtractionSectionRecord[] {
  return extraction.sections.map((section) => ({
    extractionId: extractionIdValue,
    projectId,
    sourceVersionId: extraction.sourceVersionId,
    analyzerId: extraction.analyzerId,
    analyzerVersion: extraction.analyzerVersion,
    id: section.id,
    kind: section.kind,
    title: section.title ?? null,
    text: section.text,
    span: {
      ...section.span,
      label: section.span.label ?? null,
      id: spanId(extraction.sourceVersionId, section.span),
    },
  }));
}

function rowToRecord(row: KnowledgeExtractionRow): KnowledgeExtractionRecord {
  if (!isCompleteRow(row)) {
    throw new KnowledgeExtractionStoreError(`KnowledgeExtractionStore encountered incomplete extraction row ${row.id}`);
  }
  const extraction = parsePersistedExtraction(row);
  return {
    id: row.id,
    projectId: row.project_id,
    sourceVersionId: row.source_version_id,
    extractorKind: row.extractor_kind,
    analyzerId: requireNonEmpty(row.analyzer_id ?? '', 'analyzer_id'),
    analyzerVersion: requireNonEmpty(row.analyzer_version ?? '', 'analyzer_version'),
    extractionHash: requireNonEmpty(row.extraction_hash ?? '', 'extraction_hash'),
    extraction,
    diagnostics: parsePersistedDiagnostics(row, extraction),
    sections: loadSections(row.id, row.project_id, extraction),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: requireNonEmpty(row.completed_at ?? '', 'completed_at'),
  };
}

export class KnowledgeExtractionStore {
  public constructor(private readonly db: Database.Database) {}

  public save(input: SaveKnowledgeExtractionInput): KnowledgeExtractionRecord {
    const projectId = requireNonEmpty(input.projectId, 'projectId');
    const extractorKind = requireNonEmpty(input.extractorKind ?? 'deterministic', 'extractorKind');
    const extraction = redactPersistedExtraction(
      canonicalizeDeterministicExtraction(validateDeterministicExtraction(input.extraction)),
    );
    const timestamp = input.completedAt ?? now();
    const extractionHash = hashDeterministicExtraction(extraction);
    const extractionIdValue = extractionId(
      projectId,
      extraction.sourceVersionId,
      extractorKind,
      extraction.analyzerId,
      extraction.analyzerVersion,
    );
    const serializedResult = stableExtractionStringify(extraction);
    const serializedDiagnostics = JSON.stringify(extraction.diagnostics);

    const save = this.db.transaction(() => {
      this.ensureSourceVersion(projectId, extraction.sourceVersionId);
      this.persistSpans(projectId, extraction.sourceVersionId, extraction);
      const crossKindCollision = this.db
        .prepare(
          `SELECT extractor_kind
           FROM knowledge_extractions
           WHERE project_id = ?
             AND source_version_id = ?
             AND analyzer_id = ?
             AND analyzer_version = ?
             AND extractor_kind != ?
           LIMIT 1`,
        )
        .get(
          projectId,
          extraction.sourceVersionId,
          extraction.analyzerId,
          extraction.analyzerVersion,
          extractorKind,
        ) as { extractor_kind: string } | undefined;
      if (crossKindCollision) {
        throw new KnowledgeExtractionStoreError(
          `KnowledgeExtractionStore analyzer identity collision: ${extraction.analyzerId}@${extraction.analyzerVersion} is already persisted as extractor kind "${crossKindCollision.extractor_kind}" for source version ${extraction.sourceVersionId}; cannot reuse it for "${extractorKind}"`,
        );
      }
      const existing = this.db
        .prepare(
          `SELECT id, extraction_hash
           FROM knowledge_extractions
           WHERE project_id = ? AND source_version_id = ? AND extractor_kind = ? AND analyzer_id = ? AND analyzer_version = ?`,
        )
        .get(
          projectId,
          extraction.sourceVersionId,
          extractorKind,
          extraction.analyzerId,
          extraction.analyzerVersion,
        ) as { id: string; extraction_hash: string | null } | undefined;

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO knowledge_extractions (
               id,
               project_id,
               source_version_id,
               extractor_kind,
               analyzer_id,
               analyzer_version,
               result_path,
               content_hash,
               extraction_hash,
               result_json,
               diagnostics_json,
               status,
               completed_at,
               created_at,
               updated_at
             ) VALUES (
               @id,
               @projectId,
               @sourceVersionId,
               @extractorKind,
               @analyzerId,
               @analyzerVersion,
               @resultPath,
               @contentHash,
               @extractionHash,
               @resultJson,
               @diagnosticsJson,
               'completed',
               @completedAt,
               @createdAt,
               @updatedAt
             )`,
          )
          .run({
            id: extractionIdValue,
            projectId,
            sourceVersionId: extraction.sourceVersionId,
            extractorKind,
            analyzerId: extraction.analyzerId,
            analyzerVersion: extraction.analyzerVersion,
            resultPath: resultPath(
              extraction.sourceVersionId,
              extractorKind,
              extraction.analyzerId,
              extraction.analyzerVersion,
            ),
            contentHash: extractionHash,
            extractionHash,
            resultJson: serializedResult,
            diagnosticsJson: serializedDiagnostics,
            completedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
      } else if (existing.extraction_hash !== extractionHash) {
        this.db
          .prepare(
            `UPDATE knowledge_extractions
             SET result_path = @resultPath,
                 content_hash = @contentHash,
                 extraction_hash = @extractionHash,
                 result_json = @resultJson,
                 diagnostics_json = @diagnosticsJson,
                 status = 'completed',
                 completed_at = @completedAt,
                 updated_at = @updatedAt
             WHERE project_id = @projectId
               AND source_version_id = @sourceVersionId
               AND extractor_kind = @extractorKind
               AND analyzer_id = @analyzerId
               AND analyzer_version = @analyzerVersion`,
          )
          .run({
            projectId,
            sourceVersionId: extraction.sourceVersionId,
            extractorKind,
            analyzerId: extraction.analyzerId,
            analyzerVersion: extraction.analyzerVersion,
            resultPath: resultPath(
              extraction.sourceVersionId,
              extractorKind,
              extraction.analyzerId,
              extraction.analyzerVersion,
            ),
            contentHash: extractionHash,
            extractionHash,
            resultJson: serializedResult,
            diagnosticsJson: serializedDiagnostics,
            completedAt: timestamp,
            updatedAt: timestamp,
          });
      }

      return this.getByIdentity(
        projectId,
        extraction.sourceVersionId,
        extractorKind,
        extraction.analyzerId,
        extraction.analyzerVersion,
      );
    });

    return save() as KnowledgeExtractionRecord;
  }

  public getCurrent(
    projectId: string,
    sourceVersionId: string,
    analyzerId: string,
    analyzerVersion: string,
  ): KnowledgeExtractionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id,
                project_id,
                source_version_id,
                extractor_kind,
                analyzer_id,
                analyzer_version,
                extraction_hash,
                result_json,
                diagnostics_json,
                created_at,
                updated_at,
                completed_at
         FROM knowledge_extractions
         WHERE project_id = ?
           AND source_version_id = ?
           AND analyzer_id = ?
           AND analyzer_version = ?
           AND extraction_hash IS NOT NULL
           AND result_json IS NOT NULL
           AND completed_at IS NOT NULL
         ORDER BY updated_at DESC, created_at DESC, id ASC
         LIMIT 1`,
      )
      .get(projectId, sourceVersionId, analyzerId, analyzerVersion) as KnowledgeExtractionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  public listSections(projectId: string, sourceVersionId: string): KnowledgeExtractionSectionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id,
                project_id,
                source_version_id,
                extractor_kind,
                analyzer_id,
                analyzer_version,
                extraction_hash,
                result_json,
                diagnostics_json,
                created_at,
                updated_at,
                completed_at
         FROM knowledge_extractions
         WHERE project_id = ?
           AND source_version_id = ?
           AND analyzer_id IS NOT NULL
           AND analyzer_version IS NOT NULL
           AND extraction_hash IS NOT NULL
           AND result_json IS NOT NULL
           AND completed_at IS NOT NULL
         ORDER BY analyzer_id ASC, analyzer_version ASC, created_at ASC`,
      )
      .all(projectId, sourceVersionId) as KnowledgeExtractionRow[];
    return rows.flatMap((row) => rowToRecord(row).sections);
  }

  private getByIdentity(
    projectId: string,
    sourceVersionId: string,
    extractorKind: string,
    analyzerId: string,
    analyzerVersion: string,
  ): KnowledgeExtractionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id,
                project_id,
                source_version_id,
                extractor_kind,
                analyzer_id,
                analyzer_version,
                extraction_hash,
                result_json,
                diagnostics_json,
                created_at,
                updated_at,
                completed_at
         FROM knowledge_extractions
         WHERE project_id = ?
           AND source_version_id = ?
           AND extractor_kind = ?
           AND analyzer_id = ?
           AND analyzer_version = ?
           AND extraction_hash IS NOT NULL
           AND result_json IS NOT NULL
           AND completed_at IS NOT NULL
         LIMIT 1`,
      )
      .get(projectId, sourceVersionId, extractorKind, analyzerId, analyzerVersion) as KnowledgeExtractionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  private ensureSourceVersion(projectId: string, sourceVersionId: string): void {
    const row = this.db
      .prepare(
        `SELECT id
         FROM knowledge_source_versions
         WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, sourceVersionId) as { id: string } | undefined;
    if (!row) {
      throw new Error(`Knowledge source version not found: ${sourceVersionId}`);
    }
  }

  private persistSpans(projectId: string, sourceVersionId: string, extraction: DeterministicExtraction): void {
    const uniqueSpans = new Map<string, PersistedKnowledgeSourceSpan>();
    const addSpan = (span: KnowledgeSourceSpan | null | undefined): void => {
      if (!span) return;
      const id = spanId(sourceVersionId, span);
      if (!uniqueSpans.has(id)) {
        uniqueSpans.set(id, { ...span, label: span.label ?? null, id });
      }
    };

    for (const section of extraction.sections) addSpan(section.span);
    for (const symbol of extraction.symbols) addSpan(symbol.span);
    for (const relationship of extraction.relationships) addSpan(relationship.span);
    for (const link of extraction.links) addSpan(link.span);
    for (const diagnostic of extraction.diagnostics) addSpan(diagnostic.span);

    const insertSpan = this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_source_spans (
         id,
         project_id,
         source_version_id,
         start_offset,
         end_offset,
         start_line,
         start_column,
         end_line,
         end_column,
         label,
         created_at
       ) VALUES (
         @id,
         @projectId,
         @sourceVersionId,
         @startOffset,
         @endOffset,
         @startLine,
         @startColumn,
         @endLine,
         @endColumn,
         @label,
         @createdAt
       )`,
    );

    for (const span of uniqueSpans.values()) {
      insertSpan.run({
        id: span.id,
        projectId,
        sourceVersionId,
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        startLine: span.startLine,
        startColumn: span.startColumn,
        endLine: span.endLine,
        endColumn: span.endColumn,
        label: span.label ?? null,
        createdAt: now(),
      });
    }
  }
}
