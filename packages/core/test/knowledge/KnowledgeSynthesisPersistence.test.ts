import { describe, expect, it } from 'vitest';
import { parseMessagePayload, serializeMessagePayload } from '../../src/knowledge/KnowledgeChatPayload.js';
import type { KnowledgeSearchCitation } from '../../src/knowledge/KnowledgeSearch.js';
import {
  parsePersistedKnowledgeSynthesis,
  toPersistedKnowledgeSynthesis,
} from '../../src/knowledge/KnowledgeSynthesisPersistence.js';
import type { KnowledgeSynthesisResult } from '../../src/knowledge/KnowledgeSynthesisTypes.js';

const SECRET_SNIPPET = 'SECRET-SNIPPET-TEXT-MUST-NEVER-PERSIST';

function citation(path: string, spanId: string, snippetPolicy: 'reference_only' | 'ephemeral_redacted' = 'reference_only'): KnowledgeSearchCitation {
  return {
    pageId: null,
    sourceId: `source_${path}`,
    path,
    url: null,
    span: { id: spanId, startOffset: 0, endOffset: 10, startLine: 1, endLine: 2, label: 'greet' },
    context: {
      sourceVersionId: 'version_1',
      sourceSpanId: spanId,
      fieldKind: 'symbol',
      fieldLabel: 'greet',
      matchKind: 'exact_span',
      snippetPolicy,
      startLineWindow: 1,
      endLineWindow: 2,
      legacyState: 'current',
    },
  };
}

function runtimeResult(): KnowledgeSynthesisResult {
  const first = citation('src/a.ts', 'span_a', 'ephemeral_redacted');
  return {
    strategy: 'provider-assisted',
    query: 'greet',
    mode: 'sources',
    answerMarkdown: 'irrelevant to persistence',
    sections: [
      {
        id: 'section_1',
        heading: 'Answer',
        claims: [{ id: 'claim_1', text: 'greet is defined in src/a.ts', evidenceIds: ['evidence_1'], citations: [first], confidence: 'ambiguous' }],
      },
    ],
    evidence: [
      {
        id: 'evidence_1',
        resultId: 'source_a',
        kind: 'source',
        title: 'src/a.ts',
        path: 'src/a.ts',
        url: null,
        rank: 1,
        citation: first,
        snippetPolicy: 'ephemeral_redacted',
        ephemeralSnippet: SECRET_SNIPPET,
        searchConfidence: 'ambiguous',
        ambiguityReason: 'near_tie',
      },
    ],
    citations: [first],
    warnings: [{ code: 'ambiguous_evidence', ambiguityReason: 'near_tie', alternativeCount: 2, message: 'Leading result is ambiguous.' }],
  };
}

describe('persisted knowledge synthesis', () => {
  it('drops ephemeral snippets and forces reference-only evidence and citations', () => {
    const persisted = toPersistedKnowledgeSynthesis(runtimeResult());
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(SECRET_SNIPPET);
    expect(serialized).not.toContain('ephemeralSnippet');
    expect(persisted.synthesisVersion).toBe(1);
    expect(persisted.evidence[0]).toEqual({
      id: 'evidence_1',
      resultId: 'source_a',
      kind: 'source',
      title: 'src/a.ts',
      path: 'src/a.ts',
      rank: 1,
      citation: expect.objectContaining({ context: expect.objectContaining({ snippetPolicy: 'reference_only' }) }),
      snippetPolicy: 'reference_only',
      searchConfidence: 'ambiguous',
    });
    expect(persisted.sections[0].claims[0].citations[0].context?.snippetPolicy).toBe('reference_only');
    expect(persisted.warnings).toEqual([
      { code: 'ambiguous_evidence', ambiguityReason: 'near_tie', alternativeCount: 2, message: 'Leading result is ambiguous.' },
    ]);
  });

  it('round-trips through the strict parser', () => {
    const persisted = toPersistedKnowledgeSynthesis(runtimeResult());
    expect(parsePersistedKnowledgeSynthesis(JSON.parse(JSON.stringify(persisted)))).toEqual(persisted);
  });

  const valid = () => JSON.parse(JSON.stringify(toPersistedKnowledgeSynthesis(runtimeResult()))) as Record<string, any>;

  it.each([
    ['an unknown top-level key', (v: Record<string, any>) => { v.prompt = 'raw prompt'; }],
    ['a wrong synthesis version', (v: Record<string, any>) => { v.synthesisVersion = 2; }],
    ['an unsupported strategy', (v: Record<string, any>) => { v.strategy = 'magic'; }],
    ['an ephemeral snippet field on evidence', (v: Record<string, any>) => { v.evidence[0].ephemeralSnippet = SECRET_SNIPPET; }],
    ['an excerpt-bearing evidence key', (v: Record<string, any>) => { v.evidence[0].snippet = SECRET_SNIPPET; }],
    ['an ephemeral evidence snippet policy', (v: Record<string, any>) => { v.evidence[0].snippetPolicy = 'ephemeral_redacted'; }],
    ['an ephemeral citation context', (v: Record<string, any>) => { v.evidence[0].citation.context.snippetPolicy = 'ephemeral_redacted'; }],
    ['an excerpt on a claim citation context', (v: Record<string, any>) => { v.sections[0].claims[0].citations[0].context.excerpt = SECRET_SNIPPET; }],
    ['a claim referencing unknown evidence', (v: Record<string, any>) => { v.sections[0].claims[0].evidenceIds = ['evidence_missing']; }],
    ['a claim without evidence', (v: Record<string, any>) => { v.sections[0].claims[0].evidenceIds = []; }],
    ['an unsupported claim confidence', (v: Record<string, any>) => { v.sections[0].claims[0].confidence = 0.9; }],
    ['an unsupported warning code', (v: Record<string, any>) => { v.warnings[0].code = 'made_up'; }],
    ['an unsupported fallback reason', (v: Record<string, any>) => { v.warnings.push({ code: 'provider_unavailable', reason: 'bad', message: 'x' }); }],
    ['oversized claim text', (v: Record<string, any>) => { v.sections[0].claims[0].text = 'x'.repeat(5_000); }],
    ['too many evidence entries', (v: Record<string, any>) => { v.evidence = Array.from({ length: 200 }, (_, i) => ({ ...v.evidence[0], id: `e${i}` })); }],
    ['a non-object payload', (v: Record<string, any>) => { v.evidence = 'oops'; }],
  ])('rejects %s', (_label, mutate) => {
    const value = valid();
    mutate(value);
    expect(() => parsePersistedKnowledgeSynthesis(value)).toThrow();
  });

  it('is accepted, validated, and preserved by the chat payload parser and serializer', () => {
    const persisted = toPersistedKnowledgeSynthesis(runtimeResult());
    const raw = serializeMessagePayload({
      content: 'answer',
      citations: [citation('src/a.ts', 'span_a')],
      retrievalMode: 'sources',
      synthesis: persisted,
    });
    expect(raw).not.toContain(SECRET_SNIPPET);
    const parsed = parseMessagePayload(raw);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.synthesis).toEqual(persisted);

    const tampered = JSON.parse(raw) as Record<string, any>;
    tampered.synthesis.evidence[0].ephemeralSnippet = SECRET_SNIPPET;
    expect(() => parseMessagePayload(JSON.stringify(tampered))).toThrow(/synthesis/i);
  });

  it('keeps legacy and synthesis-less payloads readable', () => {
    const legacy = parseMessagePayload(JSON.stringify({ content: 'old', citations: [], retrievalMode: null }));
    expect(legacy.synthesis).toBeNull();
    const v2 = parseMessagePayload(JSON.stringify({ schemaVersion: 2, content: 'x', citations: [], retrievalMode: 'hybrid', synthesis: null }));
    expect(v2.synthesis).toBeNull();
  });
});
