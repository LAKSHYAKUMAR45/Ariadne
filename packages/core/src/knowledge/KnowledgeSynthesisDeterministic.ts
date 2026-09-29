import { createKnowledgeId } from './KnowledgeIds.js';
import {
  citationKey,
  claimConfidence,
  clip,
  dedupeCitationList,
  type EvidenceGroup,
  type EvidencePack,
  type TextRedactor,
} from './KnowledgeSynthesisEvidence.js';
import type { KnowledgeSearchMode, KnowledgeSearchResult } from './KnowledgeSearch.js';
import type {
  KnowledgeSynthesisClaim,
  KnowledgeSynthesisEvidence,
  KnowledgeSynthesisResult,
  KnowledgeSynthesisSection,
  KnowledgeSynthesisWarning,
} from './KnowledgeSynthesisTypes.js';

export const ANSWER_HEADING = 'Answer';
export const SUPPORTING_HEADING = 'Supporting evidence';
export const AMBIGUITY_HEADING = 'Open questions / ambiguity';
const MAX_ANSWER_GROUPS = 3;
const MAX_COMPETING_CANDIDATES = 3;
const MAX_CLAIM_TEXT = 300;
const MAX_LABEL = 80;

export interface LeadAmbiguity {
  resultId: string;
  reason: KnowledgeSearchResult['ambiguityReason'];
  alternatives: number | undefined;
}

export function findLeadAmbiguity(results: readonly KnowledgeSearchResult[]): LeadAmbiguity | null {
  const lead = results.find((result) => result.searchConfidence !== undefined);
  if (lead === undefined || lead.searchConfidence !== 'ambiguous') return null;
  return { resultId: lead.id, reason: lead.ambiguityReason, alternatives: lead.ambiguityAlternatives };
}

function stableId(prefix: string, query: string, heading: string, evidenceIds: readonly string[]): string {
  return createKnowledgeId(prefix, JSON.stringify([query, heading, evidenceIds]));
}

function lineRange(start: number | undefined, end: number | undefined): string {
  if (start === undefined) return '';
  return end === undefined || end === start ? ` (line ${start})` : ` (lines ${start}–${end})`;
}

function describeEntry(entry: KnowledgeSynthesisEvidence, redactText: TextRedactor): string {
  const citation = entry.citation;
  const label = citation?.context?.fieldLabel ?? citation?.span?.label ?? null;
  const kind = citation?.context?.fieldKind ?? 'span';
  const quoted = label === null ? '' : ` "${clip(redactText(label), MAX_LABEL)}"`;
  return `${kind}${quoted}${lineRange(citation?.span?.startLine, citation?.span?.endLine)}`;
}

/** Structural, extraction-derived prose only: titles, field kinds, labels, and line ranges; never excerpt text. */
export function describeGroup(group: EvidenceGroup, redactText: TextRedactor): string {
  let text: string;
  if (group.kind === 'task') {
    text = `Task "${group.title}"${group.taskStatus === null ? '' : ` (${group.taskStatus})`} is related to the question.`;
  } else if (group.kind === 'page') {
    const references = group.entries.filter((entry) => entry.citation !== null).length;
    text = `Page "${group.title}" is related${references === 0 ? '' : `; it cites ${references} source reference${references === 1 ? '' : 's'}`}.`;
  } else if (group.exact) {
    text = `${group.title}: ${group.entries.map((entry) => describeEntry(entry, redactText)).join('; ')}.`;
  } else {
    text = `${group.title} matches on path or metadata only; no exact source span was located.`;
  }
  return clip(text, MAX_CLAIM_TEXT);
}

function makeClaim(query: string, heading: string, text: string, entries: KnowledgeSynthesisEvidence[]): KnowledgeSynthesisClaim {
  const evidenceIds = entries.map((entry) => entry.id);
  return {
    id: stableId('claim', query, heading, evidenceIds),
    text,
    evidenceIds,
    citations: dedupeCitationList(entries.flatMap((entry) => (entry.citation === null ? [] : [entry.citation]))),
    confidence: claimConfidence(entries),
  };
}

export function makeSection(query: string, heading: string, claims: KnowledgeSynthesisClaim[]): KnowledgeSynthesisSection {
  return { id: stableId('section', query, heading, claims.flatMap((claim) => claim.evidenceIds)), heading, claims };
}

function groupClaim(query: string, heading: string, group: EvidenceGroup, redactText: TextRedactor): KnowledgeSynthesisClaim {
  return makeClaim(query, heading, describeGroup(group, redactText), group.entries);
}

const REASON_TEXT: Record<string, string> = {
  near_tie: 'several results scored almost equally',
  shared_role: 'several results play a similar role',
  insufficient_intent: 'the query gave too little intent to separate the results',
};

export function buildAmbiguitySection(
  query: string,
  pack: EvidencePack,
  lead: LeadAmbiguity | null,
  redactText: TextRedactor,
): KnowledgeSynthesisSection | null {
  const claims: KnowledgeSynthesisClaim[] = [];
  const leadGroup = lead === null ? undefined : pack.groups.find((group) => group.resultId === lead.resultId);
  if (lead !== null && leadGroup !== undefined) {
    const why = lead.reason === undefined ? 'the evidence is not decisive' : (REASON_TEXT[lead.reason] ?? 'the evidence is not decisive');
    claims.push(makeClaim(query, AMBIGUITY_HEADING, clip(`The leading result "${leadGroup.title}" is ambiguous because ${why}.`, MAX_CLAIM_TEXT), leadGroup.entries));
    const competing = pack.groups
      .filter((group) => group.kind === 'source' && group.resultId !== lead.resultId)
      .slice(0, Math.min(lead.alternatives ?? 0, MAX_COMPETING_CANDIDATES));
    for (const group of competing) {
      claims.push(makeClaim(query, AMBIGUITY_HEADING, `Competing candidate: ${describeGroup(group, redactText)}`.slice(0, MAX_CLAIM_TEXT), group.entries));
    }
  }
  if (pack.groups.length > 0 && !pack.groups.some((group) => group.exact)) {
    const cited = pack.groups.slice(0, MAX_ANSWER_GROUPS).flatMap((group) => group.entries);
    claims.push(makeClaim(query, AMBIGUITY_HEADING, 'No exact source span backs this answer; treat it as approximate context.', cited));
  }
  return claims.length === 0 ? null : makeSection(query, AMBIGUITY_HEADING, claims);
}

export function buildDeterministicWarnings(
  pack: EvidencePack,
  lead: LeadAmbiguity | null,
  hasLeadGroup: boolean,
): KnowledgeSynthesisWarning[] {
  const warnings: KnowledgeSynthesisWarning[] = [];
  const anyExact = pack.groups.some((group) => group.exact);
  if (lead !== null && hasLeadGroup) {
    warnings.push({
      code: 'ambiguous_evidence',
      ...(lead.reason === undefined ? {} : { ambiguityReason: lead.reason }),
      ...(lead.alternatives === undefined ? {} : { alternativeCount: lead.alternatives }),
      message: 'The leading result is ambiguous; competing results are listed under open questions.',
    });
  }
  if (!anyExact) {
    if (pack.groups.length > 0 && warnings.length === 0) {
      warnings.push({ code: 'ambiguous_evidence', message: 'The cited evidence lacks exact source spans.' });
    }
    warnings.push({ code: 'insufficient_exact_spans', message: 'No exact source spans were found for this answer.' });
  }
  if (pack.resultLimitReached) {
    warnings.push({ code: 'result_limit_reached', message: 'More matching results exist than the bounded evidence pack could include.' });
  }
  return warnings;
}

export function buildDeterministicSections(
  query: string,
  pack: EvidencePack,
  lead: LeadAmbiguity | null,
  redactText: TextRedactor,
): KnowledgeSynthesisSection[] {
  if (pack.groups.length === 0) return [];
  const exact = pack.groups.filter((group) => group.exact);
  const answerGroups = (exact.length > 0 ? exact : pack.groups).slice(0, MAX_ANSWER_GROUPS);
  const supporting = pack.groups.filter((group) => !answerGroups.includes(group));
  const sections = [
    makeSection(query, ANSWER_HEADING, answerGroups.map((group) => groupClaim(query, ANSWER_HEADING, group, redactText))),
  ];
  if (supporting.length > 0) {
    sections.push(makeSection(query, SUPPORTING_HEADING, supporting.map((group) => groupClaim(query, SUPPORTING_HEADING, group, redactText))));
  }
  const ambiguity = buildAmbiguitySection(query, pack, lead, redactText);
  if (ambiguity !== null) sections.push(ambiguity);
  return sections;
}

export function renderAnswerMarkdown(
  query: string,
  sections: KnowledgeSynthesisSection[],
  citations: KnowledgeSynthesisResult['citations'],
  redactText: TextRedactor,
): string {
  if (sections.length === 0) return `No matching evidence was found for "${clip(redactText(query), 120)}".`;
  const numbers = new Map(citations.map((citation, index) => [citationKey(citation), index + 1]));
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`## ${section.heading}`);
    for (const claim of section.claims) {
      const markers = claim.citations.map((citation) => `[${numbers.get(citationKey(citation))}]`).join('');
      lines.push(`- ${claim.text}${markers.length === 0 ? '' : ` ${markers}`}`);
    }
    lines.push('');
  }
  lines.push('## Sources');
  citations.forEach((citation, index) => {
    const where = citation.path ?? citation.url ?? citation.pageId ?? 'unknown';
    lines.push(`[${index + 1}] ${where}${lineRange(citation.span?.startLine, citation.span?.endLine)}`);
  });
  return lines.join('\n');
}

export function collectCitations(sections: KnowledgeSynthesisSection[]): KnowledgeSynthesisResult['citations'] {
  return dedupeCitationList(sections.flatMap((section) => section.claims.flatMap((claim) => claim.citations)));
}

export interface DeterministicInput {
  query: string;
  mode: KnowledgeSearchMode;
  pack: EvidencePack;
  lead: LeadAmbiguity | null;
  redactText: TextRedactor;
}

export function synthesizeDeterministically(input: DeterministicInput): KnowledgeSynthesisResult {
  const { query, mode, pack, lead, redactText } = input;
  const sections = buildDeterministicSections(query, pack, lead, redactText);
  const citations = collectCitations(sections);
  const hasLeadGroup = lead !== null && pack.groups.some((group) => group.resultId === lead.resultId);
  return {
    strategy: 'deterministic',
    query,
    mode,
    answerMarkdown: renderAnswerMarkdown(query, sections, citations, redactText),
    sections,
    evidence: pack.evidence,
    citations,
    warnings: buildDeterministicWarnings(pack, lead, hasLeadGroup),
  };
}
