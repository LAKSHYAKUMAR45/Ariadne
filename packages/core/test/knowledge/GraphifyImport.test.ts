import { describe, expect, it } from 'vitest';
import { importGraphifyJson } from '../../src/knowledge/GraphifyImport.js';

describe('GraphifyImport', () => {
  it('preserves native relation precedence and maps provenance defensively', () => {
    const result = importGraphifyJson({
      nodes: [
        { id: 'a', type: 'file', path: './src\\main.ts', name: 'main' },
        { id: 'b', type: 'symbol', path: 'src/helper.ts', name: 'helper' },
      ],
      edges: [
        {
          source: 'a',
          target: 'b',
          edgeType: 'references',
          relation: 'calls',
          type: 'uses',
          label: 'mentions',
          source_file: 'src/main.ts',
          source_location: 'L216-L227',
          context: 'helper()',
          inferred: true,
          confidence: 0.4,
          original_rank: 3,
        },
      ],
    });

    expect(result.nodes[0].path).toBe('src/main.ts');
    expect(result.edges[0]).toMatchObject({
      edgeType: 'references',
      evidence: 'semantic_relationship',
      inferred: true,
      confidence: 0.4,
      provenance: [
        {
          kind: 'file',
          id: 'src/main.ts',
          path: 'src/main.ts',
          startLine: 216,
          endLine: 227,
        },
      ],
    });
    expect(result.edges[0].metadata).toMatchObject({
      original: {
        context: 'helper()',
        original_rank: 3,
        source_file: 'src/main.ts',
        source_location: 'L216-L227',
      },
    });
  });

  it('preserves additional known native edge types and rejects malformed JSON defensively', () => {
    const supported = importGraphifyJson({
      nodes: [{ id: 'a', path: 'docs/a.md' }, { id: 'b', path: 'docs/b.md' }],
      edges: [{ source: 'a', target: 'b', edgeType: 'uses', relation: 'supports' }],
    });

    expect(supported.edges[0]?.edgeType).toBe('supports');
    expect(() => importGraphifyJson('{')).toThrow(/valid JSON/);
  });


  it('falls back unknown relation types and refuses to invent malformed provenance', () => {
    const result = importGraphifyJson({
      nodes: [
        { id: 'a', path: 'file://etc/passwd' },
        { id: 'b', path: 'docs/README.md' },
      ],
      links: [
        {
          source: 'a',
          target: 'b',
          relation: 'uses',
          source_file: 'docs/README.md',
          source_location: 'L10-L2',
          context: 'bad location',
        },
        { source: 'a', target: 'missing' },
        { source: 'a', target: 'a' },
      ],
    });

    expect(result.nodes[0].path).toBeNull();
    expect(result.edges[0]).toMatchObject({
      edgeType: 'related_to',
      evidence: 'explicit_link',
      inferred: false,
      provenance: [{ kind: 'file', id: 'docs/README.md', path: 'docs/README.md' }],
      metadata: {
        original: {
          context: 'bad location',
          relation: 'uses',
          source_file: 'docs/README.md',
          source_location: 'L10-L2',
        },
        originalEdgeType: 'uses',
        unparsedSourceLocation: 'L10-L2',
      },
    });
    expect(result.rejectedEdges).toHaveLength(2);
  });
});
