import { clip, type TextRedactor } from './KnowledgeSynthesisEvidence.js';
import {
  MAX_SUMMARY_BULLET,
  MAX_SUMMARY_BULLETS,
  MAX_SUMMARY_EVIDENCE_IDS_PER_BULLET,
  MAX_SUMMARY_TEXT,
  MAX_SUMMARY_TITLE,
} from './KnowledgeSemanticSummaryPersistence.js';
import type { SummaryDraft } from './KnowledgeSemanticSummaryEvidence.js';
import type {
  KnowledgeSemanticSummaryEvidence,
  KnowledgeSummaryScopeKind,
  SemanticSummaryProviderRequest,
} from './KnowledgeSemanticSummaryTypes.js';

/** Stays below the transport's 12,000-byte prompt limit. */
export const MAX_SUMMARY_PROMPT_BYTES = 11_000;

export const SUMMARY_SYSTEM_PROMPT = [
  'You refine a grounded knowledge summary. Reply with one JSON object:',
  '{"title":string,"summary":string,"bullets":string[],"evidenceIdsByBullet":string[][]}.',
  'Use 1 to 8 bullets; evidenceIdsByBullet has one list of 1 to 4 evidence ids per bullet, taken verbatim from the evidence list.',
  'Use only the supplied evidence and deterministic summary. Never invent facts or ids. Do not add any other keys.',
].join(' ');

export interface ValidatedProviderSummary {
  title: string;
  summary: string;
  bullets: string[];
  bulletEvidenceIds: string[][];
}

export type SummaryProviderValidation = { ok: true; value: ValidatedProviderSummary } | { ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function citationForRequest(entry: KnowledgeSemanticSummaryEvidence): SemanticSummaryProviderRequest['evidence'][number] {
  let citation: SemanticSummaryProviderRequest['evidence'][number]['citation'] = null;
  if (entry.citation !== null) {
    const { context: _context, ...rest } = entry.citation;
    citation = rest;
  }
  return { id: entry.id, title: entry.title, text: entry.text, citation };
}

/** Serializes the request, shortening evidence text and then dropping trailing evidence if the transport limit would be exceeded. */
export function serializeSummaryRequest(scopeKind: KnowledgeSummaryScopeKind, draft: SummaryDraft): string | null {
  const build = (limit: number, textLimit: number): string =>
    JSON.stringify({
      scopeKind,
      title: draft.title,
      deterministicSummary: draft.summary,
      evidence: draft.evidence.slice(0, limit).map((entry) => citationForRequest({ ...entry, text: entry.text.slice(0, textLimit) })),
    } satisfies SemanticSummaryProviderRequest);
  for (const textLimit of [200, 80, 0]) {
    for (let limit = draft.evidence.length; limit >= 1; limit = limit > 4 ? limit - 2 : limit - 1) {
      const prompt = build(limit, textLimit);
      if (Buffer.byteLength(prompt, 'utf8') <= MAX_SUMMARY_PROMPT_BYTES) return prompt;
    }
  }
  return null;
}

/** Strictly validates the provider JSON; each bullet must resolve to at least one cited, known evidence entry. */
export function validateSummaryResponse(
  value: unknown,
  evidence: readonly KnowledgeSemanticSummaryEvidence[],
  redactText: TextRedactor,
): SummaryProviderValidation {
  const invalid: SummaryProviderValidation = { ok: false };
  if (!isPlainObject(value)) return invalid;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !['title', 'summary', 'bullets', 'evidenceIdsByBullet'].every((key) => keys.includes(key))) return invalid;
  const { title, summary, bullets, evidenceIdsByBullet } = value;
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_SUMMARY_TITLE) return invalid;
  if (typeof summary !== 'string' || summary.trim().length === 0 || summary.length > MAX_SUMMARY_TEXT) return invalid;
  if (!Array.isArray(bullets) || bullets.length < 1 || bullets.length > MAX_SUMMARY_BULLETS) return invalid;
  if (!Array.isArray(evidenceIdsByBullet) || evidenceIdsByBullet.length !== bullets.length) return invalid;
  if (!bullets.every((bullet) => typeof bullet === 'string' && bullet.trim().length > 0 && bullet.length <= MAX_SUMMARY_BULLET)) return invalid;

  const cited = new Map(evidence.map((entry) => [entry.id, entry.citation !== null]));
  const bulletEvidenceIds: string[][] = [];
  for (const ids of evidenceIdsByBullet as unknown[]) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SUMMARY_EVIDENCE_IDS_PER_BULLET) return invalid;
    if (!ids.every((id) => typeof id === 'string' && cited.has(id))) return invalid;
    const unique = [...new Set(ids as string[])];
    if (!unique.some((id) => cited.get(id) === true)) return invalid;
    bulletEvidenceIds.push(unique);
  }
  return {
    ok: true,
    value: {
      title: clip(redactText(title), MAX_SUMMARY_TITLE),
      summary: clip(redactText(summary), MAX_SUMMARY_TEXT),
      bullets: (bullets as string[]).map((bullet) => clip(redactText(bullet), MAX_SUMMARY_BULLET)),
      bulletEvidenceIds,
    },
  };
}
