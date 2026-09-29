import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/schema.js';
import { createKnowledgeId } from '../../src/knowledge/KnowledgeIds.js';
import type { DeterministicExtraction } from '../../src/knowledge/KnowledgeExtraction.js';
import { KnowledgeGraphMaterializer } from '../../src/knowledge/KnowledgeGraphMaterializer.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgeGraph } from '../../src/knowledge/graph/KnowledgeGraph.js';

function createGraph(): { db: Database.Database; graph: KnowledgeGraph } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  applyKnowledgeMigrations(db);
  db.prepare(
    `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
     VALUES ('project-1', '/workspace/one', 'Workspace One', ?, ?),
            ('project-2', '/workspace/two', 'Workspace Two', ?, ?)`,
  ).run(
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, created_at, updated_at)
     VALUES ('source-1', 'project-1', 'file', 'src/service.ts', ?, ?),
            ('source-2', 'project-2', 'file', 'src/service.ts', ?, ?)`
  ).run(
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, created_at, updated_at)
     VALUES ('source-3', 'project-1', 'file', 'src/shared.ts', ?, ?)`
  ).run('2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
  db.prepare(
    `INSERT INTO knowledge_source_versions (
       id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at
     ) VALUES
       ('source-version-1', 'project-1', 'source-1', 1, 'hash-1', 'content/source-version-1', 10, ?),
       ('source-version-2', 'project-2', 'source-2', 1, 'hash-2', 'content/source-version-2', 10, ?),
       ('source-version-3', 'project-1', 'source-3', 1, 'hash-3', 'content/source-version-3', 10, ?)`
  ).run('2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
  return { db, graph: new KnowledgeGraph(db) };
}

function extraction(): DeterministicExtraction {
  return {
    analyzerId: 'typescript-lezer',
    analyzerVersion: '1',
    sourceVersionId: 'source-version-1',
    title: 'service.ts',
    summary: 'Service module.',
    sections: [],
    symbols: [
      {
        id: 'symbol:module:service',
        kind: 'module',
        name: 'service',
        qualifiedName: 'src/service',
        span: {
          startOffset: 0,
          endOffset: 240,
          startLine: 1,
          startColumn: 1,
          endLine: 20,
          endColumn: 1,
        },
        confidence: 1,
      },
      {
        id: 'symbol:module:dep',
        kind: 'module',
        name: 'dep',
        qualifiedName: 'src/dep',
        span: {
          startOffset: 241,
          endOffset: 280,
          startLine: 21,
          startColumn: 1,
          endLine: 24,
          endColumn: 1,
        },
        confidence: 1,
      },
      {
        id: 'symbol:class:base',
        kind: 'class',
        name: 'BaseService',
        qualifiedName: 'src/service.BaseService',
        span: {
          startOffset: 10,
          endOffset: 40,
          startLine: 2,
          startColumn: 1,
          endLine: 4,
          endColumn: 1,
        },
        confidence: 0.96,
      },
      {
        id: 'symbol:class:service',
        kind: 'class',
        name: 'DeviceService',
        qualifiedName: 'src/service.DeviceService',
        span: {
          startOffset: 41,
          endOffset: 140,
          startLine: 5,
          startColumn: 1,
          endLine: 12,
          endColumn: 1,
        },
        confidence: 0.97,
      },
      {
        id: 'symbol:method:run',
        kind: 'method',
        name: 'run',
        qualifiedName: 'src/service.DeviceService.run',
        span: {
          startOffset: 90,
          endOffset: 130,
          startLine: 8,
          startColumn: 3,
          endLine: 10,
          endColumn: 4,
        },
        confidence: 0.91,
      },
      {
        id: 'symbol:function:helper',
        kind: 'function',
        name: 'helper',
        qualifiedName: 'src/service.helper',
        span: {
          startOffset: 150,
          endOffset: 190,
          startLine: 13,
          startColumn: 1,
          endLine: 16,
          endColumn: 1,
        },
        confidence: 0.92,
      },
    ],
    relationships: [
      {
        id: 'relationship:imports',
        type: 'imports',
        sourceSymbolId: null,
        targetReference: 'src/dep#default',
        span: {
          startOffset: 1,
          endOffset: 9,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 9,
        },
        confidence: 1,
        metadata: { importKind: 'named' },
      },
      {
        id: 'relationship:inherits',
        type: 'inherits',
        sourceSymbolId: 'symbol:class:service',
        targetSymbolId: 'symbol:class:base',
        span: {
          startOffset: 41,
          endOffset: 70,
          startLine: 5,
          startColumn: 1,
          endLine: 5,
          endColumn: 30,
        },
        confidence: 0.88,
      },
      {
        id: 'relationship:contains',
        type: 'contains',
        sourceSymbolId: 'symbol:class:service',
        targetSymbolId: 'symbol:method:run',
        span: {
          startOffset: 80,
          endOffset: 140,
          startLine: 7,
          startColumn: 1,
          endLine: 12,
          endColumn: 1,
        },
        confidence: 0.93,
      },
      {
        id: 'relationship:calls:1',
        type: 'calls',
        sourceSymbolId: 'symbol:method:run',
        targetSymbolId: 'symbol:function:helper',
        span: {
          startOffset: 110,
          endOffset: 118,
          startLine: 9,
          startColumn: 5,
          endLine: 9,
          endColumn: 13,
        },
        confidence: 0.78,
        metadata: { callee: 'helper' },
      },
      {
        id: 'relationship:calls:2',
        type: 'calls',
        sourceSymbolId: 'symbol:method:run',
        targetSymbolId: 'symbol:function:helper',
        span: {
          startOffset: 120,
          endOffset: 128,
          startLine: 10,
          startColumn: 5,
          endLine: 10,
          endColumn: 13,
        },
        confidence: 0.64,
        metadata: { callee: 'helper', occurrence: 'second' },
      },
      {
        id: 'relationship:external',
        type: 'references',
        sourceSymbolId: 'symbol:method:run',
        targetSymbolId: null,
        targetReference: 'external.Library.run',
        span: {
          startOffset: 130,
          endOffset: 145,
          startLine: 11,
          startColumn: 5,
          endLine: 11,
          endColumn: 20,
        },
        confidence: 0.52,
      },
    ],
    links: [],
    diagnostics: [],
  };
}

describe('KnowledgeGraphMaterializer', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('materializes stable nodes and typed edges idempotently with exact provenance', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const materializer = new KnowledgeGraphMaterializer(graph);

    const first = materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      extraction: extraction(),
    });
    const second = materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      extraction: extraction(),
    });

    const expectedNodeIds = [
      createKnowledgeId('graph-node', 'project-1:source-version-1:class:src/service.BaseService:10:40'),
      createKnowledgeId('graph-node', 'project-1:source-version-1:class:src/service.DeviceService:41:140'),
      createKnowledgeId('graph-node', 'project-1:source-version-1:function:src/service.helper:150:190'),
      createKnowledgeId('graph-node', 'project-1:source-version-1:method:src/service.DeviceService.run:90:130'),
      createKnowledgeId('graph-node', 'project-1:source-version-1:module:src/dep:241:280'),
      createKnowledgeId('graph-node', 'project-1:source-version-1:module:src/service:0:240'),
    ].sort();

    const expectedEdgeIds = [
      createKnowledgeId(
        'graph-edge',
        `project-1:source-version-1:calls:${createKnowledgeId('graph-node', 'project-1:source-version-1:method:src/service.DeviceService.run:90:130')}:${createKnowledgeId('graph-node', 'project-1:source-version-1:function:src/service.helper:150:190')}`,
      ),
      createKnowledgeId(
        'graph-edge',
        `project-1:source-version-1:contains:${createKnowledgeId('graph-node', 'project-1:source-version-1:class:src/service.DeviceService:41:140')}:${createKnowledgeId('graph-node', 'project-1:source-version-1:method:src/service.DeviceService.run:90:130')}`,
      ),
      createKnowledgeId(
        'graph-edge',
        `project-1:source-version-1:imports:${createKnowledgeId('graph-node', 'project-1:source-version-1:module:src/service:0:240')}:${createKnowledgeId('graph-node', 'project-1:source-version-1:module:src/dep:241:280')}`,
      ),
      createKnowledgeId(
        'graph-edge',
        `project-1:source-version-1:inherits:${createKnowledgeId('graph-node', 'project-1:source-version-1:class:src/service.DeviceService:41:140')}:${createKnowledgeId('graph-node', 'project-1:source-version-1:class:src/service.BaseService:10:40')}`,
      ),
    ].sort();

    expect(first).toEqual({
      nodeIds: expectedNodeIds,
      edgeIds: expectedEdgeIds,
      unresolvedRelationships: 1,
      ambiguousRelationships: [],
    });
    expect(second).toEqual(first);

    const nodes = graph.listGraphNodes('project-1');
    expect(nodes.map((node) => node.id).sort()).toEqual(expectedNodeIds);
    expect(nodes).toContainEqual(
      expect.objectContaining({
        id: createKnowledgeId('graph-node', 'project-1:source-version-1:method:src/service.DeviceService.run:90:130'),
        nodeType: 'method',
        label: 'run',
        qualifiedName: 'src/service.DeviceService.run',
        provenanceSourceId: 'source-1',
        provenanceSourcePath: 'src/service.ts',
        sourceVersionId: 'source-version-1',
        span: {
          startOffset: 90,
          endOffset: 130,
          startLine: 8,
          startColumn: 3,
          endLine: 10,
          endColumn: 4,
        },
        confidence: 0.91,
      }),
    );

    const edges = graph.listGraphEdges('project-1');
    expect(edges).toHaveLength(4);
    expect(edges.map((edge) => edge.edgeType).sort()).toEqual(['calls', 'contains', 'imports', 'inherits']);
    expect(edges.every((edge) => edge.evidence.includes('explicit_link'))).toBe(true);
    expect(edges.find((edge) => edge.edgeType === 'calls')).toMatchObject({
      confidence: 0.78,
      provenance: [
        {
          kind: 'source',
          id: 'source-1',
          path: 'src/service.ts',
          sourceVersionId: 'source-version-1',
          startOffset: 110,
          endOffset: 118,
          startLine: 9,
          endLine: 9,
          startColumn: 5,
          endColumn: 13,
          confidence: 0.78,
          metadata: { callee: 'helper' },
        },
        {
          kind: 'source',
          id: 'source-1',
          path: 'src/service.ts',
          sourceVersionId: 'source-version-1',
          startOffset: 120,
          endOffset: 128,
          startLine: 10,
          endLine: 10,
          startColumn: 5,
          endColumn: 13,
          confidence: 0.64,
          metadata: { callee: 'helper', occurrence: 'second' },
        },
      ],
    });
  });


  it('rejects extraction source-version mismatches and resolves same-project prior symbols', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const materializer = new KnowledgeGraphMaterializer(graph);

    expect(() =>
      materializer.materialize({
        projectId: 'project-1',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        extraction: { ...extraction(), sourceVersionId: 'source-version-3' },
      }),
    ).toThrow(/must match source-version-1/);

    materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-3',
      sourceVersionId: 'source-version-3',
      extraction: {
        analyzerId: 'typescript-lezer',
        analyzerVersion: '1',
        sourceVersionId: 'source-version-3',
        title: 'shared.ts',
        summary: 'Shared helper.',
        sections: [],
        symbols: [
          {
            id: 'symbol:function:shared-helper',
            kind: 'function',
            name: 'helper',
            qualifiedName: 'src/shared.helper',
            span: {
              startOffset: 0,
              endOffset: 20,
              startLine: 1,
              startColumn: 1,
              endLine: 2,
              endColumn: 1,
            },
            confidence: 1,
          },
        ],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const result = materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      extraction: {
        ...extraction(),
        symbols: extraction().symbols.filter((symbol) => symbol.id !== 'symbol:function:helper'),
        relationships: [
          {
            id: 'relationship:project-call',
            type: 'calls',
            sourceSymbolId: 'symbol:method:run',
            targetSymbolId: null,
            targetReference: 'src/shared.helper',
            confidence: 0.7,
          },
        ],
      },
    });

    expect(result.unresolvedRelationships).toBe(0);
    expect(graph.listGraphEdges('project-1')).toContainEqual(
      expect.objectContaining({ edgeType: 'calls' }),
    );
  });

  it('rejects deterministic node-id collisions without losing the prior graph snapshot', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const materializer = new KnowledgeGraphMaterializer(graph);

    const baseline = materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      extraction: extraction(),
    });

    const collidingExtraction: DeterministicExtraction = {
      ...extraction(),
      symbols: [
        {
          id: 'symbol:function:first',
          kind: 'function',
          name: 'dup',
          qualifiedName: 'src/service.dup',
          span: {
            startOffset: 300,
            endOffset: 340,
            startLine: 30,
            startColumn: 1,
            endLine: 34,
            endColumn: 1,
          },
          confidence: 0.9,
        },
        {
          id: 'symbol:function:second',
          kind: 'function',
          name: 'dup',
          qualifiedName: 'src/service.dup',
          span: {
            startOffset: 300,
            endOffset: 340,
            startLine: 30,
            startColumn: 1,
            endLine: 34,
            endColumn: 1,
          },
          confidence: 0.8,
        },
      ],
      relationships: [],
    };

    expect(() =>
      materializer.materialize({
        projectId: 'project-1',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        extraction: collidingExtraction,
      }),
    ).toThrow(/node ID collision/i);
    expect(graph.listGraphNodes('project-1').map((node) => node.id).sort()).toEqual(baseline.nodeIds);
  });

  it('drops unallowlisted relationship metadata instead of persisting secrets verbatim', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const materializer = new KnowledgeGraphMaterializer(graph);

    materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      extraction: {
        ...extraction(),
        relationships: [
          {
            id: 'relationship:calls:redacted',
            type: 'calls',
            sourceSymbolId: 'symbol:method:run',
            targetSymbolId: 'symbol:function:helper',
            confidence: 0.7,
            metadata: {
              callee: 'helper',
              token: 'sk-abcdefghijklmnopqrstuvwxyz123456',
            } as never,
          },
        ],
      },
    });

    expect(graph.listGraphEdges('project-1')).toContainEqual(
      expect.objectContaining({
        edgeType: 'calls',
        provenance: [
          expect.objectContaining({
            metadata: { callee: 'helper' },
          }),
        ],
      }),
    );
  });


  it('replaces prior materialized rows for the same source version and ignores unqualified fallback matches', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const materializer = new KnowledgeGraphMaterializer(graph);

    materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      extraction: extraction(),
    });
    graph.upsertGraphNode({
      id: 'page-helper' as never,
      projectId: 'project-1',
      nodeType: 'page',
      label: 'src/page.helper',
    });

    const refreshed = materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      extraction: {
        ...extraction(),
        symbols: extraction().symbols.filter((symbol) => symbol.id === 'symbol:method:run'),
        relationships: [
          {
            id: 'relationship:page-fallback',
            type: 'calls',
            sourceSymbolId: 'symbol:method:run',
            targetSymbolId: null,
            targetReference: 'helper',
            confidence: 0.6,
          },
        ],
      },
    });

    expect(refreshed.nodeIds).toHaveLength(1);
    expect(graph.listGraphNodes('project-1').filter((node) => node.sourceKind === 'deterministic_symbol')).toHaveLength(1);
    expect(graph.listGraphEdges('project-1')).toEqual([]);
    expect(refreshed.unresolvedRelationships).toBe(1);
  });


  it('rejects nonexistent or foreign source provenance before persistence', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const materializer = new KnowledgeGraphMaterializer(graph);

    expect(() =>
      materializer.materialize({
        projectId: 'project-1',
        sourceId: 'source-2',
        sourceVersionId: 'source-version-2',
        extraction: { ...extraction(), sourceVersionId: 'source-version-2' },
      }),
    ).toThrow(/must exist in project project-1/);
  });

  it('stays project-scoped and does not fabricate unresolved endpoints', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const materializer = new KnowledgeGraphMaterializer(graph);

    graph.upsertGraphNode({
      id: 'project-2-helper' as never,
      projectId: 'project-2',
      nodeType: 'function',
      label: 'helper',
      qualifiedName: 'src/service.helper',
      sourceVersionId: 'source-version-2',
      span: {
        startOffset: 0,
        endOffset: 12,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 13,
      },
    });

    const result = materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      extraction: {
        ...extraction(),
        symbols: extraction().symbols.filter((symbol) => symbol.id !== 'symbol:function:helper'),
        relationships: [
          {
            id: 'relationship:cross-project-attempt',
            type: 'calls',
            sourceSymbolId: 'symbol:method:run',
            targetSymbolId: null,
            targetReference: 'src/service.helper',
            confidence: 0.5,
          },
        ],
      },
    });

    expect(result.edgeIds).toEqual([]);
    expect(result.unresolvedRelationships).toBe(1);
    expect(graph.listGraphEdges('project-1')).toEqual([]);
    expect(graph.listGraphNodes('project-2')).toHaveLength(1);
  });
  it('reports alias-ambiguous relationships as deferred candidates without creating edges or nodes', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const materializer = new KnowledgeGraphMaterializer(graph);
    const base = extraction();
    const span = (start: number) => ({ startOffset: start, endOffset: start + 5, startLine: 30, startColumn: 1, endLine: 30, endColumn: 6 });

    const result = materializer.materialize({
      projectId: 'project-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      extraction: {
        ...base,
        symbols: [
          ...base.symbols,
          { id: 'symbol:function:dup-a', kind: 'function', name: 'dup', qualifiedName: 'src/a.dup', span: span(300), confidence: 1 },
          { id: 'symbol:function:dup-b', kind: 'function', name: 'dup', qualifiedName: 'src/b.dup', span: span(400), confidence: 1 },
        ],
        relationships: [
          {
            id: 'relationship:ambiguous',
            type: 'calls',
            sourceSymbolId: 'symbol:method:run',
            targetReference: 'dup',
            span: span(310),
            confidence: 0.6,
          },
          { id: 'relationship:missing', type: 'calls', sourceSymbolId: 'symbol:method:run', targetReference: 'nowhere.at.all', confidence: 0.6 },
        ],
      },
    });

    expect(result.unresolvedRelationships).toBe(2);
    expect(result.edgeIds).toEqual([]);
    expect(result.ambiguousRelationships).toEqual([
      {
        id: 'relationship:ambiguous',
        type: 'calls',
        sourceSymbolId: 'symbol:method:run',
        targetReference: 'dup',
        resolutionKind: 'ambiguous_alias',
        evidenceKind: 'naming',
        confidence: 0.6,
        span: span(310),
        metadata: { origin: 'graph_materialization' },
      },
    ]);
    expect(graph.listGraphNodes('project-1').map((node) => node.label)).not.toContain('nowhere.at.all');
  });
});
