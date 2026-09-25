import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../../src/schema.js';
import { applyKnowledgeMigrations } from '../../../src/knowledge/knowledgeMigrations.js';
import { KnowledgeGraph } from '../../../src/knowledge/graph/KnowledgeGraph.js';

function createGraph(): { db: Database.Database; graph: KnowledgeGraph } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  applyKnowledgeMigrations(db);
  db.prepare(
    `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
     VALUES ('project-1', '/workspace', 'Workspace', ?, ?)`,
  ).run('2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
  db.prepare(
    `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
     VALUES ('project-2', '/workspace-two', 'Workspace Two', ?, ?)`,
  ).run('2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
  db.prepare(
    `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, created_at, updated_at)
     VALUES ('source-1', 'project-1', 'file', 'docs/A.md', ?, ?),
            ('source-2', 'project-2', 'file', 'docs/B.md', ?, ?)`
  ).run(
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
    '2026-09-24T00:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO knowledge_source_versions (
       id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at
     ) VALUES
       ('source-version-1', 'project-1', 'source-1', 1, 'hash-1', 'content/source-version-1', 10, ?),
       ('source-version-2', 'project-2', 'source-2', 1, 'hash-2', 'content/source-version-2', 10, ?)`
  ).run('2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
  return { db, graph: new KnowledgeGraph(db) };
}

describe('KnowledgeGraph', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('persists node metadata plus weighted evidence and provenance edges', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const nodeA = graph.upsertGraphNode({
      id: 'node-a' as never,
      projectId: 'project-1',
      nodeType: 'page',
      label: 'A',
      qualifiedName: 'docs/A',
      sourceVersionId: 'source-version-1',
      span: {
        startOffset: 0,
        endOffset: 8,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 9,
      },
    });
    graph.upsertGraphNode({ id: 'node-b' as never, projectId: 'project-1', nodeType: 'page', label: 'B' });
    const edge = graph.upsertGraphEdge({
      projectId: 'project-1',
      sourceNodeId: 'node-a' as never,
      targetNodeId: 'node-b' as never,
      edgeType: 'relates_to',
      evidence: ['explicit_link', 'shared_source'],
      weight: 0.75,
      confidence: 0.8,
      provenance: [
        {
          kind: 'source',
          id: 'source-1',
          sourceVersionId: 'source-version-1',
          startOffset: 0,
          endOffset: 8,
          startLine: 2,
          endLine: 3,
          startColumn: 1,
          endColumn: 4,
          confidence: 0.9,
          metadata: { relation: 'reference' },
        },
        {
          kind: 'file',
          id: './docs/A.md',
          path: './docs/A.md',
        },
      ],
    });

    expect(nodeA).toMatchObject({
      qualifiedName: 'docs/A',
      provenanceSourceId: 'source-1',
      provenanceSourcePath: 'docs/A.md',
      sourceVersionId: 'source-version-1',
      span: {
        startOffset: 0,
        endOffset: 8,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 9,
      },
    });
    expect(edge.evidence).toEqual(['explicit_link', 'shared_source']);
    expect(edge.weight).toBe(0.75);
    expect(edge.provenance).toEqual([
      {
        kind: 'file',
        id: 'docs/A.md',
        path: 'docs/A.md',
      },
      {
        kind: 'source',
        id: 'source-1',
        path: 'docs/A.md',
        sourceVersionId: 'source-version-1',
        startOffset: 0,
        endOffset: 8,
        startLine: 2,
        endLine: 3,
        startColumn: 1,
        endColumn: 4,
        confidence: 0.9,
        metadata: { relation: 'reference' },
      },
    ]);
    expect(graph.scoreGraphEdge(edge)).toBeCloseTo(0.57);
  });

  it('overrides caller-supplied source provenance paths with authoritative source records', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    graph.upsertGraphNode({ id: 'node-a' as never, projectId: 'project-1', nodeType: 'page', label: 'A' });
    graph.upsertGraphNode({ id: 'node-b' as never, projectId: 'project-1', nodeType: 'page', label: 'B' });

    const edge = graph.upsertGraphEdge({
      projectId: 'project-1',
      sourceNodeId: 'node-a' as never,
      targetNodeId: 'node-b' as never,
      edgeType: 'relates_to',
      evidence: 'explicit_link',
      provenance: [
        {
          kind: 'source',
          id: 'source-1',
          path: 'docs/B.md',
          sourceVersionId: 'source-version-1',
        },
      ],
    });

    expect(edge.provenance).toEqual([
      {
        kind: 'source',
        id: 'source-1',
        path: 'docs/A.md',
        sourceVersionId: 'source-version-1',
      },
    ]);
  });

  it('rejects self loops and endpoints from another or missing project', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    graph.upsertGraphNode({ id: 'node-a' as never, projectId: 'project-1', nodeType: 'page', label: 'A' });
    expect(() =>
      graph.upsertGraphNode({
        id: 'invalid-version' as never,
        projectId: 'project-1',
        nodeType: 'page',
        label: 'Invalid version',
        sourceVersionId: 'source-version-2',
      }),
    ).toThrow(/must belong to project project-1/);
    expect(() =>
      graph.upsertGraphEdge({
        projectId: 'project-1',
        sourceNodeId: 'node-a' as never,
        targetNodeId: 'node-a' as never,
        edgeType: 'relates_to',
        evidence: 'explicit_link',
      }),
    ).toThrow(/cannot connect/);
    expect(() =>
      graph.upsertGraphEdge({
        projectId: 'project-1',
        sourceNodeId: 'node-a' as never,
        targetNodeId: 'missing' as never,
        edgeType: 'relates_to',
        evidence: 'explicit_link',
      }),
    ).toThrow(/endpoints must exist/);
    graph.upsertGraphNode({ id: 'node-b' as never, projectId: 'project-1', nodeType: 'page', label: 'B' });
    expect(() =>
      graph.upsertGraphEdge({
        projectId: 'project-1',
        sourceNodeId: 'node-a' as never,
        targetNodeId: 'node-b' as never,
        edgeType: 'relates_to',
        evidence: 'explicit_link',
        provenance: [{ kind: 'source', id: 'source-2', sourceVersionId: 'source-version-2' }],
      }),
    ).toThrow(/must belong to project project-1/);
    graph.upsertGraphNode({ id: 'node-cross' as never, projectId: 'project-2', nodeType: 'page', label: 'Other' });
    expect(() =>
      graph.upsertGraphNode({ id: 'node-cross' as never, projectId: 'project-1', nodeType: 'page', label: 'Moved' }),
    ).toThrow(/belongs to another project/);
  });

  it('keeps generic lookup for unversioned nodes and removes versioned symbols when the source version is deleted', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    graph.upsertGraphNode({
      id: 'manual-node' as never,
      projectId: 'project-1',
      nodeType: 'page',
      label: 'Manual',
      qualifiedName: 'manual.ref',
    });
    graph.upsertGraphNode({
      id: 'symbol-node' as never,
      projectId: 'project-1',
      nodeType: 'function',
      label: 'Helper',
      sourceKind: 'deterministic_symbol',
      sourceId: 'source-version-1:symbol:helper',
      qualifiedName: 'src.helper',
      sourceVersionId: 'source-version-1',
    });

    expect(graph.findUniqueGraphNodeId('project-1', 'manual.ref')).toBe('manual-node');
    expect(graph.findUniqueGraphNodeId('project-1', 'src.helper', { sourceKind: 'deterministic_symbol' })).toBe('symbol-node');

    db.prepare(`DELETE FROM knowledge_source_versions WHERE id = 'source-version-1'`).run();

    expect(graph.getGraphNode('project-1', 'symbol-node' as never)).toBeNull();
    expect(graph.findUniqueGraphNodeId('project-1', 'manual.ref')).toBe('manual-node');
  });


  it('updates an existing explicit-id node and removes an updated edge', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    graph.upsertGraphNode({ id: 'node-a' as never, projectId: 'project-1', nodeType: 'page', label: 'A' });
    graph.upsertGraphNode({
      id: 'node-a' as never,
      projectId: 'project-1',
      nodeType: 'page',
      label: 'A updated',
      qualifiedName: 'docs/A',
    });
    graph.upsertGraphNode({ id: 'node-b' as never, projectId: 'project-1', nodeType: 'page', label: 'B' });
    const firstEdge = graph.upsertGraphEdge({
      projectId: 'project-1',
      sourceNodeId: 'node-a' as never,
      targetNodeId: 'node-b' as never,
      edgeType: 'relates_to',
      evidence: 'semantic_relationship',
    });
    const secondEdge = graph.upsertGraphEdge({
      projectId: 'project-1',
      sourceNodeId: 'node-a' as never,
      targetNodeId: 'node-b' as never,
      edgeType: 'relates_to',
      evidence: 'provenance_overlap',
    });

    expect(firstEdge.id).toBe(secondEdge.id);
    expect(graph.getGraphNode('project-1', 'node-a' as never)?.label).toBe('A updated');
    expect(graph.listGraphEdges('project-1')).toHaveLength(1);
    expect(graph.removeGraphEdge('project-1', 'node-a' as never, 'node-b' as never, 'relates_to')).toBe(true);
    expect(graph.listGraphEdges('project-1')).toEqual([]);
  });

  it('rejects oversized or deeply nested provenance metadata without persisting partial edges', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    graph.upsertGraphNode({ id: 'node-a' as never, projectId: 'project-1', nodeType: 'page', label: 'A' });
    graph.upsertGraphNode({ id: 'node-b' as never, projectId: 'project-1', nodeType: 'page', label: 'B' });

    const deepMetadata = { relation: { level1: { level2: { level3: { level4: 'boom' } } } } } as never;
    expect(() =>
      graph.upsertGraphEdge({
        projectId: 'project-1',
        sourceNodeId: 'node-a' as never,
        targetNodeId: 'node-b' as never,
        edgeType: 'relates_to',
        evidence: 'explicit_link',
        provenance: [{ kind: 'source', id: 'source-1', sourceVersionId: 'source-version-1', metadata: deepMetadata }],
      }),
    ).toThrow(/provenance.*metadata/i);
    expect(graph.listGraphEdges('project-1')).toEqual([]);

    const wideContext = Array.from({ length: 70 }, (_, index) => `item-${index}`);
    expect(() =>
      graph.upsertGraphEdge({
        projectId: 'project-1',
        sourceNodeId: 'node-a' as never,
        targetNodeId: 'node-b' as never,
        edgeType: 'relates_to',
        evidence: 'explicit_link',
        provenance: [
          {
            kind: 'source',
            id: 'source-1',
            sourceVersionId: 'source-version-1',
            metadata: { context: wideContext } as never,
          },
        ],
      }),
    ).toThrow(/entry count/i);
    expect(graph.listGraphEdges('project-1')).toEqual([]);
  });

  it('fails contextual read paths for legacy metadata that exceeds recursion bounds', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    graph.upsertGraphNode({ id: 'node-a' as never, projectId: 'project-1', nodeType: 'page', label: 'A' });
    graph.upsertGraphNode({ id: 'node-b' as never, projectId: 'project-1', nodeType: 'page', label: 'B' });

    let nested = '"leaf"';
    for (let depth = 0; depth < 80; depth += 1) {
      nested = `{"level${depth}":${nested}}`;
    }
    db.prepare(
      `INSERT INTO knowledge_graph_edges
       (id, project_id, source_node_id, target_node_id, edge_type, evidence_json, confidence, created_at, updated_at)
       VALUES (?, 'project-1', 'node-a', 'node-b', 'relates_to', ?, 1, ?, ?)`,
    ).run(
      'legacy-edge',
      `{"evidence":["explicit_link"],"weight":1,"provenance":[{"kind":"source","id":"source-1","sourceVersionId":"source-version-1","metadata":{"context":${nested}}}]}`,
      '2026-09-24T00:00:00.000Z',
      '2026-09-24T00:00:00.000Z',
    );

    expect(() => graph.listGraphEdges('project-1')).toThrow(/legacy-edge|invalid stored evidence/i);
  });
});
