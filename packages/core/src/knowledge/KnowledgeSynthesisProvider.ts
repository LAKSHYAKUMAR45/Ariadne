import { createKnowledgeId } from './KnowledgeIds.js';
import { claimConfidence, clip, dedupeCitationList, type TextRedactor } from './KnowledgeSynthesisEvidence.js';
import type {
  KnowledgeSynthesisClaim,
  KnowledgeSynthesisEvidence,
  KnowledgeSynthesisProviderRequest,
  KnowledgeSynthesisSection,
} from './KnowledgeSynthesisTypes.js';

export const MAX_PROVIDER_SECTIONS = 4;
export const MAX_PROVIDER_CLAIMS_PER_SECTION = 6;
export const MAX_PROVIDER_CLAIMS = 12;
export const MAX_PROVIDER_HEADING = 80;
export const MAX_PROVIDER_CLAIM_TEXT = 400;
export const MAX_PROVIDER_EVIDENCE_IDS = 4;
/** Stays below the transport's 12,000-byte prompt limit. */
export const MAX_PROVIDER_PROMPT_BYTES = 11_000;

export const SYNTHESIS_SYSTEM_PROMPT = [
  'You rewrite a grounded knowledge answer. Reply with one JSON object: {"sections":[{"heading":string,"claims":[{"text":string,"evidenceIds":string[]}]}]}.',
  'Use at most 4 sections and 6 claims per section. Every claim must cite one to four evidenceIds taken verbatim from the evidence list.',
  'Use only the supplied evidence, snippets, and draft. Never invent facts, file names, or ids. Do not add any other keys.',
].join(' ');

export type ProviderValidation = { ok: true; sections: KnowledgeSynthesisSection[] } | { ok: false };

const INVALID: ProviderValidation = { ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Serializes the request, dropping snippets and then the draft if the transport limit would be exceeded. */
export function serializeProviderRequest(
  request: KnowledgeSynthesisProviderRequest,
): { prompt: string; withSnippets: boolean } | null {
  const stripped = request.evidence.map((entry) => ({ ...entry, snippet: null }));
  const attempts: Array<[KnowledgeSynthesisProviderRequest, boolean]> = [
    [request, true],
    [{ ...request, evidence: stripped }, false],
    [{ ...request, evidence: stripped, deterministicDraft: [] }, false],
  ];
  for (const [attempt, withSnippets] of attempts) {
    const prompt = JSON.stringify(attempt);
    if (Buffer.byteLength(prompt, 'utf8') <= MAX_PROVIDER_PROMPT_BYTES) return { prompt, withSnippets };
  }
  return null;
}

/** Strictly validates the provider JSON and rebuilds every citation from the known evidence pack. */
export function validateProviderResponse(
  value: unknown,
  query: string,
  evidence: readonly KnowledgeSynthesisEvidence[],
  redactText: TextRedactor,
): ProviderValidation {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['sections']) || !Array.isArray(value.sections)) return INVALID;
  if (value.sections.length < 1 || value.sections.length > MAX_PROVIDER_SECTIONS) return INVALID;
  const order = new Map(evidence.map((entry, index) => [entry.id, index]));
  let totalClaims = 0;
  const sections: KnowledgeSynthesisSection[] = [];

  for (const rawSection of value.sections as unknown[]) {
    if (!isPlainObject(rawSection) || !hasOnlyKeys(rawSection, ['heading', 'claims']) || !Array.isArray(rawSection.claims)) return INVALID;
    const heading = rawSection.heading;
    if (typeof heading !== 'string' || heading.trim().length === 0 || heading.length > MAX_PROVIDER_HEADING) return INVALID;
    if (rawSection.claims.length < 1 || rawSection.claims.length > MAX_PROVIDER_CLAIMS_PER_SECTION) return INVALID;
    const cleanHeading = clip(redactText(heading), MAX_PROVIDER_HEADING);
    const claims: KnowledgeSynthesisClaim[] = [];
    for (const rawClaim of rawSection.claims as unknown[]) {
      totalClaims += 1;
      const claim = validateClaim(rawClaim, query, cleanHeading, evidence, order, redactText);
      if (claim === null || totalClaims > MAX_PROVIDER_CLAIMS) return INVALID;
      claims.push(claim);
    }
    sections.push({
      id: createKnowledgeId('section', JSON.stringify([query, cleanHeading, claims.flatMap((claim) => claim.evidenceIds)])),
      heading: cleanHeading,
      claims,
    });
  }
  return { ok: true, sections };
}

function validateClaim(
  value: unknown,
  query: string,
  heading: string,
  evidence: readonly KnowledgeSynthesisEvidence[],
  order: ReadonlyMap<string, number>,
  redactText: TextRedactor,
): KnowledgeSynthesisClaim | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['text', 'evidenceIds'])) return null;
  const { text, evidenceIds } = value;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_PROVIDER_CLAIM_TEXT) return null;
  if (!Array.isArray(evidenceIds) || evidenceIds.length < 1 || evidenceIds.length > MAX_PROVIDER_EVIDENCE_IDS) return null;
  if (!evidenceIds.every((id) => typeof id === 'string' && order.has(id))) return null;
  const unique = [...new Set(evidenceIds as string[])].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  const cited = unique.map((id) => evidence[order.get(id) ?? 0]);
  const citations = dedupeCitationList(cited.flatMap((entry) => (entry.citation === null ? [] : [entry.citation])));
  if (citations.length === 0) return null;
  return {
    id: createKnowledgeId('claim', JSON.stringify([query, heading, unique])),
    text: clip(redactText(text), MAX_PROVIDER_CLAIM_TEXT),
    evidenceIds: unique,
    citations,
    confidence: claimConfidence(cited),
  };
}
