import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import {
  deriveCitationContext,
  legacyCitationContext,
  parseCitationContext,
  toPersistedCitationContext,
} from '../../src/knowledge/KnowledgeCitationContext.js';
import {
  parseMessagePayload,
  serializeMessagePayload,
} from '../../src/knowledge/KnowledgeChatPayload.js';
import type { KnowledgeSearchCitation } from '../../src/knowledge/KnowledgeSearch.js';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

const spanCitation: KnowledgeSearchCitation = {
  pageId: null,
  sourceId: 'source_1',
  path: 'docs/setup-guide.md',
  url: null,
  span: { id: 'span_1', startOffset: 0, endOffset: 10, startLine: 1, startColumn: 1, endLine: 2, endColumn: 4, label: 'Setup' },
};

const validContext = {
  sourceVersionId: 'source_version_1',
  sourceSpanId: 'span_1',
  fieldKind: 'section',
  fieldLabel: 'Setup',
  matchKind: 'exact_span',
  snippetPolicy: 'reference_only',
  startLineWindow: 1,
  endLineWindow: 2,
  legacyState: 'current',
};

describe('parseCitationContext', () => {
  it('accepts a complete reference-only context', () => {
    expect(parseCitationContext(validContext)).toEqual(validContext);
  });

  it.each([
    ['unknown key such as an excerpt', { ...validContext, excerpt: 'raw source text' }],
    ['unknown field kind', { ...validContext, fieldKind: 'body' }],
    ['unknown match kind', { ...validContext, matchKind: 'fuzzy' }],
    ['non-string span id', { ...validContext, sourceSpanId: 4 }],
    ['negative line window', { ...validContext, startLineWindow: -1 }],
    ['inverted line window', { ...validContext, startLineWindow: 5, endLineWindow: 2 }],
    ['unknown legacy state', { ...validContext, legacyState: 'ancient' }],
    ['missing key', { ...validContext, snippetPolicy: undefined }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseCitationContext(value)).toThrow(/citation context/i);
  });

  it('rejects contexts that are not plain objects', () => {
    expect(() => parseCitationContext('nope')).toThrow(/citation context/i);
    expect(() => parseCitationContext(null)).toThrow(/citation context/i);
  });
});

describe('toPersistedCitationContext', () => {
  it('forces reference-only persistence and drops unknown keys', () => {
    const persisted = toPersistedCitationContext({
      ...validContext,
      snippetPolicy: 'ephemeral_redacted',
      excerpt: 'raw source text',
    } as never);
    expect(persisted.snippetPolicy).toBe('reference_only');
    expect(persisted).not.toHaveProperty('excerpt');
  });
});

describe('legacyCitationContext', () => {
  it('marks legacy citations explicitly without inventing a source version or field kind detail', () => {
    expect(legacyCitationContext(spanCitation, 'legacy_payload')).toEqual({
      sourceVersionId: null,
      sourceSpanId: 'span_1',
      fieldKind: 'path_metadata',
      fieldLabel: 'Setup',
      matchKind: 'legacy_unknown',
      snippetPolicy: 'reference_only',
      startLineWindow: 1,
      endLineWindow: 2,
      legacyState: 'legacy_payload',
    });
  });

  it('uses page provenance for page citations and null span ids when no span exists', () => {
    const context = legacyCitationContext({ ...spanCitation, pageId: 'page_1', span: null }, 'legacy_unknown');
    expect(context).toMatchObject({
      fieldKind: 'page_provenance',
      sourceSpanId: null,
      fieldLabel: null,
      startLineWindow: null,
      endLineWindow: null,
      legacyState: 'legacy_unknown',
    });
  });
});

describe('parseMessagePayload', () => {
  it('normalizes a legacy payload without schemaVersion to V2 with legacy_payload context', () => {
    const payload = parseMessagePayload(
      JSON.stringify({ content: 'hi', citations: [spanCitation], retrievalMode: 'sources' }),
    );
    expect(payload.schemaVersion).toBe(2);
    expect(payload.synthesis).toBeNull();
    expect(payload.citations[0]?.context).toMatchObject({ legacyState: 'legacy_payload', matchKind: 'legacy_unknown' });
    expect(payload.citations[0]?.context?.sourceSpanId).toBe('span_1');
  });

  it('keeps additive context from a current V2 payload', () => {
    const payload = parseMessagePayload(
      JSON.stringify({
        schemaVersion: 2,
        content: 'hi',
        citations: [{ ...spanCitation, context: validContext }],
        retrievalMode: null,
      }),
    );
    expect(payload.citations[0]?.context).toEqual(validContext);
    expect(payload.retrievalMode).toBeNull();
  });

  it('degrades a malformed context to an explicit legacy_unknown marker', () => {
    const payload = parseMessagePayload(
      JSON.stringify({
        schemaVersion: 2,
        content: 'hi',
        citations: [{ ...spanCitation, context: { ...validContext, excerpt: 'leak', matchKind: 'bogus' } }],
        retrievalMode: 'sources',
      }),
    );
    const context = payload.citations[0]?.context;
    expect(context).toMatchObject({ legacyState: 'legacy_unknown', matchKind: 'legacy_unknown', snippetPolicy: 'reference_only' });
    expect(JSON.stringify(context)).not.toContain('leak');
  });

  it('marks a V2 citation that lacks context as legacy_unknown', () => {
    const payload = parseMessagePayload(
      JSON.stringify({ schemaVersion: 2, content: 'hi', citations: [spanCitation], retrievalMode: null }),
    );
    expect(payload.citations[0]?.context?.legacyState).toBe('legacy_unknown');
  });

  it('validates the synthesis slot as a plain object or null', () => {
    const base = { schemaVersion: 2, content: 'hi', citations: [], retrievalMode: null };
    expect(parseMessagePayload(JSON.stringify({ ...base, synthesis: { any: 'shape' } })).synthesis).toEqual({ any: 'shape' });
    expect(parseMessagePayload(JSON.stringify({ ...base, synthesis: null })).synthesis).toBeNull();
    expect(() => parseMessagePayload(JSON.stringify({ ...base, synthesis: 'x' }))).toThrow(/synthesis/i);
  });

  it('rejects unsupported schema versions and structurally invalid payloads', () => {
    expect(() => parseMessagePayload(JSON.stringify({ schemaVersion: 3, content: 'x', citations: [] }))).toThrow(/schemaVersion/i);
    expect(() => parseMessagePayload('{')).toThrow(/valid JSON/i);
    expect(() => parseMessagePayload(JSON.stringify({ content: 'x', citations: ['bad'] }))).toThrow(/citation 1/i);
    expect(() => parseMessagePayload(JSON.stringify({ content: 'x', citations: [], retrievalMode: 'nope' }))).toThrow(/retrievalMode/i);
  });
});

describe('serializeMessagePayload', () => {
  it('writes only reference-level V2 data and omits an absent synthesis slot', () => {
    const raw = serializeMessagePayload({
      content: 'answer',
      retrievalMode: 'sources',
      citations: [
        {
          ...spanCitation,
          excerpt: 'raw source text',
          context: { ...validContext, snippetPolicy: 'ephemeral_redacted', excerpt: 'raw source text' },
        } as never,
      ],
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed).not.toHaveProperty('synthesis');
    expect(raw).not.toContain('raw source text');
    expect((parsed.citations as Array<{ context: { snippetPolicy: string } }>)[0]?.context.snippetPolicy).toBe('reference_only');
  });
});

describe('deriveCitationContext', () => {
  function seed() {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_1', 'unused-workspace', 'Wiki', 'active', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT);
    db.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, current_hash, status, created_at, updated_at)
       VALUES ('source_1', 'project_1', 'file', 'docs/setup-guide.md', 'hash1', 'active', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT);
    db.prepare(
      `INSERT INTO knowledge_source_versions (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
       VALUES ('source_version_1', 'project_1', 'source_1', 1, 'hash1', 'sources/setup-guide.md', 100, ?)`,
    ).run(CREATED_AT);
    db.prepare(
      `INSERT INTO knowledge_source_spans (id, project_id, source_version_id, start_offset, end_offset, start_line, start_column, end_line, end_column, label, created_at)
       VALUES ('span_1', 'project_1', 'source_version_1', 0, 10, 1, 1, 2, 4, 'Setup', ?)`,
    ).run(CREATED_AT);
    return db;
  }

  it('resolves the persisted span and source version for an exact span citation', () => {
    const db = seed();
    expect(deriveCitationContext(db, 'project_1', spanCitation)).toEqual({
      sourceVersionId: 'source_version_1',
      sourceSpanId: 'span_1',
      fieldKind: 'section',
      fieldLabel: 'Setup',
      matchKind: 'exact_span',
      snippetPolicy: 'reference_only',
      startLineWindow: 1,
      endLineWindow: 2,
      legacyState: 'current',
    });
    db.close();
  });

  it('does not resolve a span that is not persisted for the project', () => {
    const db = seed();
    const context = deriveCitationContext(db, 'project_1', {
      ...spanCitation,
      span: { ...spanCitation.span!, id: 'span_missing' },
    });
    expect(context).toMatchObject({ sourceSpanId: null, sourceVersionId: null, matchKind: 'metadata_only' });
    db.close();
  });

  it('reports metadata-only for source citations and page provenance for page citations', () => {
    const db = seed();
    expect(deriveCitationContext(db, 'project_1', { ...spanCitation, span: null })).toMatchObject({
      matchKind: 'metadata_only',
      fieldKind: 'path_metadata',
      sourceSpanId: null,
    });
    expect(deriveCitationContext(db, 'project_1', { ...spanCitation, pageId: 'page_1', span: null })).toMatchObject({
      matchKind: 'page_provenance',
      fieldKind: 'page_provenance',
    });
    db.close();
  });
});
