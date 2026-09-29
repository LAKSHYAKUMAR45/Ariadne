import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import type { DeterministicExtraction } from '../../src/knowledge/KnowledgeExtraction.js';
import { KnowledgeExtractionStore } from '../../src/knowledge/KnowledgeExtractionStore.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import {
  KNOWLEDGE_SEARCH_INDEX_VERSION,
  KnowledgeSearchIndex,
  MAX_RESULT_CANDIDATES,
  MAX_SEARCH_FIELDS,
  setKnowledgeSearchIndexChangedHook,
} from '../../src/knowledge/KnowledgeSearchIndex.js';

const PROJECT_ID = 'project_1';
const OTHER_PROJECT_ID = 'project_2';
const CREATED_AT = '2026-09-29T00:00:00.000Z';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function span(start: number, end: number) {
  return { startOffset: start, endOffset: end, startLine: 1, startColumn: start + 1, endLine: 1, endColumn: end + 1 };
}

function buildExtraction(
  sourceVersionId: string,
  overrides: Partial<DeterministicExtraction> = {},
): DeterministicExtraction {
  return {
    analyzerId: 'typescript-lezer',
    analyzerVersion: '1',
    sourceVersionId,
    title: 'src/loader.ts',
    summary: 'Loads widgets.',
    sections: [
      { id: 'section:1', kind: 'code', title: 'Widget loader', text: 'export function loadWidget() {}', span: span(0, 30), confidence: 1 },
    ],
    symbols: [
      {
        id: 'symbol:1',
        kind: 'function',
        name: 'loadWidget',
        qualifiedName: 'wiki.loadWidget',
        span: span(16, 26),
        confidence: 1,
      },
    ],
    relationships: [],
    links: [],
    diagnostics: [],
    ...overrides,
  };
}

interface FieldRow {
  field_order: number;
  field_kind: string;
  field_text: string;
  field_weight: number;
  rank_class: number;
  span_id: string | null;
  symbol_kind: string | null;
  symbol_name: string | null;
}

describe('KnowledgeSearchIndex', () => {
  let db: Database.Database;
  let sources: KnowledgeSourceStore;
  let extractions: KnowledgeExtractionStore;
  let index: KnowledgeSearchIndex;

  beforeEach(() => {
    db = openDatabase(':memory:');
    for (const id of [PROJECT_ID, OTHER_PROJECT_ID]) {
      db.prepare(
        `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(id, `/workspace/${id}`, id, CREATED_AT, CREATED_AT);
    }
    sources = new KnowledgeSourceStore(db);
    extractions = new KnowledgeExtractionStore(db);
    index = new KnowledgeSearchIndex(db, { now: () => CREATED_AT });
  });

  afterEach(() => {
    setKnowledgeSearchIndexChangedHook(null);
    db.close();
  });

  function register(path: string, content = 'content', projectId = PROJECT_ID) {
    const source = sources.register({ projectId, kind: 'file', path, content, format: 'typescript' });
    const versions = sources.listVersions(projectId, source.id);
    return { source, versionId: versions[versions.length - 1].id };
  }

  function analyze(versionId: string, overrides: Partial<DeterministicExtraction> = {}, projectId = PROJECT_ID) {
    return extractions.save({ projectId, extraction: buildExtraction(versionId, overrides) });
  }

  function fields(versionId: string): FieldRow[] {
    return db
      .prepare(
        `SELECT f.field_order, f.field_kind, f.field_text, f.field_weight, f.rank_class, f.span_id, f.symbol_kind, f.symbol_name
         FROM knowledge_search_index_fields f
         JOIN knowledge_search_indexes i ON i.project_id = f.project_id AND i.id = f.index_id
         WHERE i.source_version_id = ?
         ORDER BY f.field_order`,
      )
      .all(versionId) as FieldRow[];
  }

  function indexRow(versionId: string) {
    return db
      .prepare('SELECT * FROM knowledge_search_indexes WHERE source_version_id = ?')
      .get(versionId) as
      | {
          id: string;
          status: string;
          coverage: string;
          extraction_id: string | null;
          field_count: number;
          index_version: number;
        }
      | undefined;
  }

  it('materializes deterministic redacted fields with spans, weights, and rank classes', () => {
    const { versionId } = register('src/loader.ts');
    const saved = analyze(versionId);

    index.replaceForSourceVersion({
      projectId: PROJECT_ID,
      sourceVersionId: versionId,
      coverage: 'extraction',
      extractionId: saved.id,
    });

    expect(indexRow(versionId)).toMatchObject({
      status: 'active',
      coverage: 'extraction',
      extraction_id: saved.id,
      index_version: KNOWLEDGE_SEARCH_INDEX_VERSION,
    });
    const rows = fields(versionId);
    expect(rows.filter((row) => row.field_kind !== 'path').map((row) => [row.field_kind, row.field_text, row.field_weight, row.rank_class])).toEqual([
      ['symbol', 'wiki.loadWidget', 10, 2],
      ['symbol', 'loadWidget', 8, 2],
      ['section', 'Widget loader', 7, 2],
      ['section', 'export function loadWidget() {}', 5, 2],
      ['title', 'src/loader.ts', 6, 1],
      ['summary', 'Loads widgets.', 3, 1],
    ]);
    expect(rows.slice(0, 2).every((row) => row.symbol_kind === 'function' && row.span_id !== null)).toBe(true);
    expect(rows.map((row) => row.field_order)).toEqual(rows.map((_, position) => position));
    expect(indexRow(versionId)?.field_count).toBe(rows.length);
  });

  it('replaces idempotently without duplicating rows or fields', () => {
    const { versionId } = register('src/loader.ts');
    const saved = analyze(versionId);
    const input = { projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'extraction' as const, extractionId: saved.id };

    index.replaceForSourceVersion(input);
    const first = fields(versionId);
    index.replaceForSourceVersion(input);

    expect(fields(versionId)).toEqual(first);
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_search_indexes').get()).toEqual({ c: 1 });
  });

  it('builds metadata_only indexes from redacted path, title, and summary fields', () => {
    const { versionId } = register('docs/notes.md');

    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'metadata_only' });

    expect(indexRow(versionId)).toMatchObject({ coverage: 'metadata_only', extraction_id: null, status: 'active' });
    const kinds = new Set(fields(versionId).map((row) => row.field_kind));
    expect([...kinds].sort()).toEqual(['path', 'summary', 'title']);
    expect(fields(versionId).some((row) => row.field_text.includes('docs/notes.md'))).toBe(true);
  });

  it('rejects malformed, missing, cross-project, and mismatched inputs without writing rows', () => {
    const { versionId } = register('src/loader.ts');
    const other = register('src/other.ts', 'other');
    const otherSaved = analyze(other.versionId);
    const foreign = register('src/foreign.ts', 'foreign', OTHER_PROJECT_ID);

    expect(() =>
      index.replaceForSourceVersion({ projectId: '', sourceVersionId: versionId, coverage: 'metadata_only' }),
    ).toThrow(/project/i);
    expect(() =>
      index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: 'missing', coverage: 'metadata_only' }),
    ).toThrow(/source version/i);
    expect(() =>
      index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: foreign.versionId, coverage: 'metadata_only' }),
    ).toThrow(/source version/i);
    expect(() =>
      index.replaceForSourceVersion({
        projectId: PROJECT_ID,
        sourceVersionId: versionId,
        coverage: 'extraction',
        extractionId: otherSaved.id,
      }),
    ).toThrow(/extraction/i);
    expect(() =>
      index.replaceForSourceVersion({
        projectId: PROJECT_ID,
        sourceVersionId: versionId,
        coverage: 'extraction',
        extractionId: 'missing',
      }),
    ).toThrow(/extraction/i);
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_search_indexes').get()).toEqual({ c: 0 });
  });

  it('never stores secrets in field text and keeps redaction placeholders out of matching needles', () => {
    const { versionId } = register('src/secret.ts');
    const saved = analyze(versionId);
    db.prepare('UPDATE knowledge_extractions SET result_json = ? WHERE id = ?').run(
      JSON.stringify(
        buildExtraction(versionId, {
          title: `token ${SECRET}`,
          summary: `uses ${SECRET}`,
          sections: [
            { id: 'section:1', kind: 'code', title: `key ${SECRET}`, text: `const t = "${SECRET}";`, span: span(0, 30), confidence: 1 },
          ],
          symbols: [
            { id: 'symbol:1', kind: 'constant', name: SECRET, span: span(6, 20), confidence: 1 },
          ],
        }),
      ),
      saved.id,
    );

    index.replaceForSourceVersion({
      projectId: PROJECT_ID,
      sourceVersionId: versionId,
      coverage: 'extraction',
      extractionId: saved.id,
    });

    const persisted = db
      .prepare('SELECT field_text, symbol_name FROM knowledge_search_index_fields')
      .all() as Array<{ field_text: string; symbol_name: string | null }>;
    expect(persisted.length).toBeGreaterThan(0);
    for (const row of persisted) {
      expect(row.field_text).not.toContain(SECRET);
      expect(row.symbol_name ?? '').not.toContain(SECRET);
    }
  });

  it('marks degraded extractions failed and keeps them out of candidate lookup', () => {
    const { versionId } = register('src/broken.ts');
    const saved = analyze(versionId);
    db.prepare('UPDATE knowledge_extractions SET result_json = ? WHERE id = ?').run('{not-json}', saved.id);

    index.replaceForSourceVersion({
      projectId: PROJECT_ID,
      sourceVersionId: versionId,
      coverage: 'extraction',
      extractionId: saved.id,
    });

    expect(indexRow(versionId)).toMatchObject({ status: 'failed', field_count: 0 });
    expect(index.getStatus(PROJECT_ID)).toMatchObject({ failedCount: 1, indexedCount: 0, unindexedCount: 1 });
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['broken'] })).toEqual([]);
  });

  it('finds project-scoped candidates from indexed fields, metadata, and hashes', () => {
    const a = register('src/loader.ts');
    index.replaceForSourceVersion({
      projectId: PROJECT_ID,
      sourceVersionId: a.versionId,
      coverage: 'extraction',
      extractionId: analyze(a.versionId).id,
    });
    const b = register('docs/widget-notes.md', 'notes');
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: b.versionId, coverage: 'metadata_only' });
    const foreign = register('src/loader.ts', 'foreign', OTHER_PROJECT_ID);
    index.replaceForSourceVersion({
      projectId: OTHER_PROJECT_ID,
      sourceVersionId: foreign.versionId,
      coverage: 'extraction',
      extractionId: analyze(foreign.versionId, {}, OTHER_PROJECT_ID).id,
    });

    const byField = index.findCandidates({ projectId: PROJECT_ID, needles: ['loadwidget'] });
    expect(byField.map((candidate) => candidate.sourceId)).toEqual([a.source.id]);
    expect(byField[0]).toMatchObject({
      coverage: 'extraction',
      sourceVersionId: a.versionId,
      relevance: 2,
      analyzerId: 'typescript-lezer',
    });
    expect(byField[0].extraction?.fields.length).toBeGreaterThan(0);
    expect([...new Set(byField[0].extraction?.symbolKinds)]).toEqual(['function']);

    const byPath = index.findCandidates({ projectId: PROJECT_ID, needles: ['widget-notes'] });
    expect(byPath.map((candidate) => candidate.sourceId)).toEqual([b.source.id]);
    expect(byPath[0]).toMatchObject({ coverage: 'metadata_only', extraction: null, relevance: 1 });

    const withHash = index.findCandidates({ projectId: PROJECT_ID, needles: [a.source.contentHash.slice(0, 12)] });
    expect(withHash.map((candidate) => candidate.sourceId)).toEqual([a.source.id]);

    expect(index.findCandidates({ projectId: OTHER_PROJECT_ID, needles: ['widget-notes'] })).toEqual([]);
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: [] })).toEqual([]);
  });

  it('restricts candidates to span-backed field matches and excludes named sources', () => {
    const backed = register('src/loader.ts');
    index.replaceForSourceVersion({
      projectId: PROJECT_ID,
      sourceVersionId: backed.versionId,
      coverage: 'extraction',
      extractionId: analyze(backed.versionId).id,
    });
    const metadataOnly = register('docs/loadwidget-notes.md', 'notes');
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: metadataOnly.versionId, coverage: 'metadata_only' });
    const query = { projectId: PROJECT_ID, needles: ['loadwidget'] };

    expect(index.findCandidates(query).map((candidate) => candidate.sourceId).sort()).toEqual(
      [backed.source.id, metadataOnly.source.id].sort(),
    );
    const spanBacked = index.findCandidates({ ...query, spanBackedOnly: true });
    expect(spanBacked.map((candidate) => candidate.sourceId)).toEqual([backed.source.id]);
    expect(spanBacked[0].relevance).toBe(2);
    expect(index.findCandidates({ ...query, spanBackedOnly: true, excludeSourceIds: [backed.source.id] })).toEqual([]);
    expect(index.findCandidates({ ...query, excludeSourceIds: [backed.source.id] }).map((candidate) => candidate.sourceId)).toEqual([
      metadataOnly.source.id,
    ]);
    expect(index.findCandidates({ ...query, limit: 1 })).toHaveLength(1);
  });

  it('lists usable indexes of current versions in a stable path order within the limit', () => {
    const b = register('src/b.ts');
    const a = register('src/a.ts');
    const stale = register('src/stale.ts');
    const foreign = register('src/foreign.ts', 'foreign', OTHER_PROJECT_ID);
    register('src/unindexed.ts');
    for (const entry of [b, a, stale]) {
      index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: entry.versionId, coverage: 'metadata_only' });
    }
    index.replaceForSourceVersion({ projectId: OTHER_PROJECT_ID, sourceVersionId: foreign.versionId, coverage: 'metadata_only' });
    index.markSourceStale(PROJECT_ID, stale.source.id);

    expect(index.listUsableIndexes(PROJECT_ID, 10).map((entry) => entry.sourceVersionId)).toEqual([a.versionId, b.versionId]);
    expect(index.listUsableIndexes(PROJECT_ID, 1).map((entry) => entry.sourceVersionId)).toEqual([a.versionId]);
    expect(index.listUsableIndexes(PROJECT_ID, 0)).toEqual([]);
    expect(index.listUsableIndexes(OTHER_PROJECT_ID, 10).map((entry) => entry.sourceVersionId)).toEqual([foreign.versionId]);
  });

  it('passes the owning connection to the change hook so consumers write in the same transaction', () => {
    const { versionId } = register('src/loader.ts');
    const contexts: unknown[] = [];
    setKnowledgeSearchIndexChangedHook((_event, context) => contexts.push(context.db));

    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'metadata_only' });

    expect(contexts).toEqual([db]);
  });

  it('excludes stale, superseded-version, superseded-extraction, and old index-version rows', () => {
    const a = register('src/alpha.ts', 'alpha v1');
    index.replaceForSourceVersion({
      projectId: PROJECT_ID,
      sourceVersionId: a.versionId,
      coverage: 'extraction',
      extractionId: analyze(a.versionId, { title: 'alpha' }).id,
    });
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['alpha'] })).toHaveLength(1);

    // pending newer version: old index must not serve it
    sources.register({ projectId: PROJECT_ID, kind: 'file', path: 'src/alpha.ts', content: 'alpha v2', format: 'typescript' });
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['alpha'] })).toEqual([]);
    expect(index.getStatus(PROJECT_ID)).toMatchObject({ indexedCount: 0, unindexedCount: 1 });
    expect(index.getUnindexedSourceIds(PROJECT_ID)).toEqual([a.source.id]);

    const b = register('src/beta.ts', 'beta');
    const first = analyze(b.versionId, { analyzerVersion: '1', title: 'beta' });
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: b.versionId, coverage: 'extraction', extractionId: first.id });
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['beta'] })).toHaveLength(1);
    extractions.save({
      projectId: PROJECT_ID,
      extraction: buildExtraction(b.versionId, { analyzerVersion: '2', title: 'beta' }),
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['beta'] })).toEqual([]);

    const c = register('src/gamma.ts', 'gamma');
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: c.versionId, coverage: 'metadata_only' });
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['gamma'] })).toHaveLength(1);
    db.prepare('UPDATE knowledge_search_indexes SET index_version = ? WHERE source_version_id = ?').run(
      KNOWLEDGE_SEARCH_INDEX_VERSION + 1,
      c.versionId,
    );
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['gamma'] })).toEqual([]);

    const d = register('src/delta.ts', 'delta');
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: d.versionId, coverage: 'metadata_only' });
    index.markSourceStale(PROJECT_ID, d.source.id);
    expect(indexRow(d.versionId)?.status).toBe('stale');
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['delta'] })).toEqual([]);
    expect(index.getStatus(PROJECT_ID).staleCount).toBeGreaterThanOrEqual(1);
  });

  it('excludes deleted sources and does not cross project boundaries when marking stale', () => {
    const a = register('src/alpha.ts', 'alpha');
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: a.versionId, coverage: 'metadata_only' });
    const foreign = register('src/alpha.ts', 'alpha', OTHER_PROJECT_ID);
    index.replaceForSourceVersion({ projectId: OTHER_PROJECT_ID, sourceVersionId: foreign.versionId, coverage: 'metadata_only' });

    index.markSourceStale(OTHER_PROJECT_ID, a.source.id);
    expect(indexRow(a.versionId)?.status).toBe('active');

    sources.markDeleted(PROJECT_ID, a.source.id);
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['alpha'] })).toEqual([]);
    expect(index.findCandidates({ projectId: OTHER_PROJECT_ID, needles: ['alpha'] })).toHaveLength(1);
    expect(indexRow(a.versionId)?.status).toBe('stale');
  });

  it('bounds candidates, indexed fields, and field text volume', () => {
    for (let position = 0; position < 7; position += 1) {
      const { versionId } = register(`docs/match-${position}.md`, `content ${position}`);
      index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'metadata_only' });
    }
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['match'], limit: 3 })).toHaveLength(3);
    expect(index.findCandidates({ projectId: PROJECT_ID, needles: ['match'], limit: 10_000 })).toHaveLength(7);
    expect(MAX_RESULT_CANDIDATES).toBe(500);

    const big = register('src/big.ts', 'big');
    const sections = Array.from({ length: 200 }, (_, item) => ({
      id: `section:${item}`,
      kind: 'code',
      title: `title ${item}`,
      text: `text ${item}`,
      span: span(item, item + 1),
      confidence: 1,
    }));
    const symbols = Array.from({ length: 200 }, (_, item) => ({
      id: `symbol:${item}`,
      kind: 'function' as const,
      name: `fn${item}`,
      qualifiedName: `mod.fn${item}`,
      span: span(item, item + 1),
      confidence: 1,
    }));
    const saved = analyze(big.versionId, { sections, symbols });
    index.replaceForSourceVersion({
      projectId: PROJECT_ID,
      sourceVersionId: big.versionId,
      coverage: 'extraction',
      extractionId: saved.id,
    });
    expect(fields(big.versionId).filter((row) => row.field_kind !== 'path').length).toBeLessThanOrEqual(MAX_SEARCH_FIELDS);
  });

  it('rolls back replacement when the change hook fails and keeps the previous index', () => {
    const { versionId } = register('src/loader.ts');
    const saved = analyze(versionId);
    const input = { projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'extraction' as const, extractionId: saved.id };
    index.replaceForSourceVersion(input);
    const before = fields(versionId);

    setKnowledgeSearchIndexChangedHook(() => {
      throw new Error('hook failed');
    });
    expect(() => index.replaceForSourceVersion(input)).toThrow('hook failed');
    setKnowledgeSearchIndexChangedHook(null);

    expect(fields(versionId)).toEqual(before);
    expect(indexRow(versionId)?.status).toBe('active');
  });

  it('invokes the optional index-changed hook for replace and stale marking, and is a no-op by default', () => {
    const { source, versionId } = register('src/loader.ts');
    expect(() =>
      index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'metadata_only' }),
    ).not.toThrow();

    const events: unknown[] = [];
    setKnowledgeSearchIndexChangedHook((event) => events.push(event));
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'metadata_only' });
    index.markSourceStale(PROJECT_ID, source.id);

    expect(events).toEqual([
      { projectId: PROJECT_ID, sourceVersionId: versionId, reason: 'replaced' },
      { projectId: PROJECT_ID, sourceId: source.id, reason: 'stale' },
    ]);
  });

  it('reports partial coverage and rebuilds a project without touching other projects', () => {
    const a = register('src/loader.ts');
    const b = register('docs/notes.md', 'notes');
    register('docs/pending.md', 'pending');
    const foreign = register('docs/foreign.md', 'foreign', OTHER_PROJECT_ID);
    analyze(a.versionId);
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: b.versionId, coverage: 'metadata_only' });

    expect(index.getStatus(PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      indexVersion: KNOWLEDGE_SEARCH_INDEX_VERSION,
      indexedCount: 1,
      unindexedCount: 2,
      staleCount: 0,
      failedCount: 0,
      metadataOnlyCount: 1,
    });

    const report = index.rebuildProject(PROJECT_ID);

    expect(report).toMatchObject({
      projectId: PROJECT_ID,
      extractionIndexed: 1,
      metadataOnlyIndexed: 2,
      failed: 0,
      failures: [],
    });
    expect(index.getStatus(PROJECT_ID)).toMatchObject({ indexedCount: 3, unindexedCount: 0, metadataOnlyCount: 2 });
    expect(indexRow(foreign.versionId)).toBeUndefined();
    expect(index.getStatus(OTHER_PROJECT_ID)).toMatchObject({ indexedCount: 0, unindexedCount: 1 });
  });

  it('counts document frequency over usable indexed documents with exact legacy presence semantics', () => {
    const a = register('src/loader.ts');
    index.replaceForSourceVersion({
      projectId: PROJECT_ID,
      sourceVersionId: a.versionId,
      coverage: 'extraction',
      extractionId: analyze(a.versionId).id,
    });
    const b = register('docs/loader-notes.md', 'notes');
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: b.versionId, coverage: 'metadata_only' });

    const counts = index.documentFrequency(PROJECT_ID, [
      { term: 'loader', variants: ['loader'] },
      { term: 'widget', variants: ['widget'] },
      { term: 'absent', variants: ['absent'] },
    ]);

    expect(counts.get('loader')).toBe(2);
    expect(counts.get('widget')).toBe(1);
    expect(counts.get('absent')).toBe(0);
  });

  it('deletes a project with span-backed index fields present', () => {
    const { versionId } = register('src/loader.ts');
    const saved = analyze(versionId);
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'extraction', extractionId: saved.id });
    expect(fields(versionId).some((row) => row.span_id !== null)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_search_index_tokens').get()).not.toEqual({ c: 0 });

    expect(() => db.prepare('DELETE FROM knowledge_projects WHERE id = ?').run(PROJECT_ID)).not.toThrow();

    for (const table of [
      'knowledge_search_indexes',
      'knowledge_search_index_fields',
      'knowledge_search_index_tokens',
      'knowledge_source_spans',
      'knowledge_source_versions',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?`).get(PROJECT_ID)).toEqual({ c: 0 });
    }
  });

  it('deletes a source version whose spans back index fields', () => {
    const { source, versionId } = register('src/loader.ts');
    const saved = analyze(versionId);
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'extraction', extractionId: saved.id });

    expect(() => db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(source.id)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_search_index_fields').get()).toEqual({ c: 0 });
  });

  it('keeps token rows in step with replaced fields and drops them with the index', () => {
    const { versionId } = register('src/loader.ts');
    const saved = analyze(versionId);
    const input = { projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'extraction' as const, extractionId: saved.id };
    const tokens = () =>
      db.prepare('SELECT token FROM knowledge_search_index_tokens WHERE project_id = ? ORDER BY token').all(PROJECT_ID) as Array<{ token: string }>;

    index.replaceForSourceVersion(input);
    const first = tokens();
    index.replaceForSourceVersion(input);

    expect(tokens()).toEqual(first);
    expect(first.map((row) => row.token)).toEqual(expect.arrayContaining(['loa', 'oad', 'wid']));
    expect(first.every((row) => row.token === row.token.toLocaleLowerCase())).toBe(true);
    db.prepare('DELETE FROM knowledge_search_indexes WHERE source_version_id = ?').run(versionId);
    expect(tokens()).toEqual([]);
  });

  describe('candidate narrowing work', () => {
    const DOCUMENTS = 120;

    function seedCorpus() {
      for (let position = 0; position < DOCUMENTS; position += 1) {
        const { versionId } = register(`src/module${position}.ts`, `content ${position}`);
        const rare = position === 57;
        const saved = analyze(versionId, {
          title: `module${position}`,
          summary: `Handles routine chores ${position}.`,
          sections: [
            { id: 'section:1', kind: 'code', title: `Section ${position}`, text: 'plain body text', span: span(0, 10), confidence: 1 },
          ],
          symbols: [
            { id: 'symbol:1', kind: 'function', name: rare ? 'zebraCrossing' : `helper${position}`, qualifiedName: `mod.fn${position}`, span: span(0, 5), confidence: 1 },
          ],
        });
        index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versionId, coverage: 'extraction', extractionId: saved.id });
      }
      return (db.prepare('SELECT COUNT(*) AS c FROM knowledge_search_index_fields WHERE project_id = ?').get(PROJECT_ID) as { c: number }).c;
    }

    it('verifies only narrowed fields instead of scanning every indexed field', () => {
      const totalFields = seedCorpus();
      index.resetWorkCounters();

      const candidates = index.findCandidates({ projectId: PROJECT_ID, needles: ['zebracrossing'] });

      expect(candidates.map((candidate) => candidate.sourcePath)).toEqual(['src/module57.ts']);
      const { fieldTextChecks } = index.getWorkCounters();
      expect(fieldTextChecks).toBeGreaterThan(0);
      expect(fieldTextChecks).toBeLessThan(totalFields / 20);
    });

    it('computes document frequency for every term in one bounded pass', () => {
      const totalFields = seedCorpus();
      const terms = [
        { term: 'zebracrossing', variants: ['zebracrossing'] },
        { term: 'routine', variants: ['routine', 'routin'] },
        { term: 'absentterm', variants: ['absentterm'] },
        { term: 'chores', variants: ['chores', 'chore'] },
      ];
      index.resetWorkCounters();

      const counts = index.documentFrequency(PROJECT_ID, terms);

      expect(counts.get('zebracrossing')).toBe(1);
      expect(counts.get('absentterm')).toBe(0);
      expect(counts.get('routine')).toBe(DOCUMENTS);
      expect(counts.get('chores')).toBe(DOCUMENTS);
      // Scanning per needle would fold every field once for each of the six needles; narrowing stays below one scan.
      expect(index.getWorkCounters().fieldTextChecks).toBeLessThan(totalFields);
    });

    it('still finds needles shorter than a token by scanning fields', () => {
      seedCorpus();
      const candidates = index.findCandidates({ projectId: PROJECT_ID, needles: ['zb'] });
      expect(candidates).toEqual([]);
      const found = index.findCandidates({ projectId: PROJECT_ID, needles: ['ze'] });
      expect(found.map((candidate) => candidate.sourcePath)).toContain('src/module57.ts');
    });
  });
});
