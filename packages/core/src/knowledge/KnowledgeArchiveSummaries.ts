import { importRejected } from './KnowledgeArchiveCompatibility.js';
import { KNOWLEDGE_SUMMARY_SCOPE_KINDS, KNOWLEDGE_SUMMARY_STRATEGIES } from './KnowledgeSemanticSummaryTypes.js';
import {
  parseBoundedSummaryJson,
  parseSemanticSummaryPayload,
  parseSemanticSummaryWarnings,
} from './KnowledgeSemanticSummaryPersistence.js';

export const KNOWLEDGE_SEMANTIC_SUMMARIES_TABLE = 'knowledge_semantic_summaries';

export interface ArchiveSummaryScopes {
  projectId: string;
  sourceVersionIds: ReadonlySet<string>;
  pageVersionIds: ReadonlySet<string>;
}

/** Archives never carry the host-local provider profile name; `NULL` is exported and required on import. */
export function redactSummaryRowsForExport(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row, provider_profile_name: null }));
}

export function assertArchiveSummaryRows(rows: readonly Record<string, unknown>[], scopes: ArchiveSummaryScopes): void {
  for (const [index, row] of rows.entries()) {
    const label = `table ${KNOWLEDGE_SEMANTIC_SUMMARIES_TABLE} row ${index + 1}`;
    const scopeKind = row.scope_kind;
    if (typeof scopeKind !== 'string' || !(KNOWLEDGE_SUMMARY_SCOPE_KINDS as readonly string[]).includes(scopeKind)) {
      throw importRejected(`${label} column scope_kind is not supported.`);
    }
    if (typeof row.strategy !== 'string' || !(KNOWLEDGE_SUMMARY_STRATEGIES as readonly string[]).includes(row.strategy)) {
      throw importRejected(`${label} column strategy is not supported.`);
    }
    if (row.provider_profile_name !== null && row.provider_profile_name !== undefined) {
      throw importRejected(`${label} column provider_profile_name must be null in an archive.`);
    }
    if (!scopeResolves(scopeKind, row.scope_id, scopes)) {
      throw importRejected(`${label} column scope_id must reference a ${scopeKind} inside the archive.`);
    }
    try {
      parseSemanticSummaryPayload(parseBoundedSummaryJson(row.summary_json, 'summary_json'));
    } catch (error) {
      throw importRejected(`${label} column summary_json is invalid: ${errorText(error)}.`);
    }
    try {
      parseSemanticSummaryWarnings(parseBoundedSummaryJson(row.warnings_json, 'warnings_json'));
    } catch (error) {
      throw importRejected(`${label} column warnings_json is invalid: ${errorText(error)}.`);
    }
  }
}

function scopeResolves(scopeKind: string, scopeId: unknown, scopes: ArchiveSummaryScopes): boolean {
  if (typeof scopeId !== 'string' || scopeId.length === 0) return false;
  if (scopeKind === 'source_version') return scopes.sourceVersionIds.has(scopeId);
  if (scopeKind === 'page_version') return scopes.pageVersionIds.has(scopeId);
  return scopeId === scopes.projectId;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
