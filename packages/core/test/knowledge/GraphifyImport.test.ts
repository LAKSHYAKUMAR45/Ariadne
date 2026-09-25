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

  it('preserves zero-based object columns and rejects negative or fractional columns', () => {
    const zeroBased = importGraphifyJson({
      nodes: [{ id: 'a', path: 'src/a.ts' }, { id: 'b', path: 'src/b.ts' }],
      edges: [
        {
          source: 'a',
          target: 'b',
          relation: 'calls',
          source_file: 'src/a.ts',
          source_location: {
            startLine: 7,
            endLine: 7,
            startColumn: 0,
            endColumn: 0,
          },
        },
      ],
    });

    expect(zeroBased.edges[0]?.provenance).toEqual([
      {
        kind: 'file',
        id: 'src/a.ts',
        path: 'src/a.ts',
        startLine: 7,
        endLine: 7,
        startColumn: 0,
        endColumn: 0,
      },
    ]);

    const invalidColumns = importGraphifyJson({
      nodes: [{ id: 'a', path: 'src/a.ts' }, { id: 'b', path: 'src/b.ts' }],
      edges: [
        {
          source: 'a',
          target: 'b',
          relation: 'calls',
          source_file: 'src/a.ts',
          source_location: {
            startLine: 7,
            endLine: 7,
            startColumn: -1,
            endColumn: 0.5,
          },
        },
      ],
    });

    expect(invalidColumns.edges[0]).toMatchObject({
      provenance: [{ kind: 'file', id: 'src/a.ts', path: 'src/a.ts' }],
      metadata: {
        unparsedSourceLocation: {
          startLine: 7,
          endLine: 7,
          startColumn: -1,
          endColumn: 0.5,
        },
      },
    });
  });

  it('redacts secret-like diagnostics and drops unknown Graphify metadata keys', () => {
    const secretLikeContext = `Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456 ${'x'.repeat(700)}`;
    const result = importGraphifyJson({
      nodes: [{ id: 'a', path: 'src/a.ts' }, { id: 'b', path: 'src/b.ts' }],
      edges: [
        {
          source: 'a',
          target: 'b',
          relation: 'uses',
          source_file: 'src/a.ts',
          source_location: 'L8',
          context: secretLikeContext,
          original_rank: 4,
          ignored_payload: {
            nested: 'value',
          },
        },
      ],
    });

    expect(result.edges[0]?.metadata).toMatchObject({
      original: {
        original_rank: 4,
        relation: 'uses',
        source_file: 'src/a.ts',
        source_location: 'L8',
      },
      originalEdgeType: 'uses',
    });
    const original = (result.edges[0]?.metadata.original ?? {}) as Record<string, unknown>;
    expect(original.context).toEqual(expect.any(String));
    expect(String(original.context)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(String(original.context).length).toBeLessThanOrEqual(512);
    expect(original).not.toHaveProperty('ignored_payload');
  });

  it('drops prototype-pollution keys from parsed metadata without polluting output prototypes', () => {
    const result = importGraphifyJson(`{
      "nodes": [
        {
          "id": "a",
          "path": "src/a.ts",
          "attributes": {
            "__proto__": { "polluted": "node" },
            "items": [
              {
                "label": "kept",
                "constructor": { "prototype": { "polluted": "nested" } }
              }
            ]
          }
        },
        { "id": "b", "path": "src/b.ts" }
      ],
      "edges": [
        {
          "source": "a",
          "target": "b",
          "relation": "calls",
          "source_file": "src/a.ts",
          "source_location": "L3",
          "context": "helper()"
        }
      ]
    }`);

    const nodeMetadata = result.nodes[0]?.metadata as Record<string, unknown>;
    const attributes = nodeMetadata.attributes as Record<string, unknown>;
    const items = attributes.items as Array<Record<string, unknown>>;
    const edgeOriginal = (result.edges[0]?.metadata.original ?? {}) as Record<string, unknown>;

    expect(Object.getPrototypeOf(nodeMetadata)).toBeNull();
    expect(Object.getPrototypeOf(attributes)).toBeNull();
    expect(Object.getPrototypeOf(items[0] as object)).toBeNull();
    expect(Object.getPrototypeOf(edgeOriginal)).toBeNull();
    expect(items).toEqual([{ label: 'kept' }]);
    expect(attributes).not.toHaveProperty('__proto__');
    expect(({} as Record<string, unknown> & { polluted?: string }).polluted).toBeUndefined();
  });

  it('keeps edges when optional source_location is cyclic, deep, or oversized and records diagnostics', () => {
    const cyclicLocation: Record<string, unknown> = { marker: 'cycle' };
    cyclicLocation.self = cyclicLocation;

    let deepLocation: Record<string, unknown> = { value: 'leaf' };
    for (let depth = 0; depth < 8; depth += 1) {
      deepLocation = { nested: deepLocation };
    }

    const oversizedLocation = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`key${index}`, index]),
    );

    const result = importGraphifyJson({
      nodes: [
        { id: 'a', path: 'src/a.ts' },
        { id: 'b', path: 'src/b.ts' },
        { id: 'c', path: 'src/c.ts' },
        { id: 'd', path: 'src/d.ts' },
      ],
      edges: [
        {
          source: 'a',
          target: 'b',
          relation: 'calls',
          source_file: 'src/a.ts',
          source_location: cyclicLocation,
        },
        {
          source: 'a',
          target: 'c',
          relation: 'calls',
          source_file: 'src/a.ts',
          source_location: deepLocation,
        },
        {
          source: 'a',
          target: 'd',
          relation: 'calls',
          source_file: 'src/a.ts',
          source_location: oversizedLocation,
        },
      ],
    });

    expect(result.rejectedEdges).toEqual([]);
    expect(result.edges).toHaveLength(3);
    for (const edge of result.edges) {
      expect(edge.provenance).toEqual([{ kind: 'file', id: 'src/a.ts', path: 'src/a.ts' }]);
      expect(edge.metadata).toMatchObject({
        sourceLocationDiagnostic: expect.stringMatching(/source_location omitted/i),
      });
      expect(edge.metadata).not.toHaveProperty('unparsedSourceLocation');
    }
  });
});
