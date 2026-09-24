import type Database from 'better-sqlite3';
import { estimateTokens } from '../ContextBuilder.js';
import { searchWorkspace, type SearchResult as WorkspaceSearchResult } from '../Search.js';
import type { TaskStore } from '../TaskStore.js';
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
  content_path: string | null;
  mime_type: string | null;
}

interface CitationRow {
  page_id: string | null;
  source_id: string | null;
  source_path: string | null;
  source_url: string | null;
  span_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  label: string | null;
}

const DEFAULT_LIMIT = 20;

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function terms(query: string): string[] {
  return normalize(query).split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export function lexicalScore(query: string, weightedFields: Array<{ text: string | null; weight: number }>): number {
  const phrase = normalize(query);
  const queryTerms = terms(query);
  if (!phrase || queryTerms.length === 0) return 0;

  let score = 0;
  for (const field of weightedFields) {
    const text = normalize(field.text ?? '');
    if (!text) continue;
    if (text.includes(phrase)) score += field.weight * 4;
    for (const term of queryTerms) {
      score += countOccurrences(text, term) * field.weight;
    }
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
              v.content_path, v.mime_type
       FROM knowledge_sources s
       LEFT JOIN knowledge_source_versions v
         ON v.project_id = s.project_id
        AND v.source_id = s.id
        AND v.version_number = (
          SELECT MAX(version_number)
          FROM knowledge_source_versions latest
          WHERE latest.project_id = s.project_id AND latest.source_id = s.id
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
    path: row.source_path,
    url: row.source_url,
    span:
      row.span_id === null || row.start_offset === null || row.end_offset === null
        ? null
        : {
            id: row.span_id,
            startOffset: row.start_offset,
            endOffset: row.end_offset,
            label: row.label,
          },
  };
}

function sourceCitation(row: SourceSearchRow): KnowledgeSearchCitation {
  return {
    pageId: null,
    sourceId: row.id as KnowledgeSourceId,
    path: row.source_path ?? row.content_path,
    url: row.source_url,
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
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(citation);
  }
  return deduped;
}

function withGraphExpansions(result: KnowledgeSearchResult, options: KnowledgeSearchOptions): KnowledgeSearchResult {
  if (!options.graphExpansion) return result;
  const maxGraphExpansions = options.maxGraphExpansions ?? 3;
  const expansions = options.graphExpansion(result).slice(0, Math.max(0, maxGraphExpansions));
  return { ...result, graphExpansions: expansions };
}

function searchPages(query: string, options: KnowledgeSearchOptions): KnowledgeSearchResult[] {
  const results: KnowledgeSearchResult[] = [];
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
          title: row.title,
          snippet: row.summary ?? row.slug,
          score,
          citations: citationsForPage(options.db, options.projectId, row.id, row.version_id),
          graphExpansions: [],
          metadata: {
            type: row.page_type,
            slug: row.slug,
            contentPath: row.content_path,
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
  const results: KnowledgeSearchResult[] = [];
  for (const row of sourceRows(options.db, options.projectId)) {
    const title = row.source_path ?? row.source_url ?? row.content_path ?? row.id;
    const score = lexicalScore(query, [
      { text: row.source_path, weight: 6 },
      { text: row.source_url, weight: 6 },
      { text: row.content_path, weight: 4 },
      { text: row.source_kind, weight: 1 },
      { text: row.mime_type, weight: 1 },
      { text: row.current_hash, weight: 1 },
    ]);
    if (score === 0) continue;
    results.push(
      withGraphExpansions(
        {
          mode,
          kind: 'source',
          id: row.id,
          projectId: row.project_id as KnowledgeProjectId,
          title,
          snippet: row.content_path ?? row.source_url ?? row.source_path ?? '',
          score,
          citations: [sourceCitation(row)],
          graphExpansions: [],
          metadata: {
            kind: row.source_kind,
            contentHash: row.current_hash,
            mimeType: row.mime_type,
          },
        },
        options,
      ),
    );
  }
  return results;
}

function searchTasks(query: string, options: KnowledgeSearchOptions): KnowledgeSearchResult[] {
  if (!options.taskStore) return [];
  return searchWorkspace(options.taskStore, query, { limit: options.limit ?? DEFAULT_LIMIT }).map((taskResult) =>
    withGraphExpansions(
      {
        mode: options.mode ?? 'tasks',
        kind: 'task',
        id: taskResult.taskId,
        projectId: null,
        title: taskResult.taskTitle,
        snippet: taskResult.matches.map((match) => match.text).join('\n'),
        score: taskResult.matches.length * 10,
        citations: [],
        graphExpansions: [],
        taskResult,
        metadata: {
          taskStatus: taskResult.taskStatus,
        },
      },
      options,
    ),
  );
}

function dedupeResults(results: KnowledgeSearchResult[]): KnowledgeSearchResult[] {
  const seen = new Set<string>();
  const deduped: KnowledgeSearchResult[] = [];
  for (const result of results) {
    const key = `${result.kind}:${result.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function sortResults(a: KnowledgeSearchResult, b: KnowledgeSearchResult): number {
  if (b.score !== a.score) return b.score - a.score;
  const title = a.title.localeCompare(b.title);
  if (title !== 0) return title;
  return a.id.localeCompare(b.id);
}

export function searchKnowledge(query: string, options: KnowledgeSearchOptions): KnowledgeSearchResult[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

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

  return dedupeResults(resultSets.flat()).sort(sortResults).slice(0, options.limit ?? DEFAULT_LIMIT);
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
