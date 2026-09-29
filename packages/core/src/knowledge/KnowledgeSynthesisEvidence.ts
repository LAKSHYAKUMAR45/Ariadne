import type Database from 'better-sqlite3';
import { createKnowledgeId } from './KnowledgeIds.js';
import { deriveCitationContext, tryParseCitationContext } from './KnowledgeCitationContext.js';
import type { KnowledgeSearchCitation, KnowledgeSearchResult } from './KnowledgeSearch.js';
import type { KnowledgeSynthesisClaimConfidence, KnowledgeSynthesisEvidence } from './KnowledgeSynthesisTypes.js';

export const MAX_EVIDENCE_RESULTS = 8;
export const MAX_CITATIONS_PER_RESULT = 3;
export const MAX_EVIDENCE_ENTRIES = 12;
export const MAX_EVIDENCE_TITLE = 160;
export const MAX_EVIDENCE_SNIPPET = 240;

export type TextRedactor = (value: string) => string;

export interface EvidenceGroup {
  resultId: string;
  kind: KnowledgeSearchResult['kind'];
  title: string;
  taskStatus: string | null;
  /** True only for a source result with a span-backed citation; page and task evidence are never upgraded. */
  exact: boolean;
  entries: KnowledgeSynthesisEvidence[];
  snippet: string | null;
}

export interface EvidencePack {
  groups: EvidenceGroup[];
  evidence: KnowledgeSynthesisEvidence[];
  resultLimitReached: boolean;
}

export function clip(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export function citationKey(citation: KnowledgeSearchCitation): string {
  return [citation.pageId ?? '', citation.sourceId ?? '', citation.path ?? '', citation.url ?? '', citation.span?.id ?? ''].join('\0');
}

export function dedupeCitationList(citations: KnowledgeSearchCitation[]): KnowledgeSearchCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citationKey(citation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isExactCitation(citation: KnowledgeSearchCitation | null): boolean {
  const context = citation?.context;
  return (
    context !== undefined &&
    context.sourceSpanId !== null &&
    (context.matchKind === 'exact_span' || context.matchKind === 'section_span')
  );
}

export function claimConfidence(entries: readonly KnowledgeSynthesisEvidence[]): KnowledgeSynthesisClaimConfidence {
  if (entries.some((entry) => entry.searchConfidence === 'ambiguous')) return 'ambiguous';
  return entries.length > 0 && entries.every((entry) => entry.searchConfidence === 'clear') ? 'clear' : 'unassessed';
}

function withContext(db: Database.Database, projectId: string, citation: KnowledgeSearchCitation): KnowledgeSearchCitation {
  if (tryParseCitationContext(citation.context) !== null) return citation;
  return { ...citation, context: deriveCitationContext(db, projectId, citation) };
}

function orderCitations(citations: KnowledgeSearchCitation[]): KnowledgeSearchCitation[] {
  return [...citations].sort(
    (left, right) =>
      (left.path ?? left.url ?? '').localeCompare(right.path ?? right.url ?? '') ||
      (left.span?.startOffset ?? 0) - (right.span?.startOffset ?? 0),
  );
}

function evidenceId(result: KnowledgeSearchResult, citation: KnowledgeSearchCitation | null): string {
  return createKnowledgeId('evidence', [result.kind, result.id, citation === null ? 'none' : citationKey(citation)].join('|'));
}

/** Converts bounded search results into evidence: at most 8 results, 3 citations each, 12 entries overall. */
export function buildEvidencePack(
  db: Database.Database,
  projectId: string,
  results: KnowledgeSearchResult[],
  redactText: TextRedactor,
  droppedByContext: boolean,
): EvidencePack {
  const groups: EvidenceGroup[] = [];
  const evidence: KnowledgeSynthesisEvidence[] = [];
  let resultLimitReached = droppedByContext || results.length > MAX_EVIDENCE_RESULTS;

  for (const [index, result] of results.slice(0, MAX_EVIDENCE_RESULTS).entries()) {
    const citations = orderCitations(dedupeCitationList(result.citations))
      .slice(0, MAX_CITATIONS_PER_RESULT)
      .map((citation) => withContext(db, projectId, citation));
    const slots: Array<KnowledgeSearchCitation | null> = citations.length === 0 ? [null] : citations;
    if (evidence.length + slots.length > MAX_EVIDENCE_ENTRIES) {
      resultLimitReached = true;
      break;
    }
    const title = clip(redactText(result.title), MAX_EVIDENCE_TITLE);
    const entries = slots.map<KnowledgeSynthesisEvidence>((citation) => ({
      id: evidenceId(result, citation),
      resultId: result.id,
      kind: result.kind,
      title,
      path: citation?.path ?? null,
      url: citation?.url ?? null,
      rank: index + 1,
      citation,
      snippetPolicy: 'reference_only',
      ephemeralSnippet: null,
      searchConfidence: result.searchConfidence ?? null,
      ambiguityReason: result.ambiguityReason ?? null,
    }));
    const status = result.metadata.taskStatus;
    groups.push({
      resultId: result.id,
      kind: result.kind,
      title,
      taskStatus: typeof status === 'string' ? clip(redactText(status), 40) : null,
      exact: result.kind === 'source' && citations.some((citation) => isExactCitation(citation)),
      entries,
      snippet:
        result.kind === 'task' || result.snippet.trim().length === 0
          ? null
          : clip(redactText(result.snippet), MAX_EVIDENCE_SNIPPET),
    });
    evidence.push(...entries);
  }
  return { groups, evidence, resultLimitReached };
}
