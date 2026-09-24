import { describe, expect, it } from 'vitest';
import {
  detectKnowledgeCommunities,
  findBridgeNodes,
  scoreCommunityCohesion,
  type KnowledgeGraphView,
} from '../../../src/knowledge/graph/KnowledgeCommunities.js';

const graph: KnowledgeGraphView = {
  nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, type: 'page' })),
  edges: [
    { id: 'ab', source: 'a', target: 'b', weight: 1 },
    { id: 'bc', source: 'b', target: 'c', weight: 1 },
    { id: 'cd', source: 'c', target: 'd', weight: 1 },
  ],
};

describe('KnowledgeCommunities', () => {
  it('returns deterministic connected communities and cohesion', () => {
    const first = detectKnowledgeCommunities(graph);
    expect(detectKnowledgeCommunities({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() })).toEqual(first);
    expect(first).toHaveLength(2);
    expect(first[0].nodeIds).toEqual(['a', 'b', 'c', 'd']);
    expect(scoreCommunityCohesion(first[0], graph)).toBeCloseTo(0.5);
  });

  it('identifies nodes bridging otherwise separate communities', () => {
    const communities = detectKnowledgeCommunities(graph);
    expect(findBridgeNodes(graph, communities).map(({ nodeId }) => nodeId)).toContain('c');
  });
});
