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
  return { db, graph: new KnowledgeGraph(db) };
}

describe('KnowledgeGraph', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('persists weighted evidence and provenance edges', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    graph.upsertGraphNode({ id: 'node-a' as never, projectId: 'project-1', nodeType: 'page', label: 'A' });
    graph.upsertGraphNode({ id: 'node-b' as never, projectId: 'project-1', nodeType: 'page', label: 'B' });
    const edge = graph.upsertGraphEdge({
      projectId: 'project-1',
      sourceNodeId: 'node-a' as never,
      targetNodeId: 'node-b' as never,
      edgeType: 'relates_to',
      evidence: ['explicit_link', 'shared_source'],
      weight: 0.75,
      confidence: 0.8,
      provenance: [{ kind: 'source', id: 'source-1', confidence: 0.9 }],
    });

    expect(edge.evidence).toEqual(['explicit_link', 'shared_source']);
    expect(edge.weight).toBe(0.75);
    expect(edge.provenance).toEqual([{ kind: 'source', id: 'source-1', confidence: 0.9 }]);
    expect(graph.scoreGraphEdge(edge)).toBeCloseTo(0.54);
  });

  it('rejects self loops and endpoints from another or missing project', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    graph.upsertGraphNode({ id: 'node-a' as never, projectId: 'project-1', nodeType: 'page', label: 'A' });
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
  });

  it('updates an existing edge and removes it', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    graph.upsertGraphNode({ id: 'node-a' as never, projectId: 'project-1', nodeType: 'page', label: 'A' });
    graph.upsertGraphNode({ id: 'node-b' as never, projectId: 'project-1', nodeType: 'page', label: 'B' });
    graph.upsertGraphEdge({
      id: 'edge-1',
      projectId: 'project-1',
      sourceNodeId: 'node-a' as never,
      targetNodeId: 'node-b' as never,
      edgeType: 'relates_to',
      evidence: 'semantic_relationship',
    });
    graph.upsertGraphEdge({
      id: 'edge-2',
      projectId: 'project-1',
      sourceNodeId: 'node-a' as never,
      targetNodeId: 'node-b' as never,
      edgeType: 'relates_to',
      evidence: 'provenance_overlap',
    });
    expect(graph.listGraphEdges('project-1')).toHaveLength(1);
    expect(graph.removeGraphEdge('project-1', 'node-a' as never, 'node-b' as never, 'relates_to')).toBe(true);
    expect(graph.listGraphEdges('project-1')).toEqual([]);
  });
});
