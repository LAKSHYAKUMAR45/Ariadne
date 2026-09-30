import { describe, expect, it } from 'vitest';
import {
  detectKnowledgeInsights,
  findContradictions,
  findOrphanPages,
  findSparseCommunities,
  findStalePages,
  persistKnowledgeInsights,
} from '../../../src/knowledge/graph/KnowledgeInsights.js';
import { detectKnowledgeCommunities, type KnowledgeGraphView } from '../../../src/knowledge/graph/KnowledgeCommunities.js';
import { openDatabase } from '../../../src/db.js';

describe('KnowledgeInsights', () => {
  it('finds sparse, orphan, contradiction, and stale evidence', () => {
    const graph: KnowledgeGraphView = {
      nodes: [
        { id: 'a', type: 'page', stale: true },
        { id: 'b', type: 'page' },
        { id: 'orphan', type: 'page' },
      ],
      edges: [{ id: 'ab', source: 'a', target: 'b', evidenceType: 'contradiction' }],
    };
    const communities = detectKnowledgeCommunities(graph);
    expect(findSparseCommunities(communities)).toHaveLength(1);
    expect(findOrphanPages(graph).map((item) => item.nodeIds)).toEqual([['orphan']]);
    expect(findContradictions(graph)[0].nodeIds).toEqual(['a', 'b']);
    expect(findStalePages(graph)).toHaveLength(1);
  });

  it('deduplicates persisted insights within a graph snapshot', () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at) VALUES ('p', '/w', 'p', 'now', 'now')`).run();
    db.prepare(`INSERT INTO knowledge_graph_snapshots (id, project_id, snapshot_number, content_hash, content_path, created_at) VALUES ('s', 'p', 1, 'h', 'snapshot.json', 'now')`).run();
    const insight = detectKnowledgeInsights({ nodes: [{ id: 'orphan', type: 'page' }], edges: [] });
    const first = persistKnowledgeInsights(db, 'p', 's', insight);
    const second = persistKnowledgeInsights(db, 'p', 's', insight);
    expect(second.map(({ id }) => id)).toEqual(first.map(({ id }) => id));
    expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_insights`).get()).toEqual({ count: first.length });
    db.close();
  });
});
