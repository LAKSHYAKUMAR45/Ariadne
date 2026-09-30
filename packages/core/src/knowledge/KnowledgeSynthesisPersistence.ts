import { PROVIDER_FALLBACK_REASONS } from './KnowledgeProviderFallback.js';
import { parseCitationContext, toPersistedCitation } from './KnowledgeCitationContext.js';
import type { KnowledgeAmbiguityReason, KnowledgeSearchCitation, KnowledgeSearchConfidence } from './KnowledgeSearch.js';
import type {
  KnowledgeAnswerStrategy,
  KnowledgeSynthesisClaim,
  KnowledgeSynthesisClaimConfidence,
  KnowledgeSynthesisResult,
  KnowledgeSynthesisSection,
  KnowledgeSynthesisWarning,
  KnowledgeSynthesisWarningCode,
  PersistedKnowledgeSynthesis,
  PersistedKnowledgeSynthesisEvidence,
} from './KnowledgeSynthesisTypes.js';

export const MAX_PERSISTED_SECTIONS = 8;
export const MAX_PERSISTED_CLAIMS_PER_SECTION = 12;
export const MAX_PERSISTED_CLAIMS = 32;
export const MAX_PERSISTED_EVIDENCE = 64;
export const MAX_PERSISTED_WARNINGS = 16;
export const MAX_PERSISTED_CLAIM_TEXT = 600;
const MAX_HEADING = 120;
const MAX_IDENTIFIER = 256;
const MAX_TITLE = 512;
const MAX_PATH = 1_024;
const MAX_MESSAGE = 400;
const MAX_CITATIONS_PER_CLAIM = 12;
const MAX_EVIDENCE_IDS_PER_CLAIM = 12;

const STRATEGIES: ReadonlySet<string> = new Set<KnowledgeAnswerStrategy>(['deterministic', 'provider-assisted']);
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(['page', 'source', 'task']);
const CONFIDENCES: ReadonlySet<string> = new Set<KnowledgeSynthesisClaimConfidence>(['clear', 'ambiguous', 'unassessed']);
const SEARCH_CONFIDENCES: ReadonlySet<string> = new Set(['clear', 'ambiguous']);
const AMBIGUITY_REASONS: ReadonlySet<string> = new Set<KnowledgeAmbiguityReason>(['near_tie', 'shared_role', 'insufficient_intent']);
const WARNING_CODES: ReadonlySet<string> = new Set<KnowledgeSynthesisWarningCode>([
  'provider_unavailable',
  'provider_invalid',
  'insufficient_exact_spans',
  'ambiguous_evidence',
  'result_limit_reached',
]);
const FALLBACK_REASONS: ReadonlySet<string> = new Set(PROVIDER_FALLBACK_REASONS);

function fail(message: string): never {
  throw new Error(`Persisted knowledge synthesis ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function object(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unsupported key ${key}`);
  }
  return value;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > max) fail(`${label} exceeds ${max} entries`);
  return value;
}

function text(value: unknown, label: string, max: number, options: { nonEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (value.length > max) fail(`${label} exceeds ${max} characters`);
  if (options.nonEmpty && value.trim().length === 0) fail(`${label} must not be empty`);
  return value;
}

function nullableText(value: unknown, label: string, max: number): string | null {
  return value === null || value === undefined ? null : text(value, label, max);
}

function member<T extends string>(value: unknown, allowed: ReadonlySet<string>, label: string): T {
  if (typeof value !== 'string' || !allowed.has(value)) fail(`${label} is not a supported value`);
  return value as T;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

const SPAN_KEYS = ['id', 'startOffset', 'endOffset', 'startLine', 'startColumn', 'endLine', 'endColumn', 'label'];

/** Strict reference-only citation validator shared with the semantic-summary persistence. */
export function parsePersistedKnowledgeCitation(value: unknown, label: string): KnowledgeSearchCitation {
  const raw = object(value, label, ['pageId', 'sourceId', 'path', 'url', 'span', 'context']);
  let span: KnowledgeSearchCitation['span'] = null;
  if (raw.span !== null && raw.span !== undefined) {
    const rawSpan = object(raw.span, `${label} span`, SPAN_KEYS);
    span = {
      id: text(rawSpan.id, `${label} span id`, MAX_IDENTIFIER, { nonEmpty: true }),
      startOffset: integer(rawSpan.startOffset, `${label} span startOffset`),
      endOffset: integer(rawSpan.endOffset, `${label} span endOffset`),
      ...(rawSpan.startLine !== undefined ? { startLine: integer(rawSpan.startLine, `${label} span startLine`) } : {}),
      ...(rawSpan.startColumn !== undefined ? { startColumn: integer(rawSpan.startColumn, `${label} span startColumn`) } : {}),
      ...(rawSpan.endLine !== undefined ? { endLine: integer(rawSpan.endLine, `${label} span endLine`) } : {}),
      ...(rawSpan.endColumn !== undefined ? { endColumn: integer(rawSpan.endColumn, `${label} span endColumn`) } : {}),
      label: nullableText(rawSpan.label, `${label} span label`, MAX_TITLE),
    };
  }
  let context: KnowledgeSearchCitation['context'];
  if (raw.context !== undefined) {
    try {
      context = parseCitationContext(raw.context);
    } catch (error) {
      fail(`${label} has an invalid context: ${error instanceof Error ? error.message : 'invalid'}`);
    }
    if (context.snippetPolicy !== 'reference_only') fail(`${label} context snippetPolicy must be reference_only`);
  }
  return toPersistedCitation({
    pageId: nullableText(raw.pageId, `${label} pageId`, MAX_IDENTIFIER) as KnowledgeSearchCitation['pageId'],
    sourceId: nullableText(raw.sourceId, `${label} sourceId`, MAX_IDENTIFIER) as KnowledgeSearchCitation['sourceId'],
    path: nullableText(raw.path, `${label} path`, MAX_PATH),
    url: nullableText(raw.url, `${label} url`, MAX_PATH),
    span,
    ...(context !== undefined ? { context } : {}),
  });
}

function parseEvidence(value: unknown, index: number): PersistedKnowledgeSynthesisEvidence {
  const label = `evidence ${index + 1}`;
  const raw = object(value, label, ['id', 'resultId', 'kind', 'title', 'path', 'rank', 'citation', 'snippetPolicy', 'searchConfidence']);
  if (raw.snippetPolicy !== 'reference_only') fail(`${label} snippetPolicy must be reference_only`);
  return {
    id: text(raw.id, `${label} id`, MAX_IDENTIFIER, { nonEmpty: true }),
    resultId: text(raw.resultId, `${label} resultId`, MAX_IDENTIFIER, { nonEmpty: true }),
    kind: member(raw.kind, EVIDENCE_KINDS, `${label} kind`),
    title: nullableText(raw.title, `${label} title`, MAX_TITLE),
    path: nullableText(raw.path, `${label} path`, MAX_PATH),
    rank: integer(raw.rank, `${label} rank`),
    citation: raw.citation === null || raw.citation === undefined ? null : parsePersistedKnowledgeCitation(raw.citation, `${label} citation`),
    snippetPolicy: 'reference_only',
    searchConfidence:
      raw.searchConfidence === null || raw.searchConfidence === undefined
        ? null
        : member<KnowledgeSearchConfidence>(raw.searchConfidence, SEARCH_CONFIDENCES, `${label} searchConfidence`),
  };
}

function parseClaim(value: unknown, label: string, evidenceIds: ReadonlySet<string>): KnowledgeSynthesisClaim {
  const raw = object(value, label, ['id', 'text', 'evidenceIds', 'citations', 'confidence']);
  const ids = array(raw.evidenceIds, `${label} evidenceIds`, MAX_EVIDENCE_IDS_PER_CLAIM).map((id) =>
    text(id, `${label} evidenceId`, MAX_IDENTIFIER, { nonEmpty: true }),
  );
  if (ids.length === 0) fail(`${label} must reference evidence`);
  for (const id of ids) {
    if (!evidenceIds.has(id)) fail(`${label} references unknown evidence`);
  }
  return {
    id: text(raw.id, `${label} id`, MAX_IDENTIFIER, { nonEmpty: true }),
    text: text(raw.text, `${label} text`, MAX_PERSISTED_CLAIM_TEXT, { nonEmpty: true }),
    evidenceIds: ids,
    citations: array(raw.citations, `${label} citations`, MAX_CITATIONS_PER_CLAIM).map((citation, index) =>
      parsePersistedKnowledgeCitation(citation, `${label} citation ${index + 1}`),
    ),
    confidence: member(raw.confidence, CONFIDENCES, `${label} confidence`),
  };
}

function parseSections(value: unknown, evidenceIds: ReadonlySet<string>): KnowledgeSynthesisSection[] {
  let totalClaims = 0;
  return array(value, 'sections', MAX_PERSISTED_SECTIONS).map((entry, sectionIndex) => {
    const label = `section ${sectionIndex + 1}`;
    const raw = object(entry, label, ['id', 'heading', 'claims']);
    const claims = array(raw.claims, `${label} claims`, MAX_PERSISTED_CLAIMS_PER_SECTION).map((claim, claimIndex) => {
      totalClaims += 1;
      if (totalClaims > MAX_PERSISTED_CLAIMS) fail(`claims exceed ${MAX_PERSISTED_CLAIMS} entries`);
      return parseClaim(claim, `${label} claim ${claimIndex + 1}`, evidenceIds);
    });
    return {
      id: text(raw.id, `${label} id`, MAX_IDENTIFIER, { nonEmpty: true }),
      heading: text(raw.heading, `${label} heading`, MAX_HEADING, { nonEmpty: true }),
      claims,
    };
  });
}

function parseWarning(value: unknown, index: number): KnowledgeSynthesisWarning {
  const label = `warning ${index + 1}`;
  const raw = object(value, label, ['code', 'reason', 'ambiguityReason', 'alternativeCount', 'message']);
  return {
    code: member(raw.code, WARNING_CODES, `${label} code`),
    ...(raw.reason !== undefined ? { reason: member<NonNullable<KnowledgeSynthesisWarning['reason']>>(raw.reason, FALLBACK_REASONS, `${label} reason`) } : {}),
    ...(raw.ambiguityReason !== undefined
      ? { ambiguityReason: member<KnowledgeAmbiguityReason>(raw.ambiguityReason, AMBIGUITY_REASONS, `${label} ambiguityReason`) }
      : {}),
    ...(raw.alternativeCount !== undefined ? { alternativeCount: integer(raw.alternativeCount, `${label} alternativeCount`) } : {}),
    message: text(raw.message, `${label} message`, MAX_MESSAGE),
  };
}

/** Strict validator for the `MessagePayloadV2.synthesis` slot: unknown keys, excerpts, and ungrounded claims are rejected. */
export function parsePersistedKnowledgeSynthesis(value: unknown): PersistedKnowledgeSynthesis {
  const raw = object(value, 'block', ['synthesisVersion', 'strategy', 'sections', 'evidence', 'warnings']);
  if (raw.synthesisVersion !== 1) fail('synthesisVersion must be 1');
  const evidence = array(raw.evidence, 'evidence', MAX_PERSISTED_EVIDENCE).map(parseEvidence);
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  if (evidenceIds.size !== evidence.length) fail('evidence ids must be unique');
  return {
    synthesisVersion: 1,
    strategy: member(raw.strategy, STRATEGIES, 'strategy'),
    sections: parseSections(raw.sections, evidenceIds),
    evidence,
    warnings: array(raw.warnings, 'warnings', MAX_PERSISTED_WARNINGS).map(parseWarning),
  };
}

function persistedWarning(warning: KnowledgeSynthesisWarning): KnowledgeSynthesisWarning {
  return {
    code: warning.code,
    ...(warning.reason !== undefined ? { reason: warning.reason } : {}),
    ...(warning.ambiguityReason !== undefined ? { ambiguityReason: warning.ambiguityReason } : {}),
    ...(warning.alternativeCount !== undefined ? { alternativeCount: warning.alternativeCount } : {}),
    message: warning.message,
  };
}

/**
 * Rebuilds the runtime result from an allowlist: ephemeral snippets, provider prompts and responses, and the ambiguity
 * reason carried on runtime evidence never reach the persisted shape, and every citation becomes reference-only.
 */
export function toPersistedKnowledgeSynthesis(
  result: KnowledgeSynthesisResult,
  citationWithContext: (citation: KnowledgeSearchCitation) => KnowledgeSearchCitation = (citation) => citation,
): PersistedKnowledgeSynthesis {
  const persistCitation = (citation: KnowledgeSearchCitation): KnowledgeSearchCitation =>
    toPersistedCitation(citationWithContext(citation));
  return {
    synthesisVersion: 1,
    strategy: result.strategy,
    sections: result.sections.map((section) => ({
      id: section.id,
      heading: section.heading,
      claims: section.claims.map((claim) => ({
        id: claim.id,
        text: claim.text,
        evidenceIds: [...claim.evidenceIds],
        citations: claim.citations.map(persistCitation),
        confidence: claim.confidence,
      })),
    })),
    evidence: result.evidence.map((entry) => ({
      id: entry.id,
      resultId: entry.resultId,
      kind: entry.kind,
      title: entry.title,
      path: entry.path,
      rank: entry.rank,
      citation: entry.citation === null ? null : persistCitation(entry.citation),
      snippetPolicy: 'reference_only',
      searchConfidence: entry.searchConfidence,
    })),
    warnings: result.warnings.map(persistedWarning),
  };
}
