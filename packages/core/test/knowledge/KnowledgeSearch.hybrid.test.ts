import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import type { DeterministicExtraction } from '../../src/knowledge/KnowledgeExtraction.js';
import { KnowledgeExtractionStore } from '../../src/knowledge/KnowledgeExtractionStore.js';
import {
  KnowledgeLocalSemanticIndex,
  MAX_EXPANSION_CANDIDATES,
} from '../../src/knowledge/KnowledgeLocalSemanticIndex.js';
import { KnowledgeSearchIndex, setKnowledgeSearchIndexChangedHook } from '../../src/knowledge/KnowledgeSearchIndex.js';
import { searchKnowledge, type KnowledgeSearchDiagnostic, type KnowledgeSearchOptions } from '../../src/knowledge/KnowledgeSearch.js';
import { KnowledgeHostSettingsStore, KnowledgeSearchSettingsStore } from '../../src/knowledge/KnowledgeHostSettingsStore.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';

const PROJECT_ID = 'project_1';
const OTHER_PROJECT_ID = 'project_2';
const SEMANTIC_KEYS = ['rankingMethod', 'semanticScore', 'semanticReordered', 'expandedByNeighbor'] as const;
const NOW = '2026-09-29T00:00:00.000Z';

function span(start: number, end: number) {
  return { startOffset: start, endOffset: end, startLine: 1, startColumn: start + 1, endLine: 1, endColumn: end + 1 };
}

interface DocSpec {
  title: string;
  sections: Array<{ title: string; text: string }>;
  summary?: string;
}

function buildExtraction(sourceVersionId: string, doc: DocSpec): DeterministicExtraction {
  return {
    analyzerId: 'markdown',
    analyzerVersion: '1',
    sourceVersionId,
    title: doc.title,
    summary: doc.summary ?? 'Notes.',
    sections: doc.sections.map((section, index) => ({
      id: `section:${index}`,
      kind: 'code' as const,
      title: section.title,
      text: section.text,
      span: span(index * 10, index * 10 + 9),
      confidence: 1,
    })),
    symbols: [],
    relationships: [],
    links: [],
    diagnostics: [],
  };
}


describe('hybrid local semantic search', () => {
  let db: Database.Database;
  let sources: KnowledgeSourceStore;
  let extractions: KnowledgeExtractionStore;
  let searchIndex: KnowledgeSearchIndex;
  let semantic: KnowledgeLocalSemanticIndex;
  let settings: KnowledgeSearchSettingsStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    for (const id of [PROJECT_ID, OTHER_PROJECT_ID]) {
      db.prepare(
        `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(id, `/workspace/${id}`, id, NOW, NOW);
    }
    sources = new KnowledgeSourceStore(db);
    extractions = new KnowledgeExtractionStore(db);
    searchIndex = new KnowledgeSearchIndex(db, { now: () => NOW });
    semantic = new KnowledgeLocalSemanticIndex(db);
    settings = new KnowledgeSearchSettingsStore(new KnowledgeHostSettingsStore(db));
  });

  afterEach(() => {
    setKnowledgeSearchIndexChangedHook(null);
    db.close();
  });

  function indexDoc(path: string, text: string, projectId = PROJECT_ID) {
    const source = sources.register({ projectId, kind: 'file', path, content: `content of ${path}`, format: 'markdown' });
    const versions = sources.listVersions(projectId, source.id);
    const versionId = versions[versions.length - 1].id;
    const doc: DocSpec = { title: 'Notes', sections: [{ title: 'Notes', text }] };
    const saved = extractions.save({ projectId, extraction: buildExtraction(versionId, doc) });
    searchIndex.replaceForSourceVersion({ projectId, sourceVersionId: versionId, coverage: 'extraction', extractionId: saved.id });
    return source.id;
  }

  function seedCorpus(projectId = PROJECT_ID) {
    return {
      a: indexDoc('src/a.ts', 'invoice ledger entries', projectId),
      b: indexDoc('src/b.ts', 'invoice billing statements', projectId),
      c: indexDoc('src/c.ts', 'invoice billing ledger', projectId),
      d: indexDoc('src/d.ts', 'billing statement generator', projectId),
    };
  }

  function search(query: string, extra: Partial<KnowledgeSearchOptions> = {}, projectId = PROJECT_ID) {
    return searchKnowledge(query, { db, projectId, mode: 'sources', ...extra });
  }

  const titles = (results: ReturnType<typeof search>) => results.map((result) => result.title);

  function expectLexicalOnly(results: ReturnType<typeof search>) {
    for (const result of results) for (const key of SEMANTIC_KEYS) expect(result).not.toHaveProperty(key);
  }

  it('stays lexical-only by default even when an active model exists', () => {
    seedCorpus();
    semantic.replaceForProject(PROJECT_ID);

    const results = search('invoice');

    expectLexicalOnly(results);
    expect(results).toEqual(search('invoice', { semanticRetrieval: 'off' }));
  });

  it('never builds a model when semantic retrieval is enabled', () => {
    seedCorpus();
    settings.setHybridEnabled(PROJECT_ID, true);

    const results = search('invoice', { semanticRetrieval: 'if-available' });

    expectLexicalOnly(results);
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_search_semantic_models').get()).toEqual({ n: 0 });
  });

  it('reorders the ambiguous near-tie cluster by semantic score and moves the confidence to the new leader', () => {
    seedCorpus();
    semantic.replaceForProject(PROJECT_ID);
    const lexical = search('invoice');

    const hybrid = search('invoice', { semanticRetrieval: 'if-available' });

    expect(lexical[0]).toMatchObject({ title: expect.stringContaining('a.ts'), searchConfidence: 'ambiguous' });
    expect(hybrid[0].title).not.toBe(lexical[0].title);
    expect(hybrid[0]).toMatchObject({
      searchConfidence: 'ambiguous',
      ambiguityReason: lexical[0].ambiguityReason,
      ambiguityAlternatives: lexical[0].ambiguityAlternatives,
      rankingMethod: 'hybrid',
      semanticReordered: true,
    });
    expect(hybrid.filter((result) => result.searchConfidence !== undefined)).toHaveLength(1);
    const scores = hybrid.filter((result) => !result.expandedByNeighbor).map((result) => result.semanticScore as number);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
    expect(hybrid.every((result) => result.rankingMethod === 'hybrid')).toBe(true);
    expect(new Set(titles(hybrid))).toEqual(new Set([...titles(lexical), ...titles(hybrid).filter((path) => path.includes('d.ts'))]));
  });

  it('honors the host setting and lets the per-call option override it in both directions', () => {
    seedCorpus();
    semantic.replaceForProject(PROJECT_ID);

    settings.setHybridEnabled(PROJECT_ID, true);
    expect(search('invoice')[0].rankingMethod).toBe('hybrid');
    expectLexicalOnly(search('invoice', { semanticRetrieval: 'off' }));

    settings.setHybridEnabled(PROJECT_ID, false);
    expectLexicalOnly(search('invoice'));
    expect(search('invoice', { semanticRetrieval: 'if-available' })[0].rankingMethod).toBe('hybrid');
  });

  it('falls back to lexical-only with no model or a stale model', () => {
    seedCorpus();
    const lexical = search('invoice');

    expect(search('invoice', { semanticRetrieval: 'if-available' })).toEqual(lexical);

    semantic.replaceForProject(PROJECT_ID);
    semantic.markStale(PROJECT_ID);
    expect(search('invoice', { semanticRetrieval: 'if-available' })).toEqual(lexical);
  });

  it('marks the model stale when an index change lands, then serves lexical-only until rebuilt', () => {
    seedCorpus();
    semantic.replaceForProject(PROJECT_ID);
    expect(search('invoice', { semanticRetrieval: 'if-available' })[0].rankingMethod).toBe('hybrid');

    indexDoc('src/e.ts', 'invoice archive');

    expect(semantic.getStatus(PROJECT_ID).state).toBe('stale');
    expectLexicalOnly(search('invoice', { semanticRetrieval: 'if-available' }));
    semantic.replaceForProject(PROJECT_ID);
    expect(search('invoice', { semanticRetrieval: 'if-available' }).some((result) => result.rankingMethod === 'hybrid')).toBe(true);
  });

  it('never changes a clear top-one and never upgrades confidence', () => {
    seedCorpus();
    semantic.replaceForProject(PROJECT_ID);

    const lexical = search('invoice statement');
    const hybrid = search('invoice statement', { semanticRetrieval: 'if-available' });

    expect(lexical[0]).toMatchObject({ title: expect.stringContaining('d.ts'), searchConfidence: 'clear' });
    expect(hybrid).toEqual(lexical);
    expectLexicalOnly(hybrid);
  });

  it('rescues a vocabulary mismatch with a span-backed neighbor candidate when lexical has no hit', () => {
    const ids = seedCorpus();
    semantic.replaceForProject(PROJECT_ID);
    db.prepare('DELETE FROM knowledge_sources WHERE id IN (?, ?, ?)').run(ids.a, ids.b, ids.c);
    expect(search('invoice')).toEqual([]);

    const hybrid = search('invoice', { semanticRetrieval: 'if-available' });

    expect(hybrid).toHaveLength(1);
    expect(hybrid[0]).toMatchObject({
      title: expect.stringContaining('d.ts'),
      rankingMethod: 'hybrid',
      expandedByNeighbor: true,
      semanticReordered: true,
      searchConfidence: 'ambiguous',
      ambiguityReason: 'insufficient_intent',
    });
    expect(hybrid[0].citations[0].span).not.toBeNull();
  });

  it('rescues past a weak ambiguous lexical pool but keeps metadata-only results below span-backed ones', () => {
    indexDoc('src/invoice-one.ts', 'unrelated widget');
    indexDoc('src/invoice-two.ts', 'unrelated gadget');
    indexDoc('src/e.ts', 'billing ledger billing statement');
    const ids = seedCorpus();
    semantic.replaceForProject(PROJECT_ID);
    db.prepare('DELETE FROM knowledge_sources WHERE id IN (?, ?, ?)').run(ids.a, ids.b, ids.c);

    const hybrid = search('invoice', { semanticRetrieval: 'if-available' });

    const expanded = hybrid.find((result) => result.expandedByNeighbor);
    expect(expanded?.title).toBe('src/e.ts');
    expect(hybrid[0].title).toBe(expanded?.title);
    expect(hybrid[0].citations[0].span).not.toBeNull();
    expect(hybrid[0]).toMatchObject({ searchConfidence: 'ambiguous', ambiguityReason: 'insufficient_intent' });
    const metadataOnly = hybrid.filter((result) => result.title.includes('invoice-'));
    expect(metadataOnly).toHaveLength(2);
    expect(hybrid.indexOf(metadataOnly[0])).toBeGreaterThan(0);
  });

  it('bounds neighbor expansion candidates and only returns span-backed evidence', () => {
    const ids = seedCorpus();
    const pairs = Array.from({ length: 30 }, (_, index) => indexDoc(`src/pair${String(index).padStart(2, '0')}.ts`, `invoice billing ${index}`));
    for (let index = 0; index < 60; index += 1) indexDoc(`src/filler${String(index).padStart(2, '0')}.ts`, `billing filler ${index}`);
    semantic.replaceForProject(PROJECT_ID);
    const doomed = [...pairs, ids.a, ids.b, ids.c];
    for (const id of doomed) db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);

    const hybrid = search('invoice', { semanticRetrieval: 'if-available' });

    expect(hybrid.length).toBeGreaterThan(0);
    expect(hybrid.length).toBeLessThanOrEqual(MAX_EXPANSION_CANDIDATES);
    expect(hybrid.every((result) => result.expandedByNeighbor === true && result.citations[0].span !== null)).toBe(true);
  });

  it('isolates projects: another project cannot supply neighbors, vectors, or candidates', () => {
    seedCorpus(OTHER_PROJECT_ID);
    const ids = seedCorpus();
    semantic.replaceForProject(OTHER_PROJECT_ID);
    db.prepare('DELETE FROM knowledge_sources WHERE id IN (?, ?, ?)').run(ids.a, ids.b, ids.c);

    expect(search('invoice', { semanticRetrieval: 'if-available' })).toEqual([]);
  });

  it('falls back to lexical results with a diagnostic when the semantic layer fails', () => {
    seedCorpus();
    semantic.replaceForProject(PROJECT_ID);
    const lexical = search('invoice');
    db.exec('DROP TABLE knowledge_search_semantic_neighbors');
    const diagnostics: KnowledgeSearchDiagnostic[] = [];

    const results = search('invoice', { semanticRetrieval: 'if-available', onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });

    expect(results).toEqual(lexical);
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'semantic_retrieval_unavailable' })]);
  });

  it('keeps the semantic order in sources-only reads', () => {
    seedCorpus();
    semantic.replaceForProject(PROJECT_ID);

    const sourcesOnly = search('invoice', { mode: 'read-sources-only', semanticRetrieval: 'if-available' });

    expect(sourcesOnly[0].rankingMethod).toBe('hybrid');
    expect(titles(sourcesOnly)).toEqual(titles(search('invoice', { semanticRetrieval: 'if-available' })));
  });

  it('never stores secrets or raw text in the semantic tables', () => {
    const secret = 'sk-live-ABCDEF1234567890ABCDEF12';
    indexDoc('src/a.ts', `invoice billing token ${secret}`);
    indexDoc('src/b.ts', `invoice billing password=hunter2hunter2 ${secret}`);
    semantic.replaceForProject(PROJECT_ID);

    const dump = JSON.stringify([
      db.prepare('SELECT * FROM knowledge_search_semantic_models').all(),
      db.prepare('SELECT * FROM knowledge_search_semantic_vectors').all(),
      db.prepare('SELECT * FROM knowledge_search_semantic_neighbors').all(),
    ]);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('hunter2');
  });
});
