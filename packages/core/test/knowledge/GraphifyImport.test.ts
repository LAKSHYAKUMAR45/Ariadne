import { describe, expect, it } from 'vitest';
import { importGraphifyJson } from '../../src/knowledge/GraphifyImport.js';

describe('GraphifyImport', () => {
  it('normalizes safe paths and labels inferred edges explicitly', () => {
    const result = importGraphifyJson({
      nodes: [
        { id: 'a', type: 'file', path: './src\\main.ts', name: 'main' },
        { id: 'b', type: 'file', path: 'docs/README.md', name: 'readme' },
      ],
      edges: [{ source: 'a', target: 'b', type: 'uses', inferred: true }],
    });
    expect(result.nodes[0].path).toBe('src/main.ts');
    expect(result.edges[0]).toMatchObject({
      edgeType: 'inferred:uses',
      evidence: 'semantic_relationship',
      inferred: true,
    });
  });

  it('rejects invalid endpoints, self loops, and traversal paths', () => {
    const result = importGraphifyJson(
      JSON.stringify({
        nodes: [{ id: 'a', path: '../secret' }],
        edges: [
          { source: 'a', target: 'missing' },
          { source: 'a', target: 'a' },
        ],
      }),
    );
    expect(result.nodes[0].path).toBeNull();
    expect(result.edges).toHaveLength(0);
    expect(result.rejectedEdges).toHaveLength(2);
  });
});
