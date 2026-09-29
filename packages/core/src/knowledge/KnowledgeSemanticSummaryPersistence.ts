import { PROVIDER_FALLBACK_REASONS } from './KnowledgeProviderFallback.js';
import { parsePersistedKnowledgeCitation } from './KnowledgeSynthesisPersistence.js';
import type {
  KnowledgeSemanticSummaryWarning,
  PersistedSemanticSummaryPayload,
} from './KnowledgeSemanticSummaryTypes.js';

export const MAX_SUMMARY_TITLE = 120;
export const MAX_SUMMARY_TEXT = 500;
export const MAX_SUMMARY_BULLETS = 8;
export const MAX_SUMMARY_BULLET = 240;
export const MAX_SUMMARY_EVIDENCE = 40;
export const MAX_SUMMARY_EVIDENCE_IDS_PER_BULLET = 4;
export const MAX_SUMMARY_WARNINGS = 4;
export const MAX_SUMMARY_JSON_BYTES = 256 * 1024;
const MAX_ID = 256;
const MAX_WARNING_CODE = 64;
const MAX_WARNING_MESSAGE = 300;
const FALLBACK_REASONS: ReadonlySet<string> = new Set(PROVIDER_FALLBACK_REASONS);

function fail(message: string): never {
  throw new Error(`Knowledge semantic summary ${message}`);
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

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  if (value.length > max) fail(`${label} exceeds ${max} characters`);
  return value;
}

function parseEvidenceIds(value: unknown, label: string, known: ReadonlySet<string>): string[] {
  return array(value, label, MAX_SUMMARY_EVIDENCE_IDS_PER_BULLET).map((id) => {
    const evidenceId = text(id, `${label} id`, MAX_ID);
    if (!known.has(evidenceId)) fail(`${label} references unknown evidence`);
    return evidenceId;
  });
}

/** Strict validator for `summary_json`: unknown keys, excerpt-bearing citations, and ungrounded bullets are rejected. */
export function parseSemanticSummaryPayload(value: unknown): PersistedSemanticSummaryPayload {
  const raw = object(value, 'payload', ['title', 'summary', 'bullets', 'evidence', 'bulletEvidenceIds']);
  const evidence = array(raw.evidence, 'evidence', MAX_SUMMARY_EVIDENCE).map((entry, index) => {
    const label = `evidence ${index + 1}`;
    const rawEntry = object(entry, label, ['evidenceId', 'citation']);
    let citation = null;
    if (rawEntry.citation !== null && rawEntry.citation !== undefined) {
      try {
        citation = parsePersistedKnowledgeCitation(rawEntry.citation, `${label} citation`);
      } catch (error) {
        fail(error instanceof Error ? error.message.replace(/^Persisted knowledge synthesis /, '') : `${label} citation is invalid`);
      }
    }
    return { evidenceId: text(rawEntry.evidenceId, `${label} id`, MAX_ID), citation };
  });
  const known = new Set(evidence.map((entry) => entry.evidenceId));
  if (known.size !== evidence.length) fail('evidence ids must be unique');
  const bullets = array(raw.bullets, 'bullets', MAX_SUMMARY_BULLETS).map((bullet, index) =>
    text(bullet, `bullet ${index + 1}`, MAX_SUMMARY_BULLET),
  );
  const bulletEvidenceIds =
    raw.bulletEvidenceIds === undefined
      ? bullets.map(() => [])
      : array(raw.bulletEvidenceIds, 'bulletEvidenceIds', MAX_SUMMARY_BULLETS).map((ids, index) =>
          parseEvidenceIds(ids, `bulletEvidenceIds ${index + 1}`, known),
        );
  if (bulletEvidenceIds.length !== bullets.length) fail('bulletEvidenceIds must align with bullets');
  return {
    title: text(raw.title, 'title', MAX_SUMMARY_TITLE),
    summary: text(raw.summary, 'summary', MAX_SUMMARY_TEXT),
    bullets,
    evidence,
    bulletEvidenceIds,
  };
}

export function parseSemanticSummaryWarnings(value: unknown): KnowledgeSemanticSummaryWarning[] {
  return array(value, 'warnings', MAX_SUMMARY_WARNINGS).map((entry, index) => {
    const label = `warning ${index + 1}`;
    const raw = object(entry, label, ['code', 'message', 'reason']);
    if (raw.reason !== undefined && (typeof raw.reason !== 'string' || !FALLBACK_REASONS.has(raw.reason))) {
      fail(`${label} reason is not supported`);
    }
    return {
      code: text(raw.code, `${label} code`, MAX_WARNING_CODE),
      message: text(raw.message, `${label} message`, MAX_WARNING_MESSAGE),
      ...(raw.reason === undefined ? {} : { reason: raw.reason as KnowledgeSemanticSummaryWarning['reason'] }),
    };
  });
}

export function parseBoundedSummaryJson(raw: unknown, label: string): unknown {
  if (typeof raw !== 'string') fail(`${label} must be JSON text`);
  if (Buffer.byteLength(raw, 'utf8') > MAX_SUMMARY_JSON_BYTES) fail(`${label} exceeds ${MAX_SUMMARY_JSON_BYTES} bytes`);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fail(`${label} is not valid JSON`);
  }
}
