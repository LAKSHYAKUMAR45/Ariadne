import type Database from 'better-sqlite3';
import type { KnowledgeSearchCitation } from './KnowledgeSearch.js';

export type KnowledgeCitationFieldKind =
  | 'section'
  | 'symbol'
  | 'summary'
  | 'page_provenance'
  | 'path_metadata'
  | 'task'
  | 'graph';

export type KnowledgeCitationMatchKind =
  | 'exact_span'
  | 'section_span'
  | 'metadata_only'
  | 'page_provenance'
  | 'legacy_unknown';

export type KnowledgeCitationSnippetPolicy = 'reference_only' | 'ephemeral_redacted';
export type KnowledgeCitationLegacyState = 'current' | 'legacy_payload' | 'legacy_unknown';

/** Additive, reference-only citation metadata. It never carries source text. */
export interface KnowledgeCitationContext {
  sourceVersionId: string | null;
  sourceSpanId: string | null;
  fieldKind: KnowledgeCitationFieldKind;
  fieldLabel: string | null;
  matchKind: KnowledgeCitationMatchKind;
  snippetPolicy: KnowledgeCitationSnippetPolicy;
  startLineWindow: number | null;
  endLineWindow: number | null;
  legacyState: KnowledgeCitationLegacyState;
}

export interface CitationContextOptions {
  includeEphemeralExcerpt?: boolean;
  excerptLineRadius?: number;
}

const FIELD_KINDS: ReadonlySet<string> = new Set<KnowledgeCitationFieldKind>([
  'section',
  'symbol',
  'summary',
  'page_provenance',
  'path_metadata',
  'task',
  'graph',
]);
const MATCH_KINDS: ReadonlySet<string> = new Set<KnowledgeCitationMatchKind>([
  'exact_span',
  'section_span',
  'metadata_only',
  'page_provenance',
  'legacy_unknown',
]);
const SNIPPET_POLICIES: ReadonlySet<string> = new Set<KnowledgeCitationSnippetPolicy>([
  'reference_only',
  'ephemeral_redacted',
]);
const LEGACY_STATES: ReadonlySet<string> = new Set<KnowledgeCitationLegacyState>([
  'current',
  'legacy_payload',
  'legacy_unknown',
]);
const CONTEXT_KEYS: readonly (keyof KnowledgeCitationContext)[] = [
  'sourceVersionId',
  'sourceSpanId',
  'fieldKind',
  'fieldLabel',
  'matchKind',
  'snippetPolicy',
  'startLineWindow',
  'endLineWindow',
  'legacyState',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function nullableString(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`Knowledge citation context ${key} must be a string or null`);
  return value;
}

function lineWindow(value: unknown, key: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Knowledge citation context ${key} must be a non-negative integer or null`);
  }
  return value;
}

function member<T extends string>(value: unknown, allowed: ReadonlySet<string>, key: string): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`Knowledge citation context ${key} is not a supported value`);
  }
  return value as T;
}

/** Strictly validates a persisted context; unknown keys (for example excerpt text) are rejected. */
export function parseCitationContext(value: unknown): KnowledgeCitationContext {
  if (!isPlainObject(value)) throw new Error('Knowledge citation context must be a plain object');
  for (const key of Object.keys(value)) {
    if (!(CONTEXT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Knowledge citation context contains unknown key ${key}`);
    }
  }
  for (const key of CONTEXT_KEYS) {
    if (value[key] === undefined) throw new Error(`Knowledge citation context is missing ${key}`);
  }
  const startLineWindow = lineWindow(value.startLineWindow, 'startLineWindow');
  const endLineWindow = lineWindow(value.endLineWindow, 'endLineWindow');
  if (startLineWindow !== null && endLineWindow !== null && startLineWindow > endLineWindow) {
    throw new Error('Knowledge citation context startLineWindow must not exceed endLineWindow');
  }
  return {
    sourceVersionId: nullableString(value.sourceVersionId, 'sourceVersionId'),
    sourceSpanId: nullableString(value.sourceSpanId, 'sourceSpanId'),
    fieldKind: member<KnowledgeCitationFieldKind>(value.fieldKind, FIELD_KINDS, 'fieldKind'),
    fieldLabel: nullableString(value.fieldLabel, 'fieldLabel'),
    matchKind: member<KnowledgeCitationMatchKind>(value.matchKind, MATCH_KINDS, 'matchKind'),
    snippetPolicy: member<KnowledgeCitationSnippetPolicy>(value.snippetPolicy, SNIPPET_POLICIES, 'snippetPolicy'),
    startLineWindow,
    endLineWindow,
    legacyState: member<KnowledgeCitationLegacyState>(value.legacyState, LEGACY_STATES, 'legacyState'),
  };
}

/** Returns the validated context, or null when the value is absent or not a valid context. */
export function tryParseCitationContext(value: unknown): KnowledgeCitationContext | null {
  if (value === undefined) return null;
  try {
    return parseCitationContext(value);
  } catch {
    return null;
  }
}

/** Whitelists context keys and forces reference-only persistence. */
export function toPersistedCitationContext(context: KnowledgeCitationContext): KnowledgeCitationContext {
  return {
    sourceVersionId: context.sourceVersionId,
    sourceSpanId: context.sourceSpanId,
    fieldKind: context.fieldKind,
    fieldLabel: context.fieldLabel,
    matchKind: context.matchKind,
    snippetPolicy: 'reference_only',
    startLineWindow: context.startLineWindow,
    endLineWindow: context.endLineWindow,
    legacyState: context.legacyState,
  };
}

/**
 * Builds an explicit context for citations that predate persisted context. It
 * reuses only identifiers already present on the citation and never invents a
 * source version or a field detail it cannot know.
 */
export function legacyCitationContext(
  citation: KnowledgeSearchCitation,
  legacyState: Exclude<KnowledgeCitationLegacyState, 'current'>,
): KnowledgeCitationContext {
  const span = citation.span;
  return {
    sourceVersionId: null,
    sourceSpanId: span?.id ?? null,
    fieldKind: citation.pageId !== null ? 'page_provenance' : 'path_metadata',
    fieldLabel: span?.label ?? null,
    matchKind: 'legacy_unknown',
    snippetPolicy: 'reference_only',
    startLineWindow: span?.startLine ?? null,
    endLineWindow: span?.endLine ?? null,
    legacyState,
  };
}

interface SpanRow {
  source_version_id: string;
}

function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
}

function indexedFieldKind(db: Database.Database, projectId: string, spanId: string): KnowledgeCitationFieldKind {
  if (!hasTable(db, 'knowledge_search_index_fields')) return 'section';
  const row = db
    .prepare(
      `SELECT field_kind FROM knowledge_search_index_fields
       WHERE project_id = ? AND span_id = ? AND field_kind IN ('section', 'symbol')
       ORDER BY field_order ASC LIMIT 1`,
    )
    .get(projectId, spanId) as { field_kind: 'section' | 'symbol' } | undefined;
  return row?.field_kind ?? 'section';
}

/** Derives reference-only context for a citation produced by current search, verifying persisted spans. */
export function deriveCitationContext(
  db: Database.Database,
  projectId: string,
  citation: KnowledgeSearchCitation,
): KnowledgeCitationContext {
  const pageBacked = citation.pageId !== null;
  const base: KnowledgeCitationContext = {
    sourceVersionId: null,
    sourceSpanId: null,
    fieldKind: pageBacked ? 'page_provenance' : 'path_metadata',
    fieldLabel: citation.span?.label ?? null,
    matchKind: pageBacked ? 'page_provenance' : 'metadata_only',
    snippetPolicy: 'reference_only',
    startLineWindow: null,
    endLineWindow: null,
    legacyState: 'current',
  };
  const span = citation.span;
  if (span === null) return base;

  const row = db
    .prepare(
      `SELECT span.source_version_id AS source_version_id
       FROM knowledge_source_spans span
       JOIN knowledge_source_versions version
         ON version.project_id = span.project_id AND version.id = span.source_version_id
       WHERE span.project_id = @projectId
         AND span.id = @spanId
         AND (@sourceId IS NULL OR version.source_id = @sourceId)`,
    )
    .get({ projectId, spanId: span.id, sourceId: citation.sourceId }) as SpanRow | undefined;
  if (row === undefined) return base;

  return {
    ...base,
    sourceVersionId: row.source_version_id,
    sourceSpanId: span.id,
    fieldKind: pageBacked ? 'page_provenance' : indexedFieldKind(db, projectId, span.id),
    matchKind: pageBacked ? 'page_provenance' : 'exact_span',
    startLineWindow: span.startLine ?? null,
    endLineWindow: span.endLine ?? null,
  };
}
