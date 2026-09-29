import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { KnowledgeAnalysisCoverageStore } from '../../src/knowledge/KnowledgeAnalysisCoverageStore.js';
import {
  KnowledgeGraphReporter,
  MAX_GRAPH_AMBIGUITIES_PER_REPORT,
} from '../../src/knowledge/KnowledgeGraphReporting.js';
import type { AnalyzerCoverageSummary } from '../../src/knowledge/analyzers/AnalyzerCoverage.js';
import type { DeferredRelationshipCandidate } from '../../src/knowledge/KnowledgeExtraction.js';
import type { KnowledgeGraphNodeId } from '../../src/knowledge/KnowledgeTypes.js';
import { KnowledgeGraph } from '../../src/knowledge/graph/KnowledgeGraph.js';

const T0 = '2026-09-29T00:00:00.000Z';
const SPAN = { startOffset: 0, endOffset: 5, startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 };

function coverage(overrides: Partial<AnalyzerCoverageSummary> = {}): AnalyzerCoverageSummary {
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

function deferred(id: string, overrides: Partial<DeferredRelationshipCandidate> = {}): DeferredRelationshipCandidate {
  return {
    id,
    type: 'calls',
    sourceSymbolId: 'sym_a',
    targetReference: 'secret_target_reference_text',
    resolutionKind: 'dynamic_runtime',
    evidenceKind: 'syntax',
    confidence: 0.4,
    span: SPAN,
    metadata: { reason: 'dynamic dispatch' },
    ...overrides,
  };
}

describe('KnowledgeGraphReporter', () => {
  let db: Database.Database;
  let graph: KnowledgeGraph;
  let coverageStore: KnowledgeAnalysisCoverageStore;
  let clock: number;
  let reporter: KnowledgeGraphReporter;

  const now = () => new Date(Date.parse(T0) + clock++ * 1000).toISOString();

  function addSource(projectId: string, name: string, options: { status?: string; versions?: number } = {}): string[] {
    db.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, status, created_at, updated_at)
       VALUES (?, ?, 'file', ?, ?, ?, ?)`,
    ).run(`source_${name}`, projectId, `${name}.py`, options.status ?? 'active', T0, T0);
    const versionIds: string[] = [];
    for (let number = 1; number <= (options.versions ?? 1); number += 1) {
      const id = `version_${name}_${number}`;
      db.prepare(
        `INSERT INTO knowledge_source_versions
         (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
         VALUES (?, ?, ?, ?, ?, 'sources/a.txt', 10, ?)`,
      ).run(id, projectId, `source_${name}`, number, `hash_${name}_${number}`, T0);
      versionIds.push(id);
    }
    return versionIds;
  }

  function addNode(projectId: string, id: string, label: string, versionId: string, symbolId = id): KnowledgeGraphNodeId {
    return graph.upsertGraphNode({
      id: id as KnowledgeGraphNodeId,
      projectId,
      nodeType: 'function',
      label,
      qualifiedName: label,
      sourceKind: 'deterministic_symbol',
      sourceId: `${versionId}:${symbolId}`,
      sourceVersionId: versionId,
      span: SPAN,
    }).id;
  }

  function addEdge(
    projectId: string,
    sourceNodeId: KnowledgeGraphNodeId,
    targetNodeId: KnowledgeGraphNodeId,
    input: { edgeType?: 'calls' | 'related_to'; sourceId?: string; versionId?: string; metadata?: Record<string, unknown> | null } = {},
  ) {
    return graph.upsertGraphEdge({
      projectId,
      sourceNodeId,
      targetNodeId,
      edgeType: input.edgeType ?? 'calls',
      evidence: ['explicit_link'],
      provenance:
        input.sourceId === undefined
          ? []
          : [
              {
                kind: 'source',
                id: input.sourceId,
                sourceVersionId: input.versionId,
                ...(input.metadata ? { metadata: input.metadata } : {}),
              },
            ],
    });
  }

  function seedSupportedGraph(projectId: string, name: string) {
    const [versionId] = addSource(projectId, name);
    coverageStore.upsert({ projectId, sourceVersionId: versionId, coverage: coverage() });
    const a = addNode(projectId, `node_${name}_a`, `${name}.a`, versionId, 'sym_a');
    const b = addNode(projectId, `node_${name}_b`, `${name}.b`, versionId, 'sym_b');
    const edge = addEdge(projectId, a, b, { sourceId: `source_${name}`, versionId });
    return { versionId, a, b, edge };
  }

  function snapshot(projectId: string, number: number, createdAt = T0): string {
    const id = `snapshot_${projectId}_${number}`;
    db.prepare(
      `INSERT INTO knowledge_graph_snapshots (id, project_id, snapshot_number, content_hash, content_path, created_at)
       VALUES (?, ?, ?, 'hash', 'graph.json', ?)`,
    ).run(id, projectId, number, createdAt);
    return id;
  }

  beforeEach(() => {
    clock = 0;
    db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_a', 'ws-a', 'A', 'active', ?, ?), ('project_b', 'ws-b', 'B', 'active', ?, ?)`,
    ).run(T0, T0, T0, T0);
    graph = new KnowledgeGraph(db);
    coverageStore = new KnowledgeAnalysisCoverageStore(db, { now: () => T0 });
    reporter = new KnowledgeGraphReporter(db, { now });
  });

  afterEach(() => db.close());

  it('reports a fully covered deterministic graph as complete with no warnings', () => {
    seedSupportedGraph('project_a', 'one');
    seedSupportedGraph('project_a', 'two');

    const report = reporter.buildCompletenessReport({ projectId: 'project_a' });

    expect(report).toMatchObject({
      projectId: 'project_a',
      snapshotId: null,
      sources: { activeCount: 2, coveredCount: 2, partialCount: 0, unsupportedCount: 0, legacyUnknownCount: 0 },
      relationships: { materializedCount: 2, deferredCount: 0, unresolvedCount: 0, downgradedCount: 0, ambiguousCount: 0 },
      provenance: { edgeWithProvenanceCount: 2, edgeMissingProvenanceCount: 0 },
      warnings: [],
    });
    expect(reporter.listAmbiguities('project_a')).toEqual([]);
  });

  it('distinguishes partial, unsupported, and legacy-unknown sources and only counts active latest versions', () => {
    const [covered] = addSource('project_a', 'covered');
    const [partial] = addSource('project_a', 'partial');
    const [unsupported] = addSource('project_a', 'unsupported');
    const [failed] = addSource('project_a', 'failed');
    addSource('project_a', 'legacy');
    addSource('project_a', 'archived', { status: 'archived' });
    const [, latest] = addSource('project_a', 'upgraded', { versions: 2 });
    coverageStore.upsert({ projectId: 'project_a', sourceVersionId: covered, coverage: coverage() });
    coverageStore.upsert({ projectId: 'project_a', sourceVersionId: partial, coverage: coverage({ status: 'partial', missingFeatures: ['dynamic'] }) });
    coverageStore.upsert({
      projectId: 'project_a',
      sourceVersionId: unsupported,
      coverage: coverage({ status: 'unsupported', unsupportedReason: 'no_analyzer', analyzerId: null, analyzerVersion: null }),
    });
    coverageStore.upsert({ projectId: 'project_a', sourceVersionId: failed, coverage: coverage({ status: 'failed', unsupportedReason: 'parser_failed' }) });
    coverageStore.upsert({ projectId: 'project_a', sourceVersionId: 'version_upgraded_1', coverage: coverage({ status: 'partial' }) });
    coverageStore.upsert({ projectId: 'project_a', sourceVersionId: latest, coverage: coverage() });

    const report = reporter.buildCompletenessReport({ projectId: 'project_a' });

    expect(report.sources).toEqual({
      activeCount: 6,
      coveredCount: 2,
      partialCount: 1,
      unsupportedCount: 2,
      legacyUnknownCount: 1,
    });
    expect(report.warnings.map((warning) => warning.code)).toEqual(['partial_source_coverage']);
    expect(report.warnings[0].message).toMatch(/1 partial.*2 unsupported.*1 legacy/i);
  });

  it('records deferred relationships as ambiguities without creating graph nodes or edges', () => {
    const { versionId } = seedSupportedGraph('project_a', 'one');
    const other = addSource('project_a', 'other')[0];
    coverageStore.upsert({ projectId: 'project_a', sourceVersionId: other, coverage: coverage() });
    addNode('project_a', 'node_dup_1', 'shared.handler', other);
    addNode('project_a', 'node_dup_2', 'shared.handler', versionId);
    coverageStore.replaceDeferredRelationships({
      projectId: 'project_a',
      sourceVersionId: versionId,
      candidates: [
        deferred('d_dynamic'),
        deferred('d_external', { resolutionKind: 'external_reference', targetReference: 'requests.get' }),
        deferred('d_alias', { resolutionKind: 'ambiguous_alias', targetReference: 'shared.handler' }),
        deferred('d_alias_none', { resolutionKind: 'ambiguous_alias', targetReference: 'nothing.matches' }),
      ],
    });
    const nodesBefore = db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes').get();
    const edgesBefore = db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_edges').get();

    const report = reporter.buildCompletenessReport({ projectId: 'project_a' });

    expect(report.relationships).toMatchObject({ deferredCount: 4, unresolvedCount: 3, ambiguousCount: 2 });
    expect(report.warnings.map((warning) => warning.code)).toEqual(['deferred_relationships_present']);
    const ambiguities = reporter.listAmbiguities('project_a');
    expect(ambiguities.map((entry) => entry.ambiguityKind).sort()).toEqual([
      'external_reference_unresolved',
      'generated_relationship_deferred',
      'multiple_candidate_targets',
      'multiple_candidate_targets',
    ]);
    const multiple = ambiguities.find((entry) => entry.candidateNodeIds?.length === 2);
    expect(multiple).toMatchObject({
      severity: 'review',
      sourceVersionId: versionId,
      candidateNodeIds: ['node_dup_1', 'node_dup_2'],
    });
    const noCandidates = ambiguities.find(
      (entry) => entry.ambiguityKind === 'multiple_candidate_targets' && entry.candidateNodeIds?.length === 0,
    );
    expect(noCandidates?.severity).toBe('warning');
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes').get()).toEqual(nodesBefore);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_edges').get()).toEqual(edgesBefore);
  });

  it('links deferred candidates to existing symbol nodes only', () => {
    const { versionId, a } = seedSupportedGraph('project_a', 'one');
    coverageStore.replaceDeferredRelationships({
      projectId: 'project_a',
      sourceVersionId: versionId,
      candidates: [deferred('d_known', { sourceSymbolId: 'sym_a' }), deferred('d_unknown', { sourceSymbolId: 'sym_missing' })],
    });
    reporter.buildCompletenessReport({ projectId: 'project_a' });

    const bySource = reporter.listAmbiguities('project_a').map((entry) => entry.sourceNodeId);
    expect(bySource.sort((left, right) => String(left).localeCompare(String(right)))).toEqual([a, null].sort((left, right) => String(left).localeCompare(String(right))));
  });

  it('captures relation downgrades and missing or sanitized provenance with typed graph evidence intact', () => {
    const { versionId, a, b } = seedSupportedGraph('project_a', 'one');
    const c = addNode('project_a', 'node_one_c', 'one.c', versionId);
    const d = addNode('project_a', 'node_one_d', 'one.d', versionId);
    const downgraded = addEdge('project_a', a, c, {
      edgeType: 'related_to',
      sourceId: 'source_one',
      versionId,
      metadata: { originalEdgeType: 'uses' },
    });
    const missing = addEdge('project_a', b, c);
    const sanitized = addEdge('project_a', c, d, {
      sourceId: 'source_one',
      versionId,
      metadata: { diagnostic: 'legacy metadata omitted: unsupported value' },
    });
    const edgesBefore = JSON.stringify(graph.listGraphEdges('project_a'));

    const report = reporter.buildCompletenessReport({ projectId: 'project_a' });

    expect(report.relationships).toMatchObject({ materializedCount: 4, downgradedCount: 1 });
    expect(report.provenance).toEqual({ edgeWithProvenanceCount: 3, edgeMissingProvenanceCount: 1 });
    expect(report.warnings.map((warning) => warning.code)).toEqual(['downgraded_relation_types', 'legacy_provenance_omitted']);
    const ambiguities = reporter.listAmbiguities('project_a');
    expect(ambiguities).toContainEqual(
      expect.objectContaining({
        ambiguityKind: 'downgraded_relation_type',
        severity: 'warning',
        sourceNodeId: a,
        targetNodeId: c,
        relatedEdgeIds: [downgraded.id],
        sourceVersionId: versionId,
      }),
    );
    expect(ambiguities).toContainEqual(
      expect.objectContaining({ ambiguityKind: 'provenance_missing', relatedEdgeIds: [missing.id], sourceVersionId: versionId }),
    );
    expect(ambiguities).toContainEqual(
      expect.objectContaining({ ambiguityKind: 'legacy_metadata_omitted', relatedEdgeIds: [sanitized.id] }),
    );
    expect(JSON.stringify(graph.listGraphEdges('project_a'))).toBe(edgesBefore);
  });

  it('never stores raw reference text, snippets, or prompts in report or ambiguity rows', () => {
    const { versionId, a, c } = (() => {
      const seeded = seedSupportedGraph('project_a', 'one');
      const c = addNode('project_a', 'node_one_c', 'one.c', seeded.versionId);
      return { ...seeded, c };
    })();
    addEdge('project_a', a, c, {
      edgeType: 'related_to',
      sourceId: 'source_one',
      versionId,
      metadata: { originalEdgeType: 'api_key=sk-abcdefghijklmnopqrstuvwx and a very long relation label '.repeat(20) },
    });
    coverageStore.replaceDeferredRelationships({
      projectId: 'project_a',
      sourceVersionId: versionId,
      candidates: [
        deferred('d_secret', { metadata: { reason: 'raw snippet: password=hunter2' } }),
        deferred('d_ext', { resolutionKind: 'external_reference', targetReference: 'requests.get' }),
      ],
    });

    reporter.buildCompletenessReport({ projectId: 'project_a' });

    const stored = JSON.stringify([
      db.prepare('SELECT * FROM knowledge_graph_reports').all(),
      db.prepare('SELECT * FROM knowledge_graph_ambiguities').all(),
    ]);
    for (const forbidden of ['secret_target_reference_text', 'requests.get', 'hunter2', 'sk-abcdefghijklmnopqrstuvwx', 'dynamic dispatch']) {
      expect(stored).not.toContain(forbidden);
    }
    const details = (db.prepare('SELECT detail_json FROM knowledge_graph_ambiguities').all() as Array<{ detail_json: string }>).map(
      (row) => row.detail_json.length,
    );
    expect(Math.max(...details)).toBeLessThan(1024);
  });

  it('keeps reports and ambiguities project scoped', () => {
    seedSupportedGraph('project_a', 'one');
    const [versionB] = addSource('project_b', 'bee');
    coverageStore.replaceDeferredRelationships({ projectId: 'project_b', sourceVersionId: versionB, candidates: [deferred('d_b')] });
    addNode('project_b', 'node_bee_a', 'bee.a', versionB);

    const reportA = reporter.buildCompletenessReport({ projectId: 'project_a' });
    const reportB = reporter.buildCompletenessReport({ projectId: 'project_b' });

    expect(reportA.sources.activeCount).toBe(1);
    expect(reportA.relationships.deferredCount).toBe(0);
    expect(reportB).toMatchObject({
      sources: { activeCount: 1, legacyUnknownCount: 1 },
      relationships: { materializedCount: 0, deferredCount: 1 },
    });
    expect(reporter.listAmbiguities('project_a')).toEqual([]);
    expect(reporter.listAmbiguities('project_b')).toHaveLength(1);
    expect(reporter.getCompletenessReport('project_a')).toEqual(reportA);
    expect(() => reporter.buildCompletenessReport({ projectId: 'missing' })).toThrow(/project.*not found/i);
    const snapshotB = snapshot('project_b', 1);
    expect(() => reporter.buildCompletenessReport({ projectId: 'project_a', snapshotId: snapshotB })).toThrow(/snapshot.*not found/i);
    expect(reporter.listAmbiguities('project_a', snapshotB)).toEqual([]);
  });

  it('is deterministic and idempotent across repeated reporting', () => {
    const { versionId } = seedSupportedGraph('project_a', 'one');
    coverageStore.replaceDeferredRelationships({
      projectId: 'project_a',
      sourceVersionId: versionId,
      candidates: [deferred('d1'), deferred('d2', { resolutionKind: 'external_reference' })],
    });

    const first = reporter.buildCompletenessReport({ projectId: 'project_a' });
    const firstRows = db.prepare('SELECT * FROM knowledge_graph_ambiguities ORDER BY id').all();
    const second = reporter.buildCompletenessReport({ projectId: 'project_a' });

    expect(second).toEqual(first);
    expect(db.prepare('SELECT * FROM knowledge_graph_ambiguities ORDER BY id').all()).toEqual(firstRows);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_reports').get()).toEqual({ count: 1 });
    expect(reporter.listAmbiguities('project_a')).toEqual(reporter.listAmbiguities('project_a'));

    coverageStore.replaceDeferredRelationships({ projectId: 'project_a', sourceVersionId: versionId, candidates: [] });
    const third = reporter.buildCompletenessReport({ projectId: 'project_a' });
    expect(third.relationships.deferredCount).toBe(0);
    expect(third.createdAt).not.toBe(first.createdAt);
    expect(reporter.listAmbiguities('project_a')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_reports').get()).toEqual({ count: 1 });
  });

  it('scopes reports to the latest snapshot, flags stale snapshots, and cascades with snapshot deletion', () => {
    const { versionId } = seedSupportedGraph('project_a', 'one');
    coverageStore.replaceDeferredRelationships({ projectId: 'project_a', sourceVersionId: versionId, candidates: [deferred('d1')] });
    const first = snapshot('project_a', 1, '2000-01-01T00:00:00.000Z');
    const second = snapshot('project_a', 2, '2999-01-01T00:00:00.000Z');

    const staleReport = reporter.buildCompletenessReport({ projectId: 'project_a', snapshotId: first });
    const latestReport = reporter.buildCompletenessReport({ projectId: 'project_a' });

    expect(staleReport.snapshotId).toBe(first);
    expect(staleReport.warnings.map((warning) => warning.code)).toContain('graph_snapshot_stale');
    expect(latestReport.snapshotId).toBe(second);
    expect(latestReport.warnings.map((warning) => warning.code)).not.toContain('graph_snapshot_stale');
    expect(reporter.listAmbiguities('project_a', first)).toHaveLength(1);
    expect(reporter.listAmbiguities('project_a')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_reports').get()).toEqual({ count: 2 });

    db.prepare('DELETE FROM knowledge_graph_snapshots WHERE id = ?').run(first);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_reports').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_ambiguities').get()).toEqual({ count: 1 });
  });

  it('reads as not yet computed until built and can be recomputed without touching graph facts', () => {
    const { versionId } = seedSupportedGraph('project_a', 'one');
    coverageStore.replaceDeferredRelationships({ projectId: 'project_a', sourceVersionId: versionId, candidates: [deferred('d1')] });
    expect(reporter.getCompletenessReport('project_a')).toBeNull();
    expect(reporter.listAmbiguities('project_a')).toEqual([]);
    const factsBefore = JSON.stringify([
      db.prepare('SELECT * FROM knowledge_graph_nodes ORDER BY id').all(),
      db.prepare('SELECT * FROM knowledge_graph_edges ORDER BY id').all(),
      db.prepare('SELECT * FROM knowledge_deferred_relationships ORDER BY id').all(),
    ]);

    const built = reporter.buildCompletenessReport({ projectId: 'project_a' });
    db.exec('DELETE FROM knowledge_graph_ambiguities; DELETE FROM knowledge_graph_reports;');
    expect(reporter.getCompletenessReport('project_a')).toBeNull();
    const rebuilt = reporter.buildCompletenessReport({ projectId: 'project_a' });

    expect({ ...rebuilt, createdAt: built.createdAt }).toEqual(built);
    expect(reporter.listAmbiguities('project_a')).toHaveLength(1);
    expect(
      JSON.stringify([
        db.prepare('SELECT * FROM knowledge_graph_nodes ORDER BY id').all(),
        db.prepare('SELECT * FROM knowledge_graph_edges ORDER BY id').all(),
        db.prepare('SELECT * FROM knowledge_deferred_relationships ORDER BY id').all(),
      ]),
    ).toBe(factsBefore);
  });

  it('bounds stored ambiguity rows while keeping exact counts', () => {
    const [versionId] = addSource('project_a', 'big');
    coverageStore.upsert({ projectId: 'project_a', sourceVersionId: versionId, coverage: coverage({ status: 'partial' }) });
    const nodes = Array.from({ length: 2 }, (_, index) => addNode('project_a', `node_big_${index}`, `big.${index}`, versionId));
    const insertEdge = db.prepare(
      `INSERT INTO knowledge_graph_nodes (id, project_id, node_type, label, source_kind, source_id, created_at, updated_at)
       VALUES (?, 'project_a', 'function', ?, 'deterministic_symbol', ?, ?, ?)`,
    );
    const total = MAX_GRAPH_AMBIGUITIES_PER_REPORT + 25;
    for (let index = 0; index < total; index += 1) {
      insertEdge.run(`node_extra_${index}`, `extra.${index}`, `extra_${index}`, T0, T0);
      db.prepare(
        `INSERT INTO knowledge_graph_edges
         (id, project_id, source_node_id, target_node_id, edge_type, evidence_json, confidence, created_at, updated_at)
         VALUES (?, 'project_a', ?, ?, 'calls', '{"evidence":["explicit_link"],"weight":1,"provenance":[]}', 1, ?, ?)`,
      ).run(`edge_extra_${index}`, nodes[0], `node_extra_${index}`, T0, T0);
    }

    const report = reporter.buildCompletenessReport({ projectId: 'project_a' });

    expect(report.provenance.edgeMissingProvenanceCount).toBe(total);
    expect(reporter.listAmbiguities('project_a')).toHaveLength(MAX_GRAPH_AMBIGUITIES_PER_REPORT);
    expect(report.ambiguities).toEqual({ totalCount: total, storedCount: MAX_GRAPH_AMBIGUITIES_PER_REPORT });
  });
});
