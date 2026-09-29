import type Database from 'better-sqlite3';
import { estimateTokens } from '../ContextBuilder.js';
import { redactLines } from '../Redactor.js';
import { searchWorkspace, type SearchResult as WorkspaceSearchResult } from '../Search.js';
import type { TaskStore } from '../TaskStore.js';
import {
  validateDeterministicExtraction,
  type ExtractedSymbolKind,
  type KnowledgeSourceSpan,
} from './KnowledgeExtraction.js';
import type {
  KnowledgePageId,
  KnowledgePageType,
  KnowledgeProjectId,
  KnowledgeSourceId,
  KnowledgeSourceKind,
} from './KnowledgeTypes.js';

export type KnowledgeSearchMode = 'knowledge' | 'sources' | 'tasks' | 'hybrid' | 'read-sources-only';
export type KnowledgeSearchResultKind = 'page' | 'source' | 'task';

export interface KnowledgeSearchCitation {
  pageId: KnowledgePageId | null;
  sourceId: KnowledgeSourceId | null;
  path: string | null;
  url: string | null;
  span: {
    id: string;
    startOffset: number;
    endOffset: number;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
    label: string | null;
  } | null;
}

export interface KnowledgeSearchGraphExpansion {
  id: string;
  title: string;
  text: string;
  tokens?: number;
}

export interface KnowledgeSearchResult {
  mode: KnowledgeSearchMode;
  kind: KnowledgeSearchResultKind;
  id: string;
  projectId: KnowledgeProjectId | null;
  title: string;
  snippet: string;
  score: number;
  citations: KnowledgeSearchCitation[];
  graphExpansions: KnowledgeSearchGraphExpansion[];
  taskResult?: WorkspaceSearchResult;
  metadata: Record<string, string | number | null>;
}

export interface KnowledgeSearchOptions {
  db: Database.Database;
  projectId: string;
  mode?: KnowledgeSearchMode;
  taskStore?: TaskStore;
  limit?: number;
  maxGraphExpansions?: number;
  graphExpansion?: (result: KnowledgeSearchResult) => KnowledgeSearchGraphExpansion[];
}

export interface KnowledgeSearchContextOptions {
  tokenBudget?: number;
}

export interface KnowledgeSearchContext {
  results: KnowledgeSearchResult[];
  truncated: Record<string, number>;
}

interface PageSearchRow {
  id: string;
  project_id: string;
  page_type: KnowledgePageType;
  title: string;
  slug: string;
  status: string;
  updated_at: string;
  version_id: string | null;
  summary: string | null;
  content_path: string | null;
  version_created_at: string | null;
}

interface SourceSearchRow {
  id: string;
  project_id: string;
  source_kind: KnowledgeSourceKind;
  source_path: string | null;
  source_url: string | null;
  current_hash: string | null;
  status: string;
  updated_at: string;
  source_version_id: string | null;
  content_path: string | null;
  mime_type: string | null;
  extraction_id: string | null;
  extraction_result_json: string | null;
  extraction_analyzer_id: string | null;
  extraction_analyzer_version: string | null;
}

interface CitationRow {
  page_id: string | null;
  source_id: string | null;
  source_path: string | null;
  source_url: string | null;
  span_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  label: string | null;
}

interface PersistedSpanRow {
  id: string;
  start_offset: number;
  end_offset: number;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  label: string | null;
}

interface SearchableField {
  text: string;
  weight: number;
  rankClass: number;
  span: PersistedSpanRow | null;
}

interface ExtractionSearchData {
  extractionId: string;
  analyzerId: string | null;
  analyzerVersion: string | null;
  fields: SearchableField[];
  symbolKinds: ExtractedSymbolKind[];
}

const DEFAULT_LIMIT = 20;
const SOURCE_SNIPPET_LIMIT = 180;
const MAX_QUERY_LENGTH = 256;
const MAX_QUERY_BYTES = 256;
const MAX_QUERY_TERMS = 16;
const MAX_EXTRACTION_JSON_BYTES = 1_048_576;
const MAX_EXTRACTION_SECTIONS = 200;
const MAX_EXTRACTION_SYMBOLS = 200;
const MAX_SEARCH_FIELDS = 800;
const MAX_PERSISTED_SPANS = 2_000;
const MAX_RESULT_CANDIDATES = 500;
const EXTRACTION_MATCH_RANK_CLASS = 2;
const METADATA_MATCH_RANK_CLASS = 1;
const DEFAULT_MATCH_RANK_CLASS = 0;
const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'does',
  'do',
  'how',
  'is',
  'of',
  'the',
  'to',
  'what',
  'when',
  'which',
]);

type RankedKnowledgeSearchResult = KnowledgeSearchResult & { rankClass?: number };

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function searchTokens(value: string): string[] {
  const tokens = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return [
    ...new Set(
      tokens.flatMap((token) => (token === 'usecase' ? [token, 'use', 'case'] : [token])),
    ),
  ];
}

function terms(query: string): string[] {
  return normalize(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term && !SEARCH_STOP_WORDS.has(term))
    .slice(0, MAX_QUERY_TERMS);
}

function termVariants(term: string): string[] {
  const variants = [term];
  if (term.length > 5 && term.endsWith('sses')) variants.push(term.slice(0, -2));
  if (term.length > 4 && term.endsWith('ies') && term.length - 3 >= 4) variants.push(`${term.slice(0, -3)}y`);
  if (term.length > 4 && term.endsWith('ing') && term.length - 3 >= 4) {
    const stem = term.slice(0, -3);
    variants.push(stem);
    if (stem.endsWith('t')) variants.push(`${stem}e`);
  }
  if (term.length > 5 && term.endsWith('ated')) variants.push(term.slice(0, -1));
  if (term.length > 4 && term.endsWith('ed') && term.length - 2 >= 4) variants.push(term.slice(0, -2));
  if (term.length > 4 && term.endsWith('s') && term.length - 1 >= 4) variants.push(term.slice(0, -1));
  return [...new Set(variants)];
}

function queryHasConcept(query: string, concept: string): boolean {
  return terms(query).some(
    (term) => term === concept || term === `${concept}s` || term === `${concept}es` || termVariants(term).includes(concept),
  );
}

function structuralScore(query: string, row: SourceSearchRow, extractionData: ExtractionSearchData | null): number {
  const pathTokens = searchTokens(row.source_path ?? row.content_path ?? '');
  const hasTaskManagerPath = pathTokens.includes('task') && pathTokens.some((token) => token === 'manager' || token === 'managers');
  const hasWorkflowPath = pathTokens.includes('workflow') || pathTokens.includes('workflows');
  const hasUseCasePath = pathTokens.includes('usecase') || pathTokens.includes('usecases');
  const hasLoaderPath = pathTokens.includes('loader');
  const hasGlobalVariablesPath = pathTokens.includes('global') && pathTokens.includes('variables');
  const hasConftestPath = pathTokens.includes('conftest');
  const hasClassIntent = queryHasConcept(query, 'class');
  const hasFunctionIntent = queryHasConcept(query, 'function') || queryHasConcept(query, 'method');
  const hasInterfaceIntent = queryHasConcept(query, 'interface');
  const hasUseCaseIntent = queryHasConcept(query, 'use') || queryHasConcept(query, 'usecase');
  const hasLoaderIntent = queryHasConcept(query, 'loader');
  const hasDefaultsIntent = queryHasConcept(query, 'default');
  const hasPytestIntent = queryHasConcept(query, 'pytest') || queryHasConcept(query, 'bootstrap');
  const symbolKinds = new Set(extractionData?.symbolKinds ?? []);
  let score = 0;
  if (hasTaskManagerPath && hasClassIntent && symbolKinds.has('class')) score += 24;
  if (hasTaskManagerPath && hasFunctionIntent && (symbolKinds.has('function') || symbolKinds.has('method'))) score += 12;
  if (hasInterfaceIntent && symbolKinds.has('interface')) score += 12;
  if (hasWorkflowPath && hasClassIntent && symbolKinds.has('class')) score += 4;
  if (hasUseCasePath && hasUseCaseIntent) score += 16;
  if (hasLoaderPath && hasLoaderIntent) score += 36;
  if (hasGlobalVariablesPath && hasDefaultsIntent) score += 24;
  if (hasConftestPath && hasPytestIntent) score += 24;
  return score;
}

export function lexicalScore(query: string, weightedFields: Array<{ text: string | null; weight: number }>): number {
  return lexicalScoreWithTermWeights(query, weightedFields, new Map());
}

function lexicalScoreWithTermWeights(
  query: string,
  weightedFields: Array<{ text: string | null; weight: number }>,
  termWeights: ReadonlyMap<string, number>,
): number {
  const phrase = normalize(query);
  const queryTerms = terms(query);
  if (!phrase || queryTerms.length === 0) return 0;

  let score = 0;
  for (const field of weightedFields) {
    const text = normalize(field.text ?? '');
    if (!text) continue;
    const fieldTokens = searchTokens(field.text ?? '');
    if (text.includes(phrase)) score += field.weight * 4;
    let matchedTerms = 0;
    for (const term of queryTerms) {
      const variantScore = Math.max(
        ...termVariants(term).map(
          (variant) => Math.min(fieldTokens.filter((token) => token === variant).length, 3),
        ),
      );
      if (variantScore > 0) matchedTerms += 1;
      score += variantScore * field.weight * (termWeights.get(term) ?? 1);
    }
    if (matchedTerms > 1) score += (matchedTerms - 1) * field.weight * 1.5;
  }
  return score;
}

function pageRows(db: Database.Database, projectId: string): PageSearchRow[] {
  return db
    .prepare(
      `SELECT p.id, p.project_id, p.page_type, p.title, p.slug, p.status, p.updated_at,
              v.id AS version_id, v.summary, v.content_path, v.created_at AS version_created_at
       FROM knowledge_pages p
       LEFT JOIN knowledge_page_versions v
         ON v.project_id = p.project_id
        AND v.page_id = p.id
        AND v.version_number = (
          SELECT MAX(version_number)
          FROM knowledge_page_versions latest
          WHERE latest.project_id = p.project_id AND latest.page_id = p.id
        )
       WHERE p.project_id = ? AND p.status = 'active'
       ORDER BY p.updated_at DESC, p.id ASC`,
    )
    .all(projectId) as PageSearchRow[];
}

function sourceRows(db: Database.Database, projectId: string): SourceSearchRow[] {
  return db
    .prepare(
      `SELECT s.id, s.project_id, s.source_kind, s.source_path, s.source_url,
              s.current_hash, s.status, s.updated_at,
              v.id AS source_version_id,
              v.content_path, v.mime_type,
              e.id AS extraction_id,
              e.result_json AS extraction_result_json,
              e.analyzer_id AS extraction_analyzer_id,
              e.analyzer_version AS extraction_analyzer_version
       FROM knowledge_sources s
       LEFT JOIN knowledge_source_versions v
         ON v.project_id = s.project_id
        AND v.source_id = s.id
        AND v.version_number = (
          SELECT MAX(version_number)
          FROM knowledge_source_versions latest
          WHERE latest.project_id = s.project_id AND latest.source_id = s.id
        )
       LEFT JOIN knowledge_extractions e
         ON e.project_id = s.project_id
        AND e.source_version_id = v.id
        AND e.rowid = (
          SELECT latest_extraction.rowid
          FROM knowledge_extractions latest_extraction
          WHERE latest_extraction.project_id = s.project_id
            AND latest_extraction.source_version_id = v.id
            AND latest_extraction.completed_at IS NOT NULL
            AND latest_extraction.result_json IS NOT NULL
          ORDER BY latest_extraction.updated_at DESC, latest_extraction.created_at DESC, latest_extraction.id DESC
          LIMIT 1
        )
       WHERE s.project_id = ? AND s.status = 'active'
       ORDER BY s.updated_at DESC, s.id ASC`,
    )
    .all(projectId) as SourceSearchRow[];
}

function citationsForPage(db: Database.Database, projectId: string, pageId: string, versionId: string | null): KnowledgeSearchCitation[] {
  if (!versionId) return [];
  const rows = db
    .prepare(
      `SELECT ? AS page_id,
              s.id AS source_id,
              s.source_path,
              s.source_url,
              span.id AS span_id,
              span.start_offset,
              span.end_offset,
              span.start_line,
              span.start_column,
              span.end_line,
              span.end_column,
              span.label
       FROM knowledge_page_sources ps
       LEFT JOIN knowledge_source_versions sv
         ON sv.project_id = ps.project_id AND sv.id = ps.source_version_id
       LEFT JOIN knowledge_sources s
         ON s.project_id = sv.project_id AND s.id = sv.source_id
       LEFT JOIN knowledge_page_provenance prov
         ON prov.project_id = ps.project_id
        AND prov.page_version_id = ps.page_version_id
        AND prov.source_id = s.id
       LEFT JOIN knowledge_source_spans span
         ON span.project_id = prov.project_id AND span.id = prov.source_span_id
       WHERE ps.project_id = ? AND ps.page_version_id = ?
       ORDER BY s.source_path, s.source_url, span.start_offset`,
    )
    .all(pageId, projectId, versionId) as CitationRow[];
  return dedupeCitations(rows.map(rowToCitation).filter((citation) => citation.sourceId !== null));
}

function rowToCitation(row: CitationRow): KnowledgeSearchCitation {
  return {
    pageId: row.page_id as KnowledgePageId | null,
    sourceId: row.source_id as KnowledgeSourceId | null,
    path: row.source_path ? redactLines(row.source_path) : null,
    url: row.source_url ? redactLines(row.source_url) : null,
    span:
      row.span_id === null || row.start_offset === null || row.end_offset === null
        ? null
        : {
            id: row.span_id,
            startOffset: row.start_offset,
            endOffset: row.end_offset,
            ...(row.start_line !== null ? { startLine: row.start_line } : {}),
            ...(row.start_column !== null ? { startColumn: row.start_column } : {}),
            ...(row.end_line !== null ? { endLine: row.end_line } : {}),
            ...(row.end_column !== null ? { endColumn: row.end_column } : {}),
            label: row.label ? redactLines(row.label) : row.label,
          },
  };
}

function sourceCitation(row: SourceSearchRow): KnowledgeSearchCitation {
  const path = row.source_path ?? row.content_path;
  return {
    pageId: null,
    sourceId: row.id as KnowledgeSourceId,
    path: path ? redactLines(path) : null,
    url: row.source_url ? redactLines(row.source_url) : null,
    span: null,
  };
}

function dedupeCitations(citations: KnowledgeSearchCitation[]): KnowledgeSearchCitation[] {
  const seen = new Set<string>();
  const deduped: KnowledgeSearchCitation[] = [];
  for (const citation of citations) {
    const key = [
      citation.pageId ?? '',
      citation.sourceId ?? '',
      citation.path ?? '',
      citation.url ?? '',
      citation.span?.id ?? '',
      citation.span?.startOffset ?? '',
      citation.span?.endOffset ?? '',
      citation.span?.startLine ?? '',
      citation.span?.startColumn ?? '',
      citation.span?.endLine ?? '',
      citation.span?.endColumn ?? '',
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(citation);
  }
  return deduped;
}

function findMatchIndex(text: string, query: string): { index: number; length: number } | null {
  const normalizedText = text.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const phraseIndex = normalizedText.indexOf(normalizedQuery);
  if (phraseIndex !== -1) {
    return { index: phraseIndex, length: normalizedQuery.length };
  }
  for (const term of terms(query)) {
    const index = normalizedText.indexOf(term);
    if (index !== -1) {
      return { index, length: term.length };
    }
  }
  return null;
}

function buildBoundedSnippet(text: string, query: string, limit = SOURCE_SNIPPET_LIMIT): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  const match = findMatchIndex(compact, query);
  if (!match) return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
  const start = Math.max(0, match.index - Math.floor((limit - match.length) / 2));
  const boundedStart = Math.min(start, Math.max(0, compact.length - limit));
  const end = Math.min(compact.length, boundedStart + limit);
  const prefix = boundedStart > 0 ? '…' : '';
  const suffix = end < compact.length ? '…' : '';
  const available = Math.max(0, limit - prefix.length - suffix.length);
  const snippet = compact.slice(boundedStart, boundedStart + available).trim();
  return `${prefix}${snippet}${suffix}`;
}

function loadPersistedSpans(
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

function spanKey(span: {
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

function matchPersistedSpan(
  spans: ReadonlyMap<string, PersistedSpanRow>,
  span: KnowledgeSourceSpan | null | undefined,
): PersistedSpanRow | null {
  if (!span) return null;
  return spans.get(spanKey(span)) ?? null;
}

function searchFieldRankClass(span: PersistedSpanRow | null): number {
  return span ? EXTRACTION_MATCH_RANK_CLASS : METADATA_MATCH_RANK_CLASS;
}

function searchableField(text: string, weight: number, span: PersistedSpanRow | null): SearchableField {
  return {
    text,
    weight,
    rankClass: searchFieldRankClass(span),
    span,
  };
}

function redactTaskResult(taskResult: WorkspaceSearchResult): WorkspaceSearchResult {
  return {
    ...taskResult,
    taskTitle: redactLines(taskResult.taskTitle),
    matches: taskResult.matches.map((match) => ({
      ...match,
      text: redactLines(match.text),
    })),
  };
}

function parseExtractionSearchData(db: Database.Database, row: SourceSearchRow): ExtractionSearchData | null {
  if (!row.source_version_id || !row.extraction_id || !row.extraction_result_json) return null;
  if (Buffer.byteLength(row.extraction_result_json, 'utf8') > MAX_EXTRACTION_JSON_BYTES) return null;
  try {
    const extraction = validateDeterministicExtraction(JSON.parse(row.extraction_result_json) as unknown);
    const persistedSpans = loadPersistedSpans(db, row.project_id, row.source_version_id);
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
    const fields: SearchableField[] = [
      ...extraction.symbols.slice(0, MAX_EXTRACTION_SYMBOLS).flatMap((symbol) => [
        ...(symbol.qualifiedName
          ? [
              searchableField(
                redactLines(symbol.qualifiedName),
                10,
                matchPersistedSpan(spans, symbol.span),
              ),
            ]
          : []),
        searchableField(redactLines(symbol.name), 8, matchPersistedSpan(spans, symbol.span)),
      ]),
      ...extraction.sections.slice(0, MAX_EXTRACTION_SECTIONS).flatMap((section) => [
        ...(section.title
          ? [
              searchableField(redactLines(section.title), 7, matchPersistedSpan(spans, section.span)),
            ]
          : []),
        searchableField(redactLines(section.text), 5, matchPersistedSpan(spans, section.span)),
      ]),
      { text: redactLines(extraction.title), weight: 6, rankClass: METADATA_MATCH_RANK_CLASS, span: null },
      { text: redactLines(extraction.summary), weight: 3, rankClass: METADATA_MATCH_RANK_CLASS, span: null },
    ].slice(0, MAX_SEARCH_FIELDS);
    return {
      extractionId: row.extraction_id,
      analyzerId: row.extraction_analyzer_id,
      analyzerVersion: row.extraction_analyzer_version,
      fields,
      symbolKinds: extraction.symbols.slice(0, MAX_EXTRACTION_SYMBOLS).map((symbol) => symbol.kind),
    };
  } catch {
    return null;
  }
}

function sourceCitationFromMatch(row: SourceSearchRow, span: PersistedSpanRow | null): KnowledgeSearchCitation {
  const path = row.source_path ?? row.content_path;
  return {
    pageId: null,
    sourceId: row.id as KnowledgeSourceId,
    path: path ? redactLines(path) : null,
    url: row.source_url ? redactLines(row.source_url) : null,
    span:
      span === null
        ? null
        : {
            id: span.id,
            startOffset: span.start_offset,
            endOffset: span.end_offset,
            ...(span.start_line !== null ? { startLine: span.start_line } : {}),
            ...(span.start_column !== null ? { startColumn: span.start_column } : {}),
            ...(span.end_line !== null ? { endLine: span.end_line } : {}),
            ...(span.end_column !== null ? { endColumn: span.end_column } : {}),
            label: span.label ? redactLines(span.label) : span.label,
          },
  };
}

function withGraphExpansions(result: KnowledgeSearchResult, options: KnowledgeSearchOptions): KnowledgeSearchResult {
  if (!options.graphExpansion) return result;
  const maxGraphExpansions = options.maxGraphExpansions ?? 3;
  const expansions = options
    .graphExpansion(result)
    .slice(0, Math.max(0, maxGraphExpansions))
    .map((expansion) => ({
      ...expansion,
      title: redactLines(expansion.title),
      text: redactLines(expansion.text),
    }));
  return { ...result, graphExpansions: expansions };
}

function searchPages(query: string, options: KnowledgeSearchOptions): KnowledgeSearchResult[] {
  const results: RankedKnowledgeSearchResult[] = [];
  for (const row of pageRows(options.db, options.projectId)) {
    const score = lexicalScore(query, [
      { text: row.title, weight: 6 },
      { text: row.slug, weight: 4 },
      { text: row.summary, weight: 3 },
      { text: row.content_path, weight: 1 },
      { text: row.page_type, weight: 1 },
    ]);
    if (score === 0) continue;
    results.push(
      withGraphExpansions(
        {
          mode: options.mode ?? 'knowledge',
          kind: 'page',
          id: row.id,
          projectId: row.project_id as KnowledgeProjectId,
          title: redactLines(row.title),
          snippet: redactLines(row.summary ?? row.slug),
          score,
          citations: citationsForPage(options.db, options.projectId, row.id, row.version_id),
          graphExpansions: [],
          metadata: {
            type: row.page_type,
            slug: redactLines(row.slug),
            contentPath: row.content_path ? redactLines(row.content_path) : null,
            versionId: row.version_id,
          },
        },
        options,
      ),
    );
  }
  return results;
}

function searchSources(query: string, options: KnowledgeSearchOptions): KnowledgeSearchResult[] {
  const mode = options.mode ?? 'sources';
  const extractionCache = new Map<string, ExtractionSearchData | null>();
  const rows = sourceRows(options.db, options.projectId);
  const queryTerms = terms(query);
  const documentFrequency = new Map<string, number>();
  const searchableDocuments = rows.map((row) => {
    const extractionData =
      extractionCache.get(row.extraction_id ?? row.id) ??
      parseExtractionSearchData(options.db, row);
    extractionCache.set(row.extraction_id ?? row.id, extractionData);
    const fields = [
      ...(extractionData?.fields.map((field) => field.text) ?? []),
      row.source_path,
      row.source_url,
      row.content_path,
      row.source_kind,
      row.mime_type,
      row.current_hash,
    ]
      .filter((text): text is string => Boolean(text));
    const presentTerms = new Set(
      queryTerms.filter((term) =>
        termVariants(term).some((variant) =>
          fields.some((field) => normalize(field).includes(variant)),
        ),
      ),
    );
    return { row, extractionData, presentTerms };
  });
  for (const term of queryTerms) {
    const count = searchableDocuments.filter(({ presentTerms }) => presentTerms.has(term)).length;
    documentFrequency.set(term, count);
  }
  const termWeights = new Map(
    queryTerms.map((term) => [
      term,
      Math.log((searchableDocuments.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1,
    ]),
  );
  const results: RankedKnowledgeSearchResult[] = [];
  for (const { row, extractionData } of searchableDocuments) {
    const title = redactLines(row.source_path ?? row.source_url ?? row.content_path ?? row.id);
    const fieldMatches =
      extractionData?.fields
        .map((field) => ({
          field,
          score: lexicalScoreWithTermWeights(query, [{ text: field.text, weight: field.weight }], termWeights),
        }))
        .filter((match) => match.score > 0) ?? [];
    const rankedFieldMatches = fieldMatches.sort(
        (left, right) =>
          right.field.rankClass - left.field.rankClass || right.score - left.score || right.field.weight - left.field.weight,
      );
    const bestMatch = rankedFieldMatches[0] ?? null;
    const citationMatch = rankedFieldMatches.find((match) => match.field.span) ?? bestMatch;
    const extractionScore = rankedFieldMatches
      .slice(0, 5)
      .reduce((sum, match) => sum + match.score, 0);
    const metadataScore = lexicalScore(query, [
      { text: row.source_path, weight: 2 },
      { text: row.source_url, weight: 2 },
      { text: row.content_path, weight: 2 },
      { text: row.source_kind, weight: 1 },
      { text: row.mime_type, weight: 1 },
      { text: row.current_hash, weight: 1 },
    ]);
    const structuralBonus = bestMatch ? structuralScore(query, row, extractionData) : 0;
    const rankClass = bestMatch ? bestMatch.field.rankClass : metadataScore > 0 ? METADATA_MATCH_RANK_CLASS : DEFAULT_MATCH_RANK_CLASS;
    const score = bestMatch
      ? extractionScore + Math.min(metadataScore * 4, extractionScore) + structuralBonus
      : metadataScore + structuralBonus;
    if (score === 0 || (!bestMatch && metadataScore === 0)) continue;
    const result = withGraphExpansions(
      {
        mode,
        kind: 'source',
        id: row.id,
        projectId: row.project_id as KnowledgeProjectId,
        title,
        snippet: bestMatch
          ? buildBoundedSnippet(bestMatch.field.text, query)
          : buildBoundedSnippet(redactLines(row.content_path ?? row.source_url ?? row.source_path ?? ''), query),
        score,
        citations: [citationMatch ? sourceCitationFromMatch(row, citationMatch.field.span) : sourceCitation(row)],
        graphExpansions: [],
        metadata: {
          kind: row.source_kind,
          contentHash: row.current_hash,
          mimeType: row.mime_type,
          sourceVersionId: row.source_version_id,
          extractionId: extractionData?.extractionId ?? null,
          analyzerId: extractionData?.analyzerId ?? null,
          analyzerVersion: extractionData?.analyzerVersion ?? null,
        },
      },
      options,
    ) as RankedKnowledgeSearchResult;
    result.rankClass = rankClass;
    results.push(result);
  }
  return results;
}

function searchTasks(query: string, options: KnowledgeSearchOptions): KnowledgeSearchResult[] {
  if (!options.taskStore) return [];
  return searchWorkspace(options.taskStore, query, { limit: options.limit ?? DEFAULT_LIMIT }).map((taskResult) => {
    const redactedTaskResult = redactTaskResult(taskResult);
    return (
    withGraphExpansions(
      {
        mode: options.mode ?? 'tasks',
        kind: 'task',
        id: redactedTaskResult.taskId,
        projectId: null,
        title: redactedTaskResult.taskTitle,
        snippet: redactedTaskResult.matches.map((match) => match.text).join('\n'),
        score: redactedTaskResult.matches.length * 10,
        citations: [],
        graphExpansions: [],
        taskResult: redactedTaskResult,
        metadata: {
          taskStatus: redactedTaskResult.taskStatus,
        },
      },
      options,
    )
    );
  });
}

function dedupeResults(results: KnowledgeSearchResult[]): KnowledgeSearchResult[] {
  const seen = new Set<string>();
  const deduped: RankedKnowledgeSearchResult[] = [];
  for (const result of results) {
    const key = `${result.kind}:${result.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function sortResults(a: KnowledgeSearchResult, b: KnowledgeSearchResult): number {
  const leftRank = (a as RankedKnowledgeSearchResult).rankClass ?? DEFAULT_MATCH_RANK_CLASS;
  const rightRank = (b as RankedKnowledgeSearchResult).rankClass ?? DEFAULT_MATCH_RANK_CLASS;
  if (a.kind === 'source' && b.kind === 'source' && rightRank !== leftRank) {
    return rightRank - leftRank;
  }
  if (b.score !== a.score) return b.score - a.score;
  const title = a.title.localeCompare(b.title);
  if (title !== 0) return title;
  return a.id.localeCompare(b.id);
}

export function searchKnowledge(query: string, options: KnowledgeSearchOptions): KnowledgeSearchResult[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  if (normalizedQuery.length > MAX_QUERY_LENGTH) return [];
  if (Buffer.byteLength(normalizedQuery, 'utf8') > MAX_QUERY_BYTES) return [];

  const mode = options.mode ?? 'hybrid';
  const scopedOptions: KnowledgeSearchOptions = { ...options, mode };
  const resultSets: KnowledgeSearchResult[][] = [];
  if (mode === 'knowledge') {
    resultSets.push(searchPages(normalizedQuery, scopedOptions));
  } else if (mode === 'sources' || mode === 'read-sources-only') {
    resultSets.push(searchSources(normalizedQuery, scopedOptions));
  } else if (mode === 'tasks') {
    resultSets.push(searchTasks(normalizedQuery, scopedOptions));
  } else {
    resultSets.push(searchPages(normalizedQuery, scopedOptions), searchSources(normalizedQuery, scopedOptions), searchTasks(normalizedQuery, scopedOptions));
  }

  return dedupeResults(resultSets.flat())
    .sort(sortResults)
    .slice(0, Math.min(MAX_RESULT_CANDIDATES, options.limit ?? DEFAULT_LIMIT));
}

function resultBudgetText(result: KnowledgeSearchResult): string {
  const graphText = result.graphExpansions.map((expansion) => `${expansion.title}\n${expansion.text}`).join('\n');
  const citationsText = result.citations
    .map((citation) =>
      [
        citation.pageId ?? '',
        citation.sourceId ?? '',
        citation.path ?? '',
        citation.url ?? '',
        citation.span ? `${citation.span.startOffset}-${citation.span.endOffset}:${citation.span.label ?? ''}` : '',
      ].join(' '),
    )
    .join('\n');
  const taskText = result.taskResult?.matches.map((match) => `${match.category}:${match.text}`).join('\n') ?? '';
  const metadataText = JSON.stringify(result.metadata);
  return `${result.title}\n${result.snippet}\n${citationsText}\n${taskText}\n${metadataText}\n${graphText}`;
}

function resultTokenCost(result: KnowledgeSearchResult): number {
  return estimateTokens(resultBudgetText(result));
}

function expansionCost(expansion: KnowledgeSearchGraphExpansion): number {
  return expansion.tokens ?? estimateTokens(`${expansion.title}\n${expansion.text}`);
}

export function buildKnowledgeSearchContext(
  results: KnowledgeSearchResult[],
  options: KnowledgeSearchContextOptions = {},
): KnowledgeSearchContext {
  const tokenBudget = options.tokenBudget ?? 2000;
  let remaining = tokenBudget;
  const included: KnowledgeSearchResult[] = [];
  const truncated: Record<string, number> = {};

  for (const result of results) {
    const keptExpansions: KnowledgeSearchGraphExpansion[] = [];
    let expansionTokens = 0;
    for (const expansion of result.graphExpansions) {
      const cost = expansionCost(expansion);
      if (expansionTokens + cost <= remaining) {
        keptExpansions.push(expansion);
        expansionTokens += cost;
      } else {
        truncated.graphExpansions = (truncated.graphExpansions ?? 0) + 1;
      }
    }

    const candidate = { ...result, graphExpansions: keptExpansions };
    const cost = resultTokenCost(candidate);
    if (cost <= remaining) {
      remaining -= cost;
      included.push(candidate);
    } else {
      truncated.results = (truncated.results ?? 0) + 1;
    }
  }

  return { results: included, truncated };
}
