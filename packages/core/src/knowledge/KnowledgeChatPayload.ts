import {
  legacyCitationContext,
  parseCitationContext,
  toPersistedCitation,
} from './KnowledgeCitationContext.js';
import type { KnowledgeSearchCitation, KnowledgeSearchMode } from './KnowledgeSearch.js';
import { parsePersistedKnowledgeSynthesis } from './KnowledgeSynthesisPersistence.js';
import type { PersistedKnowledgeSynthesis } from './KnowledgeSynthesisTypes.js';

/** The only extension slot; its shape and validator are owned by the answer-synthesis slice. */
export type { PersistedKnowledgeSynthesis } from './KnowledgeSynthesisTypes.js';

export interface MessagePayloadV2 {
  schemaVersion: 2;
  content: string;
  citations: KnowledgeSearchCitation[];
  retrievalMode: KnowledgeSearchMode | null;
  synthesis?: PersistedKnowledgeSynthesis | null;
}

export const KNOWLEDGE_CHAT_RETRIEVAL_MODES: ReadonlySet<string> = new Set<KnowledgeSearchMode>([
  'knowledge',
  'sources',
  'tasks',
  'hybrid',
  'read-sources-only',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function assertCitationShape(citation: unknown, index: number): asserts citation is Record<string, unknown> {
  const label = `Knowledge chat payload citation ${index + 1}`;
  if (!isPlainObject(citation)) {
    throw new Error(`${label} must be a plain object`);
  }
  for (const key of ['pageId', 'sourceId', 'path', 'url'] as const) {
    const value = citation[key];
    if (value !== null && value !== undefined && typeof value !== 'string') {
      throw new Error(`${label} field ${key} must be a string or null`);
    }
  }
  if (citation.span !== null && citation.span !== undefined) {
    if (!isPlainObject(citation.span)) {
      throw new Error(`${label} span must be a plain object or null`);
    }
    if (typeof citation.span.id !== 'string') {
      throw new Error(`${label} span id must be a string`);
    }
  }
}

function normalizeCitation(raw: Record<string, unknown>, schemaVersion: 2 | undefined): KnowledgeSearchCitation {
  const { context, ...rest } = raw;
  const citation = rest as unknown as KnowledgeSearchCitation;
  if (context === undefined) {
    return { ...citation, context: legacyCitationContext(citation, schemaVersion === undefined ? 'legacy_payload' : 'legacy_unknown') };
  }
  try {
    return { ...citation, context: parseCitationContext(context) };
  } catch {
    return { ...citation, context: legacyCitationContext(citation, 'legacy_unknown') };
  }
}

/**
 * Tolerant reader: accepts legacy payloads (no schemaVersion) and V2, and
 * always returns V2 in memory. Structurally invalid payloads throw; an invalid
 * per-citation context degrades to an explicit `legacy_unknown` marker.
 */
export function parseMessagePayload(raw: string): MessagePayloadV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Knowledge chat payload must contain valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Knowledge chat payload must be a plain object');
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 2) {
    throw new Error('Knowledge chat payload schemaVersion must be absent or 2');
  }
  const schemaVersion = parsed.schemaVersion === 2 ? 2 : undefined;
  if (typeof parsed.content !== 'string') {
    throw new Error('Knowledge chat payload content must be a string');
  }
  if (!Array.isArray(parsed.citations)) {
    throw new Error('Knowledge chat payload citations must be an array');
  }
  const citations = parsed.citations.map((citation: unknown, index) => {
    assertCitationShape(citation, index);
    return normalizeCitation(citation, schemaVersion);
  });
  if (parsed.retrievalMode !== null && parsed.retrievalMode !== undefined) {
    if (typeof parsed.retrievalMode !== 'string' || !KNOWLEDGE_CHAT_RETRIEVAL_MODES.has(parsed.retrievalMode)) {
      throw new Error('Knowledge chat payload retrievalMode must be a supported search mode or null');
    }
  }
  let synthesis: PersistedKnowledgeSynthesis | null = null;
  if (parsed.synthesis !== undefined && parsed.synthesis !== null) {
    try {
      synthesis = parsePersistedKnowledgeSynthesis(parsed.synthesis);
    } catch (error) {
      throw new Error(`Knowledge chat payload synthesis is invalid: ${error instanceof Error ? error.message : 'invalid'}`);
    }
  }
  return {
    schemaVersion: 2,
    content: parsed.content,
    citations,
    retrievalMode: (parsed.retrievalMode ?? null) as KnowledgeSearchMode | null,
    synthesis,
  };
}

/**
 * Serializes reference-only V2 JSON. Citations are rebuilt from an allowlist so
 * excerpt text can never reach disk; the synthesis slot is omitted unless set.
 */
export function serializeMessagePayload(input: {
  content: string;
  citations: readonly KnowledgeSearchCitation[];
  retrievalMode: KnowledgeSearchMode | null;
  synthesis?: PersistedKnowledgeSynthesis | null;
}): string {
  const payload: MessagePayloadV2 = {
    schemaVersion: 2,
    content: input.content,
    citations: input.citations.map(toPersistedCitation),
    retrievalMode: input.retrievalMode,
    ...(input.synthesis !== undefined && input.synthesis !== null ? { synthesis: input.synthesis } : {}),
  };
  return JSON.stringify(payload);
}
