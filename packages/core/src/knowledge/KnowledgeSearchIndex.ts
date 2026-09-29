import type Database from 'better-sqlite3';
import { redactLines } from '../Redactor.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import { SEARCH_TOKEN_LENGTH, foldSearchText, needleNarrowingGrams, trigramsOf } from './KnowledgeSearchTokens.js';
import {
  validateDeterministicExtraction,
  type ExtractedSymbolKind,
  type KnowledgeSourceSpan,
} from './KnowledgeExtraction.js';

/** Bump when field derivation or matching changes; every existing index becomes unusable until rebuilt. */
export const KNOWLEDGE_SEARCH_INDEX_VERSION = 1;

export const MAX_EXTRACTION_JSON_BYTES = 1_048_576;
export const MAX_EXTRACTION_SECTIONS = 200;
export const MAX_EXTRACTION_SYMBOLS = 200;
export const MAX_SEARCH_FIELDS = 800;
export const MAX_PERSISTED_SPANS = 2_000;
export const MAX_RESULT_CANDIDATES = 500;
export const EXTRACTION_MATCH_RANK_CLASS = 2;
export const METADATA_MATCH_RANK_CLASS = 1;

const MAX_LOOKUP_FIELD_CHARS = 4_096;
const MAX_NEEDLES = 128;
const MAX_NEEDLE_CHARS = 256;
const FOLD_FUNCTION = 'knowledge_fold';
const FIELD_FOLD_FUNCTION = 'knowledge_fold_field';

export type SearchIndexCoverage = 'extraction' | 'metadata_only';
export type SearchIndexRowStatus = 'active' | 'stale' | 'failed';
export type SearchIndexFieldKind = 'symbol' | 'section' | 'title' | 'summary' | 'path';

export interface PersistedSpanRow {
  id: string;
  start_offset: number;
  end_offset: number;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  label: string | null;
}

export interface SearchableField {
  kind: SearchIndexFieldKind;
  text: string;
  weight: number;
  rankClass: number;
  span: PersistedSpanRow | null;
  symbolKind?: ExtractedSymbolKind;
  symbolName?: string;
}

export interface ExtractionSearchData {
  extractionId: string;
  analyzerId: string | null;
  analyzerVersion: string | null;
  fields: SearchableField[];
  symbolKinds: ExtractedSymbolKind[];
  symbolNames: string[];
}

export type ReplaceSearchIndexInput =
  | { projectId: string; sourceVersionId: string; coverage: 'extraction'; extractionId: string }
  | { projectId: string; sourceVersionId: string; coverage: 'metadata_only' };

export interface SearchIndexStatus {
  projectId: string;
  indexVersion: number;
  /** Active sources whose current version has a usable index. */
  indexedCount: number;
  /** Active sources served by the fallback scan (superset of stale, failed, pending, and never indexed). */
  unindexedCount: number;
  /** Unusable indexes for the current version that were marked stale or superseded. */
  staleCount: number;
  failedCount: number;
  metadataOnlyCount: number;
}

export interface SearchIndexRebuildFailure {
  sourceId: string;
  sourceVersionId: string;
  message: string;
}

export interface SearchIndexRebuildReport {
  projectId: string;
  sourcesConsidered: number;
  extractionIndexed: number;
  metadataOnlyIndexed: number;
  failed: number;
  staleMarked: number;
  failures: SearchIndexRebuildFailure[];
}

export interface SearchIndexCandidateQuery {
  projectId: string;
  /** Lowercase substrings; a source is a candidate when any indexed field or metadata column contains one. */
  needles: readonly string[];
  limit?: number;
}

export interface SearchIndexCandidate {
  indexId: string;
  coverage: SearchIndexCoverage;
  relevance: number;
  sourceId: string;
  sourceKind: string;
  sourcePath: string | null;
  sourceUrl: string | null;
  currentHash: string | null;
  sourceStatus: string;
  sourceUpdatedAt: string;
  sourceVersionId: string;
  contentPath: string | null;
  mimeType: string | null;
  extractionId: string | null;
  analyzerId: string | null;
  analyzerVersion: string | null;
  extraction: ExtractionSearchData | null;
}

export interface SearchIndexTermVariants {
  term: string;
  variants: readonly string[];
}

export type KnowledgeSearchIndexChange =
  | { projectId: string; sourceVersionId: string; reason: 'replaced' }
  | { projectId: string; sourceId: string; reason: 'stale' }
  | { projectId: string; reason: 'project_stale' };

export type KnowledgeSearchIndexChangedHook = (change: KnowledgeSearchIndexChange) => void;

let indexChangedHook: KnowledgeSearchIndexChangedHook | null = null;

/**
 * Registers the optional "index changed" hook. It runs synchronously inside the index write transaction, so a
 * throwing hook rolls the write back. Pass `null` to clear it; with no hook registered the notification is a no-op.
 */
export function setKnowledgeSearchIndexChangedHook(hook: KnowledgeSearchIndexChangedHook | null): void {
  indexChangedHook = hook;
}

function notifyIndexChanged(change: KnowledgeSearchIndexChange): void {
  indexChangedHook?.(change);
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Knowledge search index ${label} must not be empty`);
  }
  return value;
}

export function spanKey(span: {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  label?: string | null;
}): string {
  return [
    span.startOffset,
    span.endOffset,
    span.startLine,
    span.startColumn,
    span.endLine,
    span.endColumn,
    span.label ?? '',
  ].join('\0');
}

export function loadPersistedSpans(
  db: Database.Database,
  projectId: string,
  sourceVersionId: string,
): { spans: PersistedSpanRow[]; overflow: boolean } {
  const rows = db
    .prepare(
      `SELECT id, start_offset, end_offset, start_line, start_column, end_line, end_column, label
       FROM knowledge_source_spans
       WHERE project_id = ? AND source_version_id = ?
       ORDER BY start_offset ASC, end_offset ASC, id ASC
       LIMIT ?`,
    )
    .all(projectId, sourceVersionId, MAX_PERSISTED_SPANS + 1) as PersistedSpanRow[];
  return {
    spans: rows.slice(0, MAX_PERSISTED_SPANS),
    overflow: rows.length > MAX_PERSISTED_SPANS,
  };
}

function matchPersistedSpan(
  spans: ReadonlyMap<string, PersistedSpanRow>,
  span: KnowledgeSourceSpan | null | undefined,
): PersistedSpanRow | null {
  if (!span) return null;
  return spans.get(spanKey(span)) ?? null;
}

function spanBackedField(
  kind: 'symbol' | 'section',
  text: string,
  weight: number,
  span: PersistedSpanRow | null,
  symbol?: { kind: ExtractedSymbolKind; name: string },
): SearchableField {
  return {
    kind,
    text,
    weight,
    rankClass: span ? EXTRACTION_MATCH_RANK_CLASS : METADATA_MATCH_RANK_CLASS,
    span,
    ...(symbol ? { symbolKind: symbol.kind, symbolName: symbol.name } : {}),
  };
}

export interface DeriveExtractionSearchDataInput {
  projectId: string;
  sourceVersionId: string;
  extractionId: string;
  resultJson: string;
  analyzerId: string | null;
  analyzerVersion: string | null;
}

/**
 * Derives the bounded, redacted scorer fields for an extraction. Used by both the index writer and the
 * fallback source scan so the two paths score identical text. Returns null for oversized, malformed, or
 * span-overflowing extractions.
 */
export function deriveExtractionSearchData(
  db: Database.Database,
  input: DeriveExtractionSearchDataInput,
): ExtractionSearchData | null {
  if (Buffer.byteLength(input.resultJson, 'utf8') > MAX_EXTRACTION_JSON_BYTES) return null;
  try {
    const extraction = validateDeterministicExtraction(JSON.parse(input.resultJson) as unknown);
    const persistedSpans = loadPersistedSpans(db, input.projectId, input.sourceVersionId);
    if (persistedSpans.overflow) return null;
    const spans = new Map(
      persistedSpans.spans.map((span) => [
        spanKey({
          startOffset: span.start_offset,
          endOffset: span.end_offset,
          startLine: span.start_line ?? 0,
          startColumn: span.start_column ?? 0,
          endLine: span.end_line ?? 0,
          endColumn: span.end_column ?? 0,
          label: span.label,
        }),
        span,
      ]),
    );
    const symbols = extraction.symbols.slice(0, MAX_EXTRACTION_SYMBOLS);
    const fields: SearchableField[] = [
      ...symbols.flatMap((symbol) => {
        const span = matchPersistedSpan(spans, symbol.span);
        return [
          ...(symbol.qualifiedName
            ? [
                spanBackedField('symbol', redactLines(symbol.qualifiedName), 10, span, {
                  kind: symbol.kind,
                  name: redactLines(symbol.qualifiedName),
                }),
              ]
            : []),
          spanBackedField('symbol', redactLines(symbol.name), 8, span, {
            kind: symbol.kind,
            name: redactLines(symbol.name),
          }),
        ];
      }),
      ...extraction.sections.slice(0, MAX_EXTRACTION_SECTIONS).flatMap((section) => {
        const span = matchPersistedSpan(spans, section.span);
        return [
          ...(section.title ? [spanBackedField('section', redactLines(section.title), 7, span)] : []),
          spanBackedField('section', redactLines(section.text), 5, span),
        ];
      }),
      { kind: 'title' as const, text: redactLines(extraction.title), weight: 6, rankClass: METADATA_MATCH_RANK_CLASS, span: null },
      { kind: 'summary' as const, text: redactLines(extraction.summary), weight: 3, rankClass: METADATA_MATCH_RANK_CLASS, span: null },
    ].slice(0, MAX_SEARCH_FIELDS);
    return {
      extractionId: input.extractionId,
      analyzerId: input.analyzerId,
      analyzerVersion: input.analyzerVersion,
      fields,
      symbolKinds: symbols.map((symbol) => symbol.kind),
      symbolNames: symbols.flatMap((symbol) => [symbol.name, ...(symbol.qualifiedName ? [symbol.qualifiedName] : [])]),
    };
  } catch {
    return null;
  }
}

/**
 * The current source version of every active source, its current extraction (same ordering as the legacy scan),
 * and the index row that is usable for it, if any. See "Usable index" in the search index design.
 */
const CURRENT_SOURCES_CTE = `
  cur AS (
    SELECT s.id AS source_id,
           s.source_kind AS source_kind,
           s.source_path AS source_path,
           s.source_url AS source_url,
           s.current_hash AS current_hash,
           s.status AS source_status,
           s.updated_at AS source_updated_at,
           v.id AS source_version_id,
           v.content_path AS content_path,
           v.mime_type AS mime_type,
           ce.id AS current_extraction_id,
           ce.analyzer_id AS analyzer_id,
           ce.analyzer_version AS analyzer_version,
           ui.id AS usable_index_id,
           ui.coverage AS usable_coverage,
           ci.id AS current_index_id,
           ci.status AS current_index_status,
           ${FOLD_FUNCTION}(s.source_path) AS fold_source_path,
           ${FOLD_FUNCTION}(s.source_url) AS fold_source_url,
           ${FOLD_FUNCTION}(v.content_path) AS fold_content_path,
           ${FOLD_FUNCTION}(s.source_kind) AS fold_source_kind,
           ${FOLD_FUNCTION}(v.mime_type) AS fold_mime_type,
           ${FOLD_FUNCTION}(s.current_hash) AS fold_current_hash
    FROM knowledge_sources s
    LEFT JOIN knowledge_source_versions v
      ON v.project_id = s.project_id
     AND v.source_id = s.id
     AND v.version_number = (
       SELECT MAX(latest.version_number)
       FROM knowledge_source_versions latest
       WHERE latest.project_id = s.project_id AND latest.source_id = s.id
     )
    LEFT JOIN knowledge_extractions ce
      ON ce.project_id = s.project_id
     AND ce.rowid = (
       SELECT le.rowid
       FROM knowledge_extractions le
       WHERE le.project_id = s.project_id
         AND le.source_version_id = v.id
         AND le.completed_at IS NOT NULL
         AND le.result_json IS NOT NULL
       ORDER BY le.updated_at DESC, le.created_at DESC, le.id DESC
       LIMIT 1
     )
    LEFT JOIN knowledge_search_indexes ci
      ON ci.project_id = s.project_id AND ci.source_version_id = v.id
    LEFT JOIN knowledge_search_indexes ui
      ON ui.project_id = s.project_id
     AND ui.source_version_id = v.id
     AND ui.status = 'active'
     AND ui.index_version = @indexVersion
     AND (
       (ui.coverage = 'extraction' AND ui.extraction_id = ce.id)
       OR (ui.coverage = 'metadata_only' AND ce.id IS NULL)
     )
    WHERE s.project_id = @projectId AND s.status = 'active'
  )`;

const METADATA_MATCH_CONDITION = `(
  instr(cur.fold_source_path, n.needle) > 0
  OR instr(cur.fold_source_url, n.needle) > 0
  OR instr(cur.fold_content_path, n.needle) > 0
  OR instr(cur.fold_source_kind, n.needle) > 0
  OR instr(cur.fold_mime_type, n.needle) > 0
  OR instr(cur.fold_current_hash, n.needle) > 0
)`;

interface NeedleEntry {
  termKey: number;
  needle: string;
}

/**
 * Field matches for a set of needles, verified against the original field text. Needles of at least
 * SEARCH_TOKEN_LENGTH characters are narrowed through the trigram token table first (every match contains all of
 * the needle's grams, so narrowing never drops a true match); shorter needles have no grams and scan fields.
 */
function fieldMatchCtes(entries: readonly NeedleEntry[]): { sql: string; params: Record<string, string | number> } {
  const params: Record<string, string | number> = {};
  const all: string[] = [];
  const long: string[] = [];
  const grams: string[] = [];
  const short: string[] = [];
  entries.forEach((entry, needleId) => {
    params[`needle${needleId}`] = entry.needle;
    all.push(`(${needleId}, ${entry.termKey}, @needle${needleId})`);
    if (Array.from(entry.needle).length < SEARCH_TOKEN_LENGTH) {
      short.push(`(${needleId}, @needle${needleId})`);
      return;
    }
    const needleGrams = needleNarrowingGrams(entry.needle);
    long.push(`(${needleId}, @needle${needleId}, ${needleGrams.length})`);
    needleGrams.forEach((gram, position) => {
      params[`gram${needleId}_${position}`] = gram;
      grams.push(`(${needleId}, @gram${needleId}_${position})`);
    });
  });
  const values = (rows: string[], empty: string) => (rows.length > 0 ? `VALUES ${rows.join(', ')}` : empty);
  const sql = `
    needle_all(needle_id, term_key, needle) AS (${values(all, 'SELECT 0, 0, \'\' WHERE 0')}),
    long_needles(needle_id, needle, gram_count) AS (${values(long, 'SELECT 0, \'\', 0 WHERE 0')}),
    needle_grams(needle_id, gram) AS (${values(grams, 'SELECT 0, \'\' WHERE 0')}),
    short_needles(needle_id, needle) AS (${values(short, 'SELECT 0, \'\' WHERE 0')}),
    usable_indexes(index_id) AS (SELECT usable_index_id FROM cur WHERE usable_index_id IS NOT NULL),
    gram_hits AS (
      SELECT ng.needle_id AS needle_id, t.index_id AS index_id, t.field_order AS field_order
      FROM needle_grams ng
      JOIN knowledge_search_index_tokens t ON t.project_id = @projectId AND t.token = ng.gram
      WHERE t.index_id IN (SELECT index_id FROM usable_indexes)
      GROUP BY ng.needle_id, t.index_id, t.field_order
      HAVING COUNT(*) = (SELECT l.gram_count FROM long_needles l WHERE l.needle_id = ng.needle_id)
    ),
    field_hits AS MATERIALIZED (
      SELECT g.needle_id AS needle_id, f.index_id AS index_id, f.field_kind AS field_kind, f.rank_class AS rank_class
      FROM gram_hits g
      JOIN long_needles l ON l.needle_id = g.needle_id
      JOIN knowledge_search_index_fields f
        ON f.project_id = @projectId AND f.index_id = g.index_id AND f.field_order = g.field_order
      WHERE instr(${FIELD_FOLD_FUNCTION}(f.field_text), l.needle) > 0
      UNION ALL
      SELECT s.needle_id, f.index_id, f.field_kind, f.rank_class
      FROM short_needles s
      JOIN knowledge_search_index_fields f
        ON f.project_id = @projectId AND f.index_id IN (SELECT index_id FROM usable_indexes)
      WHERE instr(${FIELD_FOLD_FUNCTION}(f.field_text), s.needle) > 0
    )`;
  return { sql, params };
}

interface CandidateRow {
  source_id: string;
  source_kind: string;
  source_path: string | null;
  source_url: string | null;
  current_hash: string | null;
  source_status: string;
  source_updated_at: string;
  source_version_id: string;
  content_path: string | null;
  mime_type: string | null;
  current_extraction_id: string | null;
  analyzer_id: string | null;
  analyzer_version: string | null;
  usable_index_id: string;
  usable_coverage: SearchIndexCoverage;
  relevance: number;
}

interface IndexedFieldRow {
  field_kind: SearchIndexFieldKind;
  field_text: string;
  field_weight: number;
  rank_class: number;
  symbol_kind: ExtractedSymbolKind | null;
  symbol_name: string | null;
  span_row_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  label: string | null;
}

interface MaterializedField {
  kind: SearchIndexFieldKind;
  text: string;
  weight: number;
  rankClass: number;
  spanId: string | null;
  symbolKind: string | null;
  symbolName: string | null;
}

interface SourceVersionRow {
  source_id: string;
  source_kind: string;
  source_path: string | null;
  source_url: string | null;
  content_path: string | null;
  mime_type: string | null;
}

interface ExtractionRow {
  id: string;
  result_json: string;
  analyzer_id: string | null;
  analyzer_version: string | null;
}

function boundLookupText(value: string): string {
  const redacted = redactLines(value);
  return redacted.length > MAX_LOOKUP_FIELD_CHARS ? redacted.slice(0, MAX_LOOKUP_FIELD_CHARS) : redacted;
}

function lookupField(kind: 'path' | 'title' | 'summary', text: string): MaterializedField {
  return { kind, text, weight: 0, rankClass: METADATA_MATCH_RANK_CLASS, spanId: null, symbolKind: null, symbolName: null };
}

function metadataLookupFields(row: SourceVersionRow, sourceVersionId: string, includeDisplayFields: boolean): MaterializedField[] {
  const fields = [row.source_path, row.source_url, row.content_path]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => lookupField('path', boundLookupText(value)));
  if (!includeDisplayFields) return fields;
  const title = row.source_path ?? row.source_url ?? row.content_path ?? sourceVersionId;
  const summary = [row.source_kind, row.mime_type].filter((value): value is string => Boolean(value)).join(' ');
  return [...fields, lookupField('title', boundLookupText(title)), lookupField('summary', boundLookupText(summary))];
}

function foldNeedles(needles: readonly string[]): string[] {
  const folded = new Set<string>();
  for (const needle of needles) {
    const value = needle.toLocaleLowerCase();
    if (value.length === 0 || value.length > MAX_NEEDLE_CHARS) continue;
    folded.add(value);
    if (folded.size >= MAX_NEEDLES) break;
  }
  return [...folded];
}

export interface KnowledgeSearchIndexOptions {
  now?: () => string;
}

/**
 * Materialized, deterministic search index over redacted extraction-derived text. It is derived data: every
 * write is transactional, search never writes, and any source without a usable index is served by the caller's
 * fallback scan instead of being omitted.
 */
export class KnowledgeSearchIndex {
  private readonly now: () => string;
  private fieldTextChecks = 0;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeSearchIndexOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    db.function(FOLD_FUNCTION, { deterministic: true }, (value: unknown) =>
      typeof value === 'string' ? value.toLocaleLowerCase() : null,
    );
    db.function(FIELD_FOLD_FUNCTION, { deterministic: true }, (value: unknown) => {
      this.fieldTextChecks += 1;
      return typeof value === 'string' ? foldSearchText(value) : null;
    });
  }

  /** Deterministic work measure: how many indexed field texts were folded and compared by lookups. */
  public getWorkCounters(): { fieldTextChecks: number } {
    return { fieldTextChecks: this.fieldTextChecks };
  }

  public resetWorkCounters(): void {
    this.fieldTextChecks = 0;
  }

  public replaceForSourceVersion(input: ReplaceSearchIndexInput): void {
    const projectId = requireId(input.projectId, 'project ID');
    const sourceVersionId = requireId(input.sourceVersionId, 'source version ID');
    this.db.transaction(() => {
      const version = this.requireSourceVersion(projectId, sourceVersionId);
      const materialized = this.materialize(projectId, sourceVersionId, version, input);
      this.db
        .prepare('DELETE FROM knowledge_search_indexes WHERE project_id = ? AND source_version_id = ?')
        .run(projectId, sourceVersionId);
      const indexId = createKnowledgeId('search_index', `${projectId}:${sourceVersionId}`);
      const timestamp = this.now();
      this.db
        .prepare(
          `INSERT INTO knowledge_search_indexes
             (id, project_id, source_version_id, index_version, status, coverage, extraction_id, field_count, created_at, updated_at)
           VALUES (@id, @projectId, @sourceVersionId, @indexVersion, @status, @coverage, @extractionId, @fieldCount, @now, @now)`,
        )
        .run({
          id: indexId,
          projectId,
          sourceVersionId,
          indexVersion: KNOWLEDGE_SEARCH_INDEX_VERSION,
          status: materialized.status,
          coverage: materialized.coverage,
          extractionId: materialized.extractionId,
          fieldCount: materialized.fields.length,
          now: timestamp,
        });
      const insertField = this.db.prepare(
        `INSERT INTO knowledge_search_index_fields
           (id, project_id, index_id, field_order, field_kind, field_text, field_weight, rank_class, span_id, symbol_kind, symbol_name, created_at)
         VALUES (@id, @projectId, @indexId, @fieldOrder, @fieldKind, @fieldText, @fieldWeight, @rankClass, @spanId, @symbolKind, @symbolName, @now)`,
      );
      const insertToken = this.db.prepare(
        `INSERT INTO knowledge_search_index_tokens (project_id, token, index_id, field_order)
         VALUES (?, ?, ?, ?)`,
      );
      materialized.fields.forEach((field, fieldOrder) => {
        for (const gram of trigramsOf(foldSearchText(field.text))) {
          insertToken.run(projectId, gram, indexId, fieldOrder);
        }
        insertField.run({
          id: createKnowledgeId('search_field', `${indexId}:${fieldOrder}`),
          projectId,
          indexId,
          fieldOrder,
          fieldKind: field.kind,
          fieldText: field.text,
          fieldWeight: field.weight,
          rankClass: field.rankClass,
          spanId: field.spanId,
          symbolKind: field.symbolKind,
          symbolName: field.symbolName,
          now: timestamp,
        });
      });
      notifyIndexChanged({ projectId, sourceVersionId, reason: 'replaced' });
    })();
  }

  public markSourceStale(projectId: string, sourceId: string): void {
    const scopedProjectId = requireId(projectId, 'project ID');
    const scopedSourceId = requireId(sourceId, 'source ID');
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE knowledge_search_indexes
           SET status = 'stale', updated_at = @now
           WHERE project_id = @projectId
             AND status = 'active'
             AND source_version_id IN (
               SELECT id FROM knowledge_source_versions WHERE project_id = @projectId AND source_id = @sourceId
             )`,
        )
        .run({ projectId: scopedProjectId, sourceId: scopedSourceId, now: this.now() });
      if (result.changes > 0) {
        notifyIndexChanged({ projectId: scopedProjectId, sourceId: scopedSourceId, reason: 'stale' });
      }
    })();
  }

  public rebuildProject(projectId: string): SearchIndexRebuildReport {
    const scopedProjectId = requireId(projectId, 'project ID');
    const report: SearchIndexRebuildReport = {
      projectId: scopedProjectId,
      sourcesConsidered: 0,
      extractionIndexed: 0,
      metadataOnlyIndexed: 0,
      failed: 0,
      staleMarked: 0,
      failures: [],
    };
    report.staleMarked = this.markSupersededStale(scopedProjectId);
    const targets = this.db
      .prepare(
        `WITH ${CURRENT_SOURCES_CTE}
         SELECT source_id, source_version_id, current_extraction_id
         FROM cur
         WHERE source_version_id IS NOT NULL
         ORDER BY source_updated_at DESC, source_id ASC`,
      )
      .all(this.cteParams(scopedProjectId)) as Array<{
      source_id: string;
      source_version_id: string;
      current_extraction_id: string | null;
    }>;
    for (const target of targets) {
      report.sourcesConsidered += 1;
      try {
        this.replaceForSourceVersion(
          target.current_extraction_id === null
            ? { projectId: scopedProjectId, sourceVersionId: target.source_version_id, coverage: 'metadata_only' }
            : {
                projectId: scopedProjectId,
                sourceVersionId: target.source_version_id,
                coverage: 'extraction',
                extractionId: target.current_extraction_id,
              },
        );
      } catch (error) {
        report.failed += 1;
        report.failures.push({
          sourceId: target.source_id,
          sourceVersionId: target.source_version_id,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const written = this.db
        .prepare('SELECT status FROM knowledge_search_indexes WHERE project_id = ? AND source_version_id = ?')
        .get(scopedProjectId, target.source_version_id) as { status: SearchIndexRowStatus } | undefined;
      if (written?.status === 'active') {
        if (target.current_extraction_id === null) report.metadataOnlyIndexed += 1;
        else report.extractionIndexed += 1;
      } else {
        report.failed += 1;
        report.failures.push({
          sourceId: target.source_id,
          sourceVersionId: target.source_version_id,
          message: 'Persisted extraction could not be indexed within the search bounds.',
        });
      }
    }
    return report;
  }

  public getStatus(projectId: string): SearchIndexStatus {
    const scopedProjectId = requireId(projectId, 'project ID');
    const row = this.db
      .prepare(
        `WITH ${CURRENT_SOURCES_CTE}
         SELECT
           COALESCE(SUM(usable_index_id IS NOT NULL), 0) AS indexed,
           COALESCE(SUM(usable_index_id IS NULL), 0) AS unindexed,
           COALESCE(SUM(usable_index_id IS NULL AND current_index_id IS NOT NULL AND current_index_status <> 'failed'), 0) AS stale,
           COALESCE(SUM(usable_index_id IS NULL AND current_index_status = 'failed'), 0) AS failed,
           COALESCE(SUM(usable_coverage = 'metadata_only'), 0) AS metadata_only
         FROM cur`,
      )
      .get(this.cteParams(scopedProjectId)) as {
      indexed: number;
      unindexed: number;
      stale: number;
      failed: number;
      metadata_only: number;
    };
    return {
      projectId: scopedProjectId,
      indexVersion: KNOWLEDGE_SEARCH_INDEX_VERSION,
      indexedCount: row.indexed,
      unindexedCount: row.unindexed,
      staleCount: row.stale,
      failedCount: row.failed,
      metadataOnlyCount: row.metadata_only,
    };
  }

  /** Active sources whose current version has no usable index, in the legacy scan order. */
  public getUnindexedSourceIds(projectId: string): string[] {
    const scopedProjectId = requireId(projectId, 'project ID');
    const rows = this.db
      .prepare(
        `WITH ${CURRENT_SOURCES_CTE}
         SELECT source_id FROM cur WHERE usable_index_id IS NULL
         ORDER BY source_updated_at DESC, source_id ASC`,
      )
      .all(this.cteParams(scopedProjectId)) as Array<{ source_id: string }>;
    return rows.map((row) => row.source_id);
  }

  public findCandidates(query: SearchIndexCandidateQuery): SearchIndexCandidate[] {
    const projectId = requireId(query.projectId, 'project ID');
    const needles = foldNeedles(query.needles);
    if (needles.length === 0) return [];
    const limit = Math.max(0, Math.min(MAX_RESULT_CANDIDATES, Math.trunc(query.limit ?? MAX_RESULT_CANDIDATES)));
    if (limit === 0) return [];
    const matches = fieldMatchCtes(needles.map((needle) => ({ termKey: 0, needle })));
    const rows = this.db
      .prepare(
        `WITH ${CURRENT_SOURCES_CTE},
         ${matches.sql}
         SELECT cur.*, COALESCE(m.relevance, ${METADATA_MATCH_RANK_CLASS}) AS relevance
         FROM cur
         LEFT JOIN (
           SELECT index_id, MAX(rank_class) AS relevance FROM field_hits GROUP BY index_id
         ) m ON m.index_id = cur.usable_index_id
         WHERE cur.usable_index_id IS NOT NULL
           AND (
             m.index_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM needle_all n WHERE ${METADATA_MATCH_CONDITION})
           )
         ORDER BY COALESCE(m.relevance, ${METADATA_MATCH_RANK_CLASS}) DESC,
                  COALESCE(cur.source_path, cur.source_url, cur.content_path, cur.source_id) ASC,
                  cur.source_version_id ASC
         LIMIT @limit`,
      )
      .all({ ...this.cteParams(projectId), ...matches.params, limit }) as CandidateRow[];
    return rows.map((row) => this.toCandidate(projectId, row));
  }

  /**
   * Number of usable indexed documents containing any variant of each term, using legacy presence semantics.
   * All terms share one field-match pass instead of scanning fields once per term.
   */
  public documentFrequency(projectId: string, terms: readonly SearchIndexTermVariants[]): Map<string, number> {
    const scopedProjectId = requireId(projectId, 'project ID');
    const counts = new Map<string, number>(terms.map(({ term }) => [term, 0]));
    const entries: NeedleEntry[] = terms.flatMap(({ variants }, termKey) =>
      foldNeedles(variants).map((needle) => ({ termKey, needle })),
    );
    if (entries.length === 0) return counts;
    const matches = fieldMatchCtes(entries);
    const rows = this.db
      .prepare(
        `WITH ${CURRENT_SOURCES_CTE},
         ${matches.sql}
         SELECT term_key, COUNT(*) AS documents
         FROM (
           SELECT n.term_key AS term_key, cur.usable_index_id AS index_id
           FROM cur
           JOIN needle_all n ON ${METADATA_MATCH_CONDITION}
           WHERE cur.usable_index_id IS NOT NULL
           UNION
           SELECT n.term_key, h.index_id
           FROM field_hits h
           JOIN needle_all n ON n.needle_id = h.needle_id
           JOIN cur ON cur.usable_index_id = h.index_id AND cur.usable_coverage = 'extraction'
           WHERE h.field_kind <> 'path'
         )
         GROUP BY term_key`,
      )
      .all({ ...this.cteParams(scopedProjectId), ...matches.params }) as Array<{ term_key: number; documents: number }>;
    for (const row of rows) counts.set(terms[row.term_key].term, row.documents);
    return counts;
  }

  private cteParams(projectId: string): { projectId: string; indexVersion: number } {
    return { projectId, indexVersion: KNOWLEDGE_SEARCH_INDEX_VERSION };
  }

  private markSupersededStale(projectId: string): number {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE knowledge_search_indexes
           SET status = 'stale', updated_at = @now
           WHERE project_id = @projectId
             AND status = 'active'
             AND source_version_id NOT IN (
               SELECT v.id
               FROM knowledge_sources s
               JOIN knowledge_source_versions v
                 ON v.project_id = s.project_id
                AND v.source_id = s.id
                AND v.version_number = (
                  SELECT MAX(latest.version_number)
                  FROM knowledge_source_versions latest
                  WHERE latest.project_id = s.project_id AND latest.source_id = s.id
                )
               WHERE s.project_id = @projectId AND s.status = 'active'
             )`,
        )
        .run({ projectId, now: this.now() });
      if (result.changes > 0) {
        notifyIndexChanged({ projectId, reason: 'project_stale' });
      }
      return result.changes;
    })();
  }

  private requireSourceVersion(projectId: string, sourceVersionId: string): SourceVersionRow {
    const row = this.db
      .prepare(
        `SELECT s.id AS source_id, s.source_kind, s.source_path, s.source_url, v.content_path, v.mime_type
         FROM knowledge_source_versions v
         JOIN knowledge_sources s ON s.project_id = v.project_id AND s.id = v.source_id
         WHERE v.project_id = ? AND v.id = ?`,
      )
      .get(projectId, sourceVersionId) as SourceVersionRow | undefined;
    if (!row) {
      throw new Error(`Knowledge search index source version not found in project ${projectId}: ${sourceVersionId}`);
    }
    return row;
  }

  private materialize(
    projectId: string,
    sourceVersionId: string,
    version: SourceVersionRow,
    input: ReplaceSearchIndexInput,
  ): {
    status: 'active' | 'failed';
    coverage: SearchIndexCoverage;
    extractionId: string | null;
    fields: MaterializedField[];
  } {
    if (input.coverage === 'metadata_only') {
      return {
        status: 'active',
        coverage: 'metadata_only',
        extractionId: null,
        fields: metadataLookupFields(version, sourceVersionId, true),
      };
    }
    const extraction = this.db
      .prepare(
        `SELECT id, result_json, analyzer_id, analyzer_version
         FROM knowledge_extractions
         WHERE project_id = ? AND source_version_id = ? AND id = ?
           AND completed_at IS NOT NULL AND result_json IS NOT NULL`,
      )
      .get(projectId, sourceVersionId, input.extractionId) as ExtractionRow | undefined;
    if (!extraction) {
      throw new Error(
        `Knowledge search index extraction ${input.extractionId} is not a completed extraction of source version ${sourceVersionId}`,
      );
    }
    const data = deriveExtractionSearchData(this.db, {
      projectId,
      sourceVersionId,
      extractionId: extraction.id,
      resultJson: extraction.result_json,
      analyzerId: extraction.analyzer_id,
      analyzerVersion: extraction.analyzer_version,
    });
    if (!data) {
      return { status: 'failed', coverage: 'extraction', extractionId: extraction.id, fields: [] };
    }
    return {
      status: 'active',
      coverage: 'extraction',
      extractionId: extraction.id,
      fields: [
        ...data.fields.map((field) => ({
          kind: field.kind,
          text: field.text,
          weight: field.weight,
          rankClass: field.rankClass,
          spanId: field.span?.id ?? null,
          symbolKind: field.symbolKind ?? null,
          symbolName: field.symbolName ?? null,
        })),
        ...metadataLookupFields(version, sourceVersionId, false),
      ],
    };
  }

  private toCandidate(projectId: string, row: CandidateRow): SearchIndexCandidate {
    const extraction = row.usable_coverage === 'extraction' && row.current_extraction_id !== null
      ? this.loadExtractionData(projectId, row)
      : null;
    return {
      indexId: row.usable_index_id,
      coverage: row.usable_coverage,
      relevance: row.relevance,
      sourceId: row.source_id,
      sourceKind: row.source_kind,
      sourcePath: row.source_path,
      sourceUrl: row.source_url,
      currentHash: row.current_hash,
      sourceStatus: row.source_status,
      sourceUpdatedAt: row.source_updated_at,
      sourceVersionId: row.source_version_id,
      contentPath: row.content_path,
      mimeType: row.mime_type,
      extractionId: row.usable_coverage === 'extraction' ? row.current_extraction_id : null,
      analyzerId: row.usable_coverage === 'extraction' ? row.analyzer_id : null,
      analyzerVersion: row.usable_coverage === 'extraction' ? row.analyzer_version : null,
      extraction,
    };
  }

  private loadExtractionData(projectId: string, row: CandidateRow): ExtractionSearchData {
    const rows = this.db
      .prepare(
        `SELECT f.field_kind, f.field_text, f.field_weight, f.rank_class, f.symbol_kind, f.symbol_name,
                sp.id AS span_row_id, sp.start_offset, sp.end_offset, sp.start_line, sp.start_column,
                sp.end_line, sp.end_column, sp.label
         FROM knowledge_search_index_fields f
         LEFT JOIN knowledge_source_spans sp ON sp.project_id = f.project_id AND sp.id = f.span_id
         WHERE f.project_id = ? AND f.index_id = ? AND f.field_kind <> 'path'
         ORDER BY f.field_order ASC
         LIMIT ?`,
      )
      .all(projectId, row.usable_index_id, MAX_SEARCH_FIELDS) as IndexedFieldRow[];
    const fields: SearchableField[] = rows.map((field) => ({
      kind: field.field_kind,
      text: field.field_text,
      weight: field.field_weight,
      rankClass: field.rank_class,
      span:
        field.span_row_id === null || field.start_offset === null || field.end_offset === null
          ? null
          : {
              id: field.span_row_id,
              start_offset: field.start_offset,
              end_offset: field.end_offset,
              start_line: field.start_line,
              start_column: field.start_column,
              end_line: field.end_line,
              end_column: field.end_column,
              label: field.label,
            },
      ...(field.symbol_kind ? { symbolKind: field.symbol_kind } : {}),
      ...(field.symbol_name !== null ? { symbolName: field.symbol_name } : {}),
    }));
    const symbolFields = fields.filter((field) => field.kind === 'symbol' && field.symbolKind !== undefined);
    return {
      extractionId: row.current_extraction_id as string,
      analyzerId: row.analyzer_id,
      analyzerVersion: row.analyzer_version,
      fields,
      symbolKinds: symbolFields.map((field) => field.symbolKind as ExtractedSymbolKind),
      symbolNames: symbolFields.map((field) => field.symbolName ?? ''),
    };
  }
}
