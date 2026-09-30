import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import type { DeterministicExtraction } from '../../src/knowledge/KnowledgeExtraction.js';
import { KnowledgeExtractionStore } from '../../src/knowledge/KnowledgeExtractionStore.js';
import {
  KNOWLEDGE_SEMANTIC_MODEL_VERSION,
  KnowledgeLocalSemanticIndex,
  MAX_EXPANSION_TERMS,
  MAX_NEIGHBORS_PER_TERM,
  SEMANTIC_VECTOR_DIMENSION,
  semanticModelStorageVersion,
} from '../../src/knowledge/KnowledgeLocalSemanticIndex.js';
import { KnowledgeSearchIndex, setKnowledgeSearchIndexChangedHook } from '../../src/knowledge/KnowledgeSearchIndex.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';

const PROJECT_ID = 'project_1';
const OTHER_PROJECT_ID = 'project_2';
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

describe('KnowledgeLocalSemanticIndex', () => {
  let db: Database.Database;
  let sources: KnowledgeSourceStore;
  let extractions: KnowledgeExtractionStore;
  let searchIndex: KnowledgeSearchIndex;
  let semantic: KnowledgeLocalSemanticIndex;
  let clock: number;

  const tick = () => new Date(Date.parse(NOW) + clock++ * 1000).toISOString();

  beforeEach(() => {
    clock = 0;
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
    semantic = new KnowledgeLocalSemanticIndex(db, { now: tick });
  });

  afterEach(() => {
    setKnowledgeSearchIndexChangedHook(null);
    db.close();
  });

  function indexDoc(path: string, doc: DocSpec, projectId = PROJECT_ID) {
    const source = sources.register({ projectId, kind: 'file', path, content: `content of ${path}`, format: 'markdown' });
    const versions = sources.listVersions(projectId, source.id);
    const versionId = versions[versions.length - 1].id;
    const saved = extractions.save({ projectId, extraction: buildExtraction(versionId, doc) });
    searchIndex.replaceForSourceVersion({ projectId, sourceVersionId: versionId, coverage: 'extraction', extractionId: saved.id });
    return { source, versionId };
  }

  function seedBillingCorpus(projectId = PROJECT_ID) {
    const one = indexDoc(
      'src/alpha.ts',
      { title: 'Invoice billing', sections: [{ title: 'Invoice billing', text: 'invoice billing statements' }] },
      projectId,
    );
    const two = indexDoc(
      'src/beta.ts',
      { title: 'Invoice billing ledger', sections: [{ title: 'Ledger', text: 'invoice billing ledger entries' }] },
      projectId,
    );
    const target = indexDoc(
      'src/gamma.ts',
      { title: 'Statement generator', sections: [{ title: 'Generator', text: 'generate billing statement for customers' }] },
      projectId,
    );
    return { one, two, target };
  }

  function neighborRows(projectId = PROJECT_ID) {
    return db
      .prepare(
        `SELECT term, neighbor_term, neighbor_rank, weight FROM knowledge_search_semantic_neighbors
         WHERE project_id = ? ORDER BY term, neighbor_rank`,
      )
      .all(projectId) as Array<{ term: string; neighbor_term: string; neighbor_rank: number; weight: number }>;
  }

  function vectorRows(projectId = PROJECT_ID) {
    return db
      .prepare(
        `SELECT source_version_id, vector_json, norm FROM knowledge_search_semantic_vectors
         WHERE project_id = ? ORDER BY source_version_id`,
      )
      .all(projectId) as Array<{ source_version_id: string; vector_json: string; norm: number }>;
  }

  function modelRows(projectId = PROJECT_ID) {
    return db
      .prepare('SELECT id, status, lease_expires_at, model_version, source_count FROM knowledge_search_semantic_models WHERE project_id = ? ORDER BY created_at, id')
      .all(projectId) as Array<{ id: string; status: string; lease_expires_at: string | null; model_version: number; source_count: number }>;
  }

  it('reports an absent model before any build and never builds implicitly', () => {
    seedBillingCorpus();

    expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ projectId: PROJECT_ID, state: 'absent', usable: false, modelId: null });
    expect(semantic.expandQueryTerms({ projectId: PROJECT_ID, terms: ['invoice'] })).toEqual({ terms: [] });
    expect(semantic.rankCandidates({ projectId: PROJECT_ID, queryTerms: ['invoice'], sourceVersionIds: ['x'] })).toEqual([]);
    expect(modelRows()).toEqual([]);
  });

  it('builds an active model with fixed-dimension hashed vectors and a matching norm per source version', () => {
    const { one, two, target } = seedBillingCorpus();
    indexDoc('src/foreign.ts', { title: 'Foreign', sections: [{ title: 'Foreign', text: 'foreign invoice billing' }] }, OTHER_PROJECT_ID);

    const report = semantic.replaceForProject(PROJECT_ID);

    expect(report).toMatchObject({ projectId: PROJECT_ID, outcome: 'activated', sourceCount: 3, vectorCount: 3 });
    expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ state: 'active', usable: true, sourceCount: 3, vectorCount: 3, modelId: report.modelId });
    expect(modelRows()).toEqual([
      expect.objectContaining({ id: report.modelId, status: 'active', lease_expires_at: null, model_version: semanticModelStorageVersion() }),
    ]);
    const rows = vectorRows();
    expect(rows.map((row) => row.source_version_id).sort()).toEqual([one.versionId, two.versionId, target.versionId].sort());
    for (const row of rows) {
      const vector = JSON.parse(row.vector_json) as number[];
      expect(vector).toHaveLength(SEMANTIC_VECTOR_DIMENSION);
      expect(vector.every((value) => Number.isFinite(value))).toBe(true);
      expect(row.norm).toBeCloseTo(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)), 9);
      expect(row.norm).toBeGreaterThan(0);
      expect(row.vector_json).not.toMatch(/[A-Za-z]{3}/);
    }
    expect(vectorRows(OTHER_PROJECT_ID)).toEqual([]);
    expect(KNOWLEDGE_SEMANTIC_MODEL_VERSION).toBeGreaterThan(0);
  });

  it('learns bounded co-occurrence neighbors only from terms supported by at least two sources', () => {
    seedBillingCorpus();
    semantic.replaceForProject(PROJECT_ID);

    const invoice = neighborRows().filter((row) => row.term === 'invoice');
    expect(invoice.map((row) => row.neighbor_term)).toContain('billing');
    expect(invoice[0]).toMatchObject({ neighbor_term: 'billing', neighbor_rank: 0 });
    expect(invoice.every((row) => row.weight > 0 && row.weight <= 1)).toBe(true);
    expect(neighborRows().some((row) => row.term === 'generate')).toBe(false);
    expect(neighborRows().some((row) => row.term === row.neighbor_term)).toBe(false);
  });

  it('caps neighbors per term and neighbor terms per project', () => {
    const words = Array.from({ length: 12 }, (_, index) => `partner${String.fromCharCode(97 + index)}${String.fromCharCode(97 + index)}`);
    for (let doc = 0; doc < 3; doc += 1) {
      indexDoc(`src/doc${doc}.ts`, { title: `Hub ${doc}`, sections: [{ title: 'Hub', text: `hubterm ${words.join(' ')}` }] });
    }
    const capped = new KnowledgeLocalSemanticIndex(db, { now: tick, limits: { maxNeighborTerms: 4 } });

    capped.replaceForProject(PROJECT_ID);

    const rows = neighborRows();
    const perTerm = new Map<string, number>();
    for (const row of rows) perTerm.set(row.term, (perTerm.get(row.term) ?? 0) + 1);
    expect(Math.max(...perTerm.values())).toBeLessThanOrEqual(MAX_NEIGHBORS_PER_TERM);
    expect(perTerm.size).toBeLessThanOrEqual(4);
    expect(new Set(rows.map((row) => `${row.term}\0${row.neighbor_term}`)).size).toBe(rows.length);
  });

  it('produces byte-identical vectors and neighbors when the same indexed state is rebuilt', () => {
    seedBillingCorpus();
    const first = semantic.replaceForProject(PROJECT_ID);
    const firstVectors = vectorRows();
    const firstNeighbors = neighborRows();

    const second = semantic.replaceForProject(PROJECT_ID);

    expect(second.modelId).not.toBe(first.modelId);
    expect(vectorRows()).toEqual(firstVectors);
    expect(neighborRows()).toEqual(firstNeighbors);
    expect(modelRows().map((row) => row.status)).toEqual(['active']);
  });

  it('expands query terms through indexed neighbors within fixed caps and excludes the query terms', () => {
    seedBillingCorpus();
    semantic.replaceForProject(PROJECT_ID);

    const expansion = semantic.expandQueryTerms({ projectId: PROJECT_ID, terms: ['invoice'] });

    expect(expansion.terms[0]).toMatchObject({ term: 'billing', fromTerm: 'invoice' });
    expect(expansion.terms[0].weight).toBeGreaterThan(0);
    expect(expansion.terms.length).toBeLessThanOrEqual(MAX_EXPANSION_TERMS);
    expect(semantic.expandQueryTerms({ projectId: PROJECT_ID, terms: ['invoice', 'billing'] }).terms.map((entry) => entry.term)).not.toEqual(
      expect.arrayContaining(['billing']),
    );
    expect(semantic.expandQueryTerms({ projectId: PROJECT_ID, terms: ['unknownword'] })).toEqual({ terms: [] });
    expect(semantic.expandQueryTerms({ projectId: OTHER_PROJECT_ID, terms: ['invoice'] })).toEqual({ terms: [] });
  });

  it('caps the expansion term count regardless of how many neighbors exist', () => {
    const hubs = ['crimson', 'emerald', 'sapphire', 'topaz'];
    for (let doc = 0; doc < 3; doc += 1) {
      indexDoc(`src/many${doc}.ts`, {
        title: `Many ${doc}`,
        sections: hubs.map((hub) => ({
          title: hub,
          text: `${hub} ${[1, 2, 3, 4, 5].map((n) => `zz${hub}${n}`).join(' ')}`,
        })),
      });
    }
    semantic.replaceForProject(PROJECT_ID);

    const expansion = semantic.expandQueryTerms({ projectId: PROJECT_ID, terms: hubs });

    expect(expansion.terms.length).toBe(MAX_EXPANSION_TERMS);
    expect(new Set(expansion.terms.map((entry) => entry.term)).size).toBe(expansion.terms.length);
    expect(expansion.terms.every((entry) => hubs.includes(entry.fromTerm))).toBe(true);
  });

  it('drops secret-like, high-entropy, and placeholder tokens before counting', () => {
    seedBillingCorpus();
    db.prepare(`UPDATE knowledge_search_index_fields SET field_text = ? WHERE field_text = 'invoice billing statements'`).run(
      'invoice billing q9x7k2m4z8w1v3n5b6c0 password=hunter2topsecret AKIAABCDEFGHIJKLMNOP deadbeefdeadbeefdeadbeef redacted',
    );
    db.prepare(`UPDATE knowledge_search_index_fields SET field_text = ? WHERE field_text = 'invoice billing ledger entries'`).run(
      'invoice billing q9x7k2m4z8w1v3n5b6c0 password=hunter2topsecret AKIAABCDEFGHIJKLMNOP deadbeefdeadbeefdeadbeef redacted',
    );

    semantic.replaceForProject(PROJECT_ID);

    const stored = JSON.stringify([...neighborRows(), ...vectorRows(), ...modelRows()]).toLowerCase();
    for (const forbidden of ['q9x7k2m4z8w1v3n5b6c0', 'hunter2topsecret', 'akiaabcdefghijklmnop', 'deadbeef', 'redacted']) {
      expect(stored).not.toContain(forbidden);
    }
    expect(neighborRows().some((row) => row.term === 'invoice' && row.neighbor_term === 'billing')).toBe(true);
  });

  it('scores only the supplied candidates of the project and never reads another project', () => {
    const { one, target } = seedBillingCorpus();
    const foreign = indexDoc('src/foreign.ts', { title: 'Foreign', sections: [{ title: 'Foreign', text: 'invoice billing foreign' }] }, OTHER_PROJECT_ID);
    semantic.replaceForProject(PROJECT_ID);
    semantic.replaceForProject(OTHER_PROJECT_ID);

    const scores = semantic.rankCandidates({
      projectId: PROJECT_ID,
      queryTerms: ['invoice', 'billing'],
      sourceVersionIds: [one.versionId, target.versionId, foreign.versionId, 'missing_version'],
    });

    expect(scores.map((entry) => entry.sourceVersionId).sort()).toEqual([one.versionId, target.versionId].sort());
    expect(scores.every((entry) => entry.score >= 0 && entry.score <= 1.000001)).toBe(true);
    expect(scores[0].sourceVersionId).toBe(one.versionId);
    expect(scores).toEqual([...scores].sort((a, b) => b.score - a.score || a.sourceVersionId.localeCompare(b.sourceVersionId)));
  });

  it('lets expansion terms raise the score of a source that only contains the neighbor vocabulary', () => {
    const { target } = seedBillingCorpus();
    semantic.replaceForProject(PROJECT_ID);
    const plain = semantic.rankCandidates({ projectId: PROJECT_ID, queryTerms: ['invoice'], sourceVersionIds: [target.versionId] });
    const expanded = semantic.rankCandidates({
      projectId: PROJECT_ID,
      queryTerms: ['invoice'],
      expansionTerms: semantic.expandQueryTerms({ projectId: PROJECT_ID, terms: ['invoice'] }).terms,
      sourceVersionIds: [target.versionId],
    });

    expect(expanded[0].score).toBeGreaterThan(plain[0]?.score ?? 0);
  });

  it('marks the active model stale in the index write transaction and stops using it', () => {
    const { one, target } = seedBillingCorpus();
    const report = semantic.replaceForProject(PROJECT_ID);
    const saved = extractions.save({
      projectId: PROJECT_ID,
      extraction: buildExtraction(target.versionId, { title: 'Changed', sections: [{ title: 'Changed', text: 'changed text' }] }),
    });

    searchIndex.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: target.versionId, coverage: 'extraction', extractionId: saved.id });

    expect(modelRows()).toEqual([expect.objectContaining({ id: report.modelId, status: 'stale' })]);
    expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ state: 'stale', usable: false });
    expect(semantic.expandQueryTerms({ projectId: PROJECT_ID, terms: ['invoice'] })).toEqual({ terms: [] });
    expect(semantic.rankCandidates({ projectId: PROJECT_ID, queryTerms: ['invoice'], sourceVersionIds: [one.versionId] })).toEqual([]);

    semantic.replaceForProject(PROJECT_ID);
    expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ state: 'active', usable: true });
    searchIndex.markSourceStale(PROJECT_ID, one.source.id);
    expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ state: 'stale', usable: false });
  });

  it('leaves other projects models untouched when a project index changes', () => {
    const { target } = seedBillingCorpus();
    seedBillingCorpus(OTHER_PROJECT_ID);
    semantic.replaceForProject(PROJECT_ID);
    semantic.replaceForProject(OTHER_PROJECT_ID);

    searchIndex.markSourceStale(PROJECT_ID, target.source.id);

    expect(semantic.getStatus(PROJECT_ID).state).toBe('stale');
    expect(semantic.getStatus(OTHER_PROJECT_ID).state).toBe('active');
  });

  it('rolls the invalidation back together with a failed index write', () => {
    const { target } = seedBillingCorpus();
    semantic.replaceForProject(PROJECT_ID);
    setKnowledgeSearchIndexChangedHook(() => {
      throw new Error('hook failed');
    });

    expect(() =>
      searchIndex.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: target.versionId, coverage: 'metadata_only' }),
    ).toThrow('hook failed');

    expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ state: 'active', usable: true });
  });

  it('cascades vectors when a source version is deleted and everything when the project is deleted', () => {
    const { target } = seedBillingCorpus();
    semantic.replaceForProject(PROJECT_ID);

    db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(target.source.id);
    expect(vectorRows()).toHaveLength(2);

    db.prepare('DELETE FROM knowledge_projects WHERE id = ?').run(PROJECT_ID);
    for (const table of ['models', 'vectors', 'neighbors']) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_search_semantic_${table} WHERE project_id = ?`).get(PROJECT_ID)).toEqual({ count: 0 });
    }
  });

  it('treats a model built for another model or search index version as unusable', () => {
    seedBillingCorpus();
    semantic.replaceForProject(PROJECT_ID);

    db.prepare(`UPDATE knowledge_search_semantic_models SET model_version = model_version + 1000`).run();

    expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ state: 'incompatible', usable: false });
    expect(semantic.expandQueryTerms({ projectId: PROJECT_ID, terms: ['invoice'] })).toEqual({ terms: [] });
  });

  describe('rebuild locking', () => {
    function insertBuilding(leaseExpiresAt: string | null, id = 'model_building') {
      db.prepare(
        `INSERT INTO knowledge_search_semantic_models
         (id, project_id, model_version, status, source_count, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'building', 0, ?, ?, ?)`,
      ).run(id, PROJECT_ID, semanticModelStorageVersion(), leaseExpiresAt, '2999-12-31T00:00:00.000Z', NOW);
    }

    it('fails fast while another rebuild holds an unexpired lease and changes nothing', () => {
      seedBillingCorpus();
      const active = semantic.replaceForProject(PROJECT_ID);
      insertBuilding('2999-01-01T00:00:00.000Z');

      expect(() => semantic.replaceForProject(PROJECT_ID)).toThrow(/semantic_rebuild_in_progress/);
      try {
        semantic.replaceForProject(PROJECT_ID);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('semantic_rebuild_in_progress');
      }

      expect(modelRows().map((row) => `${row.id}:${row.status}`)).toEqual([`${active.modelId}:active`, 'model_building:building']);
    });

    it('rejects a concurrent rebuild started from inside a running rebuild', () => {
      seedBillingCorpus();
      let nested: unknown = null;
      const guarded = new KnowledgeLocalSemanticIndex(db, {
        now: tick,
        beforeActivate: () => {
          try {
            semantic.replaceForProject(PROJECT_ID);
          } catch (error) {
            nested = error;
          }
        },
      });

      const report = guarded.replaceForProject(PROJECT_ID);

      expect((nested as { code?: string }).code).toBe('semantic_rebuild_in_progress');
      expect(report.outcome).toBe('activated');
    });

    it('reclaims an expired lease, deleting its partial vectors before building', () => {
      const { one } = seedBillingCorpus();
      insertBuilding('2000-01-01T00:00:00.000Z');
      db.prepare(
        `INSERT INTO knowledge_search_semantic_vectors (id, project_id, model_id, source_version_id, vector_json, norm, created_at)
         VALUES ('partial', ?, 'model_building', ?, '[1]', 1, ?)`,
      ).run(PROJECT_ID, one.versionId, NOW);

      const report = semantic.replaceForProject(PROJECT_ID);

      expect(report.outcome).toBe('activated');
      expect(modelRows().map((row) => row.status)).toEqual(['active']);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_search_semantic_vectors WHERE id = 'partial'`).get()).toEqual({ count: 0 });
    });

    it('reclaims a building row that was invalidated by an index change (null lease)', () => {
      seedBillingCorpus();
      insertBuilding(null);

      expect(semantic.replaceForProject(PROJECT_ID).outcome).toBe('activated');
      expect(modelRows().map((row) => row.status)).toEqual(['active']);
    });

    it('swaps atomically: the previous active model is deleted with its rows and readers see one active model', () => {
      seedBillingCorpus();
      const previous = semantic.replaceForProject(PROJECT_ID);
      const seenDuringBuild: string[][] = [];
      const observing = new KnowledgeLocalSemanticIndex(db, {
        now: tick,
        beforeActivate: () => {
          seenDuringBuild.push(modelRows().map((row) => row.status));
          expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ state: 'active', modelId: previous.modelId, usable: true });
        },
      });

      const next = observing.replaceForProject(PROJECT_ID);

      expect(seenDuringBuild).toEqual([['active', 'building']]);
      expect(next.modelId).not.toBe(previous.modelId);
      expect(modelRows().map((row) => `${row.id}:${row.status}`)).toEqual([`${next.modelId}:active`]);
      const owners = db.prepare('SELECT DISTINCT model_id FROM knowledge_search_semantic_vectors').all();
      expect(owners).toEqual([{ model_id: next.modelId }]);
      expect(new Set(neighborRows().map((row) => row.term)).size).toBeGreaterThan(0);
      expect(db.prepare('SELECT DISTINCT model_id FROM knowledge_search_semantic_neighbors').all()).toEqual([{ model_id: next.modelId }]);
    });

    it('leaves the new model stale and reports superseded_during_build when the index changed mid-build', () => {
      const { target } = seedBillingCorpus();
      const previous = semantic.replaceForProject(PROJECT_ID);
      const racing = new KnowledgeLocalSemanticIndex(db, {
        now: tick,
        beforeActivate: () => searchIndex.markSourceStale(PROJECT_ID, target.source.id),
      });

      const report = racing.replaceForProject(PROJECT_ID);

      expect(report.outcome).toBe('superseded_during_build');
      expect(modelRows().map((row) => `${row.id}:${row.status}`)).toEqual([`${report.modelId}:stale`]);
      expect(modelRows()[0].id).not.toBe(previous.modelId);
      expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ state: 'stale', usable: false });
    });

    it('keeps the previous active model and leaves no building row when a rebuild fails', () => {
      seedBillingCorpus();
      const previous = semantic.replaceForProject(PROJECT_ID);
      const failing = new KnowledgeLocalSemanticIndex(db, {
        now: tick,
        beforeActivate: () => {
          throw new Error('activation failed');
        },
      });

      expect(() => failing.replaceForProject(PROJECT_ID)).toThrow('activation failed');

      expect(modelRows().map((row) => `${row.id}:${row.status}`)).toEqual([`${previous.modelId}:active`]);
      expect(semantic.getStatus(PROJECT_ID)).toMatchObject({ state: 'active', usable: true });
    });

    it('serializes builds per project, not across projects', () => {
      seedBillingCorpus();
      seedBillingCorpus(OTHER_PROJECT_ID);
      insertBuilding('2999-01-01T00:00:00.000Z');

      expect(semantic.replaceForProject(OTHER_PROJECT_ID).outcome).toBe('activated');
    });
  });

  it('bounds the number of sources considered by a build', () => {
    for (let doc = 0; doc < 5; doc += 1) {
      indexDoc(`src/bulk${doc}.ts`, { title: `Bulk ${doc}`, sections: [{ title: 'Bulk', text: 'bulk shared vocabulary' }] });
    }
    const limited = new KnowledgeLocalSemanticIndex(db, { now: tick, limits: { maxModelSources: 3 } });

    const report = limited.replaceForProject(PROJECT_ID);

    expect(report).toMatchObject({ sourceCount: 3, vectorCount: 3, skippedSources: 2 });
    expect(vectorRows()).toHaveLength(3);
  });

  it('rejects empty project ids', () => {
    expect(() => semantic.replaceForProject(' ')).toThrow(/project ID/i);
    expect(() => semantic.getStatus('')).toThrow(/project ID/i);
  });
});
