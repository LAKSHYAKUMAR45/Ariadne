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
  const graph = new KnowledgeGraph(db);
  for (const id of ['a', 'b', 'c', 'd']) {
    graph.upsertGraphNode({ id: id as never, projectId: 'project-1', nodeType: 'page', label: id });
  }
  const add = (sourceNodeId: string, targetNodeId: string): void => {
    graph.upsertGraphEdge({
      projectId: 'project-1',
      sourceNodeId: sourceNodeId as never,
      targetNodeId: targetNodeId as never,
      edgeType: 'link',
      evidence: 'explicit_link',
    });
  };
  add('a', 'b');
  add('b', 'c');
  add('c', 'a');
  add('c', 'd');
  return { db, graph };
}

describe('KnowledgeGraph traversal', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('finds bounded directed paths deterministically', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    expect(graph.findGraphPath('a' as never, 'd' as never, { maxHops: 2 })).toBeNull();
    expect(graph.findGraphPath('a' as never, 'd' as never, { maxHops: 3 })?.nodeIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('supports undirected neighborhoods and node budgets', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    const neighborhood = graph.getGraphNeighborhood('d' as never, {
      directed: false,
      maxHops: 2,
      maxNodes: 2,
    });
    expect(neighborhood.nodes.map((node) => node.id)).toEqual(['c', 'd']);
    expect(neighborhood.truncated).toBe(true);
  });

  it('returns null for disconnected nodes', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    expect(graph.findGraphPath('d' as never, 'a' as never, { directed: true, maxHops: 2 })).toBeNull();
  });

  it('traverses across legacy edges with sanitized nested metadata', () => {
    const { db, graph } = createGraph();
    databases.push(db);
    db.prepare(
      `INSERT INTO knowledge_graph_edges
       (id, project_id, source_node_id, target_node_id, edge_type, evidence_json, confidence, created_at, updated_at)
       VALUES (?, 'project-1', 'a', 'd', 'link', ?, 1, ?, ?)`,
    ).run(
      'legacy-traversal-edge',
      JSON.stringify({
        evidence: ['explicit_link'],
        weight: 1,
        provenance: [
          {
            kind: 'file',
            id: 'docs/a.md',
            path: 'docs/a.md',
            metadata: {
              nested: {
                branch: [{ label: 'kept' }],
              },
              prototype: { polluted: 'nope' },
            },
          },
        ],
      }),
      '2026-09-24T00:00:00.000Z',
      '2026-09-24T00:00:00.000Z',
    );

    const path = graph.findGraphPath('a' as never, 'd' as never, { maxHops: 1 });

    expect(path?.nodeIds).toEqual(['a', 'd']);
    expect(path?.edges[0]?.provenance[0]?.metadata).toMatchObject({
      nested: {
        branch: [{ label: 'kept' }],
      },
    });
    expect(Object.getPrototypeOf((path?.edges[0]?.provenance[0] ?? {}) as object)).toBeNull();
    expect(path?.edges[0]?.provenance[0]?.metadata).not.toHaveProperty('prototype');
    expect(path?.edges[0]?.provenance[0]).not.toHaveProperty('prototype');
  });
});
