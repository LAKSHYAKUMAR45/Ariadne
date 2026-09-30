import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import {
  KnowledgeAnalysisCoverageStore,
  MAX_DEFERRED_RELATIONSHIPS_PER_SOURCE,
} from '../../src/knowledge/KnowledgeAnalysisCoverageStore.js';
import type { AnalyzerCoverageSummary } from '../../src/knowledge/analyzers/AnalyzerCoverage.js';
import type { DeferredRelationshipCandidate } from '../../src/knowledge/KnowledgeExtraction.js';

const NOW = '2026-09-29T00:00:00.000Z';
const SPAN = { startOffset: 0, endOffset: 5, startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 };

function summary(overrides: Partial<AnalyzerCoverageSummary> = {}): AnalyzerCoverageSummary {
  return {
    status: 'supported',
    analyzerId: 'python-lezer',
    analyzerVersion: '1.0.0',
    generatedCode: false,
    generatedReason: null,
    supportedFeatures: ['deterministic_extraction'],
    missingFeatures: [],
    warnings: [],
    ...overrides,
  };
}

function candidate(id: string, overrides: Partial<DeferredRelationshipCandidate> = {}): DeferredRelationshipCandidate {
  return {
    id,
    type: 'calls',
    sourceSymbolId: 'symbol_a',
    targetReference: 'getattr(obj, name)',
    resolutionKind: 'dynamic_runtime',
    evidenceKind: 'syntax',
    confidence: 0.4,
    span: SPAN,
    metadata: { reason: 'dynamic dispatch' },
    ...overrides,
  };
}

describe('KnowledgeAnalysisCoverageStore', () => {
  let db: Database.Database;
  let store: KnowledgeAnalysisCoverageStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_a', 'ws-a', 'A', 'active', ?, ?), ('project_b', 'ws-b', 'B', 'active', ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);
    for (const projectId of ['project_a', 'project_b']) {
      db.prepare(
        `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, status, created_at, updated_at)
         VALUES (?, ?, 'file', 'a.py', 'active', ?, ?)`,
      ).run(`source_${projectId}`, projectId, NOW, NOW);
      db.prepare(
        `INSERT INTO knowledge_source_versions
         (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
         VALUES (?, ?, ?, 1, 'hash', 'sources/a.txt', 10, ?)`,
      ).run(`version_${projectId}`, projectId, `source_${projectId}`, NOW);
    }
    store = new KnowledgeAnalysisCoverageStore(db, { now: () => NOW });
  });

  afterEach(() => db.close());

  it('upserts exactly one coverage row per source version and preserves identity on reanalysis', () => {
    const first = store.upsert({ projectId: 'project_a', sourceVersionId: 'version_project_a', coverage: summary() });
    const second = store.upsert({
      projectId: 'project_a',
      sourceVersionId: 'version_project_a',
      coverage: summary({ status: 'partial', missingFeatures: ['dynamic_relationships'] }),
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second).toMatchObject({ status: 'partial', missingFeatures: ['dynamic_relationships'] });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_analysis_coverage').get()).toEqual({ count: 1 });
    expect(store.get('project_a', 'version_project_a')).toEqual(second);
  });

  it('returns null for legacy sources without a coverage row and is project scoped', () => {
    store.upsert({ projectId: 'project_a', sourceVersionId: 'version_project_a', coverage: summary() });
    expect(store.get('project_b', 'version_project_b')).toBeNull();
    expect(store.get('project_b', 'version_project_a')).toBeNull();
  });

  it('rejects a source version from another project', () => {
    expect(() =>
      store.upsert({ projectId: 'project_b', sourceVersionId: 'version_project_a', coverage: summary() }),
    ).toThrow(/source version/i);
  });

  it('persists unsupported coverage with reason, bounded redacted diagnostics, and no source content', () => {
    store.upsert({
      projectId: 'project_a',
      sourceVersionId: 'version_project_a',
      coverage: summary({
        status: 'unsupported',
        analyzerId: null,
        analyzerVersion: null,
        unsupportedReason: 'no_analyzer',
        supportedFeatures: [],
        warnings: [
          { code: 'coverage_no_analyzer', message: `token=sk-abcdefghijklmnopqrstuvwxyz0123456789 ${'z'.repeat(2000)}`, severity: 'warning' },
        ],
      }),
    });
    const row = db.prepare('SELECT * FROM knowledge_analysis_coverage').get() as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'unsupported', unsupported_reason: 'no_analyzer', analyzer_id: null, generated_code: 0 });
    expect(String(row.diagnostics_json)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(String(row.diagnostics_json).length).toBeLessThan(1000);
  });

  it('rejects an invalid status and cascades when the source version is deleted', () => {
    expect(() =>
      store.upsert({ projectId: 'project_a', sourceVersionId: 'version_project_a', coverage: summary({ status: 'bogus' as never }) }),
    ).toThrow();
    store.upsert({ projectId: 'project_a', sourceVersionId: 'version_project_a', coverage: summary() });
    store.replaceDeferredRelationships({ projectId: 'project_a', sourceVersionId: 'version_project_a', candidates: [candidate('c1')] });
    db.prepare(`DELETE FROM knowledge_source_versions WHERE id = 'version_project_a'`).run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_analysis_coverage').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_deferred_relationships').get()).toEqual({ count: 0 });
  });

  describe('deferred relationships', () => {
    it('persists candidates with a span row and no graph nodes or edges', () => {
      const result = store.replaceDeferredRelationships({
        projectId: 'project_a',
        sourceVersionId: 'version_project_a',
        candidates: [candidate('c1'), candidate('c2', { resolutionKind: 'generated_stub', evidenceKind: 'generated_marker', span: null })],
      });

      expect(result).toEqual({ stored: 2, dropped: 0 });
      const rows = store.listDeferredRelationships('project_a', 'version_project_a');
      expect(rows.map((row) => row.resolutionKind)).toEqual(['dynamic_runtime', 'generated_stub']);
      expect(rows[0]).toMatchObject({
        relationshipType: 'calls',
        sourceSymbolId: 'symbol_a',
        targetSymbolId: null,
        targetReference: 'getattr(obj, name)',
        evidenceKind: 'syntax',
        confidence: 0.4,
        metadata: { reason: 'dynamic dispatch' },
      });
      expect(rows[0]!.spanId).not.toBeNull();
      expect(rows[1]!.spanId).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_source_spans').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_edges').get()).toEqual({ count: 0 });
    });

    it('replaces prior candidates for the source version instead of accumulating', () => {
      const input = { projectId: 'project_a', sourceVersionId: 'version_project_a' };
      store.replaceDeferredRelationships({ ...input, candidates: [candidate('c1'), candidate('c2')] });
      store.replaceDeferredRelationships({ ...input, candidates: [candidate('c3')] });
      expect(store.listDeferredRelationships('project_a', 'version_project_a').map((row) => row.targetReference)).toEqual([
        'getattr(obj, name)',
      ]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_deferred_relationships').get()).toEqual({ count: 1 });
    });

    it('bounds the candidate count, deduplicates ids, and drops invalid candidates', () => {
      const many = Array.from({ length: MAX_DEFERRED_RELATIONSHIPS_PER_SOURCE + 25 }, (_, index) => candidate(`c${index}`));
      const result = store.replaceDeferredRelationships({
        projectId: 'project_a',
        sourceVersionId: 'version_project_a',
        candidates: [
          ...many,
          candidate('c0'),
          candidate('bad_kind', { resolutionKind: 'nope' as never }),
          candidate('bad_conf', { confidence: 2 }),
          candidate('no_target', { targetReference: null, targetSymbolId: null }),
        ],
      });
      expect(result.stored).toBe(MAX_DEFERRED_RELATIONSHIPS_PER_SOURCE);
      expect(result.dropped).toBe(25 + 1 + 3);
      expect(store.listDeferredRelationships('project_a', 'version_project_a')).toHaveLength(MAX_DEFERRED_RELATIONSHIPS_PER_SOURCE);
    });

    it('sanitizes metadata and bounds the target reference', () => {
      store.replaceDeferredRelationships({
        projectId: 'project_a',
        sourceVersionId: 'version_project_a',
        candidates: [
          candidate('c1', {
            targetReference: `password=hunter2hunter2 ${'t'.repeat(2000)}`,
            metadata: { reason: 'ok', unknownKey: 'dropped', detail: `sk-abcdefghijklmnopqrstuvwxyz0123456789` },
          }),
        ],
      });
      const [row] = store.listDeferredRelationships('project_a', 'version_project_a');
      expect(row!.targetReference!.length).toBeLessThanOrEqual(512);
      expect(row!.targetReference).not.toContain('hunter2hunter2');
      expect(row!.metadata).not.toHaveProperty('unknownKey');
      expect(JSON.stringify(row!.metadata)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
    });

    it('rejects a source version outside the project and rolls back on failure', () => {
      const input = { projectId: 'project_a', sourceVersionId: 'version_project_a' };
      store.replaceDeferredRelationships({ ...input, candidates: [candidate('c1')] });
      expect(() =>
        store.replaceDeferredRelationships({ projectId: 'project_b', sourceVersionId: 'version_project_a', candidates: [candidate('c1')] }),
      ).toThrow(/source version/i);
      expect(store.listDeferredRelationships('project_a', 'version_project_a')).toHaveLength(1);
    });
  });

  it('summarizes coverage counts per project without content', () => {
    store.upsert({ projectId: 'project_a', sourceVersionId: 'version_project_a', coverage: summary({ status: 'partial' }) });
    store.replaceDeferredRelationships({ projectId: 'project_a', sourceVersionId: 'version_project_a', candidates: [candidate('c1')] });
    expect(store.summarize('project_a')).toEqual({
      supported: 0,
      partial: 1,
      unsupported: 0,
      failed: 0,
      legacyUnknown: 0,
      deferredRelationships: 1,
    });
    expect(store.summarize('project_b')).toMatchObject({ legacyUnknown: 1, partial: 0 });
  });
  it('appends deferred candidates without replacing analyzer candidates, deduplicating and honoring the limit', () => {
    store.replaceDeferredRelationships({ projectId: 'project_a', sourceVersionId: 'version_project_a', candidates: [candidate('analyzer_1')] });
    const first = store.appendDeferredRelationships({
      projectId: 'project_a',
      sourceVersionId: 'version_project_a',
      candidates: [candidate('appended_1', { resolutionKind: 'ambiguous_alias' }), candidate('analyzer_1')],
    });
    expect(first).toEqual({ stored: 1, dropped: 0 });
    const repeated = store.appendDeferredRelationships({
      projectId: 'project_a',
      sourceVersionId: 'version_project_a',
      candidates: [candidate('appended_1', { resolutionKind: 'ambiguous_alias' })],
    });
    expect(repeated).toEqual({ stored: 0, dropped: 0 });
    expect(store.listDeferredRelationships('project_a', 'version_project_a')).toHaveLength(2);

    const overflow = store.appendDeferredRelationships({
      projectId: 'project_a',
      sourceVersionId: 'version_project_a',
      candidates: Array.from({ length: MAX_DEFERRED_RELATIONSHIPS_PER_SOURCE }, (_, index) => candidate(`extra_${index}`)),
    });
    expect(overflow.stored).toBe(MAX_DEFERRED_RELATIONSHIPS_PER_SOURCE - 2);
    expect(overflow.dropped).toBe(2);
    expect(() =>
      store.appendDeferredRelationships({ projectId: 'project_b', sourceVersionId: 'version_project_a', candidates: [candidate('x')] }),
    ).toThrow(/not found in project/);
  });
});
