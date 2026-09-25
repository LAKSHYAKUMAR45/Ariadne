import { describe, expect, it } from 'vitest';
import type { DeterministicExtraction } from '../../src/knowledge/KnowledgeExtraction.js';
import { buildDeterministicPagePayload } from '../../src/knowledge/DeterministicPageBuilder.js';

function createExtraction(): DeterministicExtraction {
  return {
    analyzerId: 'typescript-lezer',
    analyzerVersion: '2.1.0',
    sourceVersionId: 'source-version_123',
    title: 'src/weird-module.ts',
    summary: 'Summarizes `build|index` behavior without adding prose.',
    sections: [
      {
        id: 'section:overview',
        kind: 'heading',
        title: 'Overview | --- <script>alert(1)</script>',
        text: '### heading\n---\nconst value = "<tag>|pipe";\n',
        span: {
          startOffset: 0,
          endOffset: 44,
          startLine: 1,
          startColumn: 1,
          endLine: 3,
          endColumn: 28,
        },
        confidence: 1,
      },
      {
        id: 'section:body',
        kind: 'code',
        title: 'allocate_index_for_sg',
        text: 'function allocate_index_for_sg() {\n  return index;\n}\n',
        span: {
          startOffset: 45,
          endOffset: 98,
          startLine: 4,
          startColumn: 1,
          endLine: 6,
          endColumn: 2,
        },
        confidence: 1,
      },
    ],
    symbols: [
      {
        id: 'symbol:allocate',
        kind: 'function',
        name: 'allocate_index_for_sg',
        qualifiedName: 'src.weird-module.allocate_index_for_sg',
        signature: 'allocate_index_for_sg(): number | null',
        detail: 'Allocates a security group index.',
        span: {
          startOffset: 45,
          endOffset: 76,
          startLine: 4,
          startColumn: 1,
          endLine: 4,
          endColumn: 32,
        },
        confidence: 1,
      },
    ],
    relationships: [
      {
        id: 'relationship:calls',
        type: 'calls',
        fromId: 'symbol:allocate',
        targetReference: 'SecurityGroupIndex.lookup',
        detail: 'resolves dynamic target | maybe',
        span: {
          startOffset: 60,
          endOffset: 76,
          startLine: 4,
          startColumn: 16,
          endLine: 4,
          endColumn: 32,
        },
        confidence: 1,
      },
    ],
    links: [],
    diagnostics: [
      {
        code: 'parser-warning',
        message: 'Recovered from <script>broken</script> token.',
        severity: 'warning',
        span: {
          startOffset: 77,
          endOffset: 90,
          startLine: 5,
          startColumn: 3,
          endLine: 5,
          endColumn: 16,
        },
      },
    ],
  };
}

describe('buildDeterministicPagePayload', () => {
  it('builds deterministic source pages from normalized facts and safely escapes source-derived markdown', () => {
    const extraction = createExtraction();

    const payload = buildDeterministicPagePayload({
      projectId: 'project_1',
      sourceId: 'source_1',
      sourceVersionId: extraction.sourceVersionId,
      sourcePath: 'src/weird-module.ts',
      extraction,
    });

    expect(payload.generatorVersion).toBe('deterministic:typescript-lezer:2.1.0');
    expect(payload.pages).toHaveLength(1);
    expect(payload.pages[0]).toMatchObject({
      pageId: expect.any(String),
      type: 'source',
      title: 'src/weird-module.ts',
      summary: extraction.summary,
      sourceVersionIds: [extraction.sourceVersionId],
      confidence: 1,
      provenance: [
        expect.objectContaining({
          kind: 'source',
          id: 'source_1',
          path: 'src/weird-module.ts',
          sourceVersionId: extraction.sourceVersionId,
          startOffset: 0,
          startLine: 1,
          endOffset: 98,
          endLine: 6,
          endColumn: 2,
          confidence: 1,
        }),
      ],
    });
    expect(payload.pages[0]?.slug).toMatch(/^source-/);
    expect(payload.pages[0]?.content).toContain('Source version: `source-version\\_123`');
    expect(payload.pages[0]?.content).toContain('Analyzer: `typescript-lezer@2.1.0`');
    expect(payload.pages[0]?.content).toContain('Generator: `deterministic:typescript-lezer:2.1.0`');
    expect(payload.pages[0]?.content).toContain('## Symbols');
    expect(payload.pages[0]?.content).toContain('## Relationships');
    expect(payload.pages[0]?.content).toContain('## Diagnostics');
    expect(payload.pages[0]?.content).toContain('src/weird-module.ts:4:1-4:32');
    expect(payload.pages[0]?.content).toContain('SecurityGroupIndex.lookup');
    expect(payload.pages[0]?.content).toContain('&lt;script&gt;');
    expect(payload.pages[0]?.content).toContain('\\|');
    expect(payload.pages[0]?.content).not.toContain('<script>alert(1)</script>');
  });

  it('keeps page identity, slug, and rendered markdown stable across equivalent extraction orderings', () => {
    const extraction = createExtraction();
    const reversed: DeterministicExtraction = {
      ...extraction,
      sections: [...extraction.sections].reverse(),
      symbols: [...extraction.symbols].reverse(),
      relationships: [...extraction.relationships].reverse(),
      diagnostics: [...extraction.diagnostics].reverse(),
    };

    const first = buildDeterministicPagePayload({
      projectId: 'project_1',
      sourceId: 'source_1',
      sourceVersionId: extraction.sourceVersionId,
      sourcePath: 'src/weird-module.ts',
      extraction,
    });
    const second = buildDeterministicPagePayload({
      projectId: 'project_1',
      sourceId: 'source_1',
      sourceVersionId: extraction.sourceVersionId,
      sourcePath: 'src/weird-module.ts',
      extraction: reversed,
    });

    expect(second.pages[0]?.pageId).toBe(first.pages[0]?.pageId);
    expect(second.pages[0]?.slug).toBe(first.pages[0]?.slug);
    expect(second.pages[0]?.content).toBe(first.pages[0]?.content);
  });

  it('preserves the source-version suffix in slugs for very long source paths', () => {
    const extraction = createExtraction();
    const payload = buildDeterministicPagePayload({
      projectId: 'project_1',
      sourceId: 'source_1',
      sourceVersionId: extraction.sourceVersionId,
      sourcePath: `src/${'very-long-directory-name/'.repeat(12)}component.ts`,
      extraction,
    });

    expect(payload.pages[0]?.slug.endsWith(`-${extraction.sourceVersionId.slice(-8)}`)).toBe(true);
    expect(payload.pages[0]?.slug.length).toBeLessThanOrEqual(96);
  });

  it('derives top-level provenance from real extracted span bounds instead of fabricating source coverage', () => {
    const extraction = createExtraction();
    extraction.sections = [
      {
        ...extraction.sections[0]!,
        span: {
          startOffset: 12,
          endOffset: 44,
          startLine: 3,
          startColumn: 5,
          endLine: 4,
          endColumn: 20,
        },
      },
    ];
    extraction.symbols = [
      {
        ...extraction.symbols[0]!,
        span: {
          startOffset: 50,
          endOffset: 76,
          startLine: 6,
          startColumn: 2,
          endLine: 6,
          endColumn: 28,
        },
      },
    ];
    extraction.relationships = [
      {
        ...extraction.relationships[0]!,
        span: {
          startOffset: 81,
          endOffset: 99,
          startLine: 8,
          startColumn: 1,
          endLine: 8,
          endColumn: 19,
        },
      },
    ];
    extraction.diagnostics = [];

    const payload = buildDeterministicPagePayload({
      projectId: 'project_1',
      sourceId: 'source_1',
      sourceVersionId: extraction.sourceVersionId,
      sourcePath: 'src/weird-module.ts',
      extraction,
    });

    expect(payload.pages[0]?.provenance).toEqual([
      expect.objectContaining({
        kind: 'source',
        id: 'source_1',
        sourceVersionId: extraction.sourceVersionId,
        startOffset: 12,
        endOffset: 99,
        startLine: 3,
        startColumn: 5,
        endLine: 8,
        endColumn: 19,
      }),
    ]);
  });

  it('omits unavailable top-level provenance coordinates when no extracted spans exist', () => {
    const extraction = createExtraction();
    extraction.sections = [];
    extraction.symbols = [];
    extraction.relationships = [];
    extraction.diagnostics = [];

    const payload = buildDeterministicPagePayload({
      projectId: 'project_1',
      sourceId: 'source_1',
      sourceVersionId: extraction.sourceVersionId,
      sourcePath: 'src/weird-module.ts',
      extraction,
    });

    expect(payload.pages[0]?.provenance).toEqual([
      expect.not.objectContaining({
        startOffset: expect.anything(),
      }),
    ]);
    expect(payload.pages[0]?.provenance?.[0]).toEqual(
      expect.objectContaining({
        kind: 'source',
        id: 'source_1',
        sourceVersionId: extraction.sourceVersionId,
        confidence: 1,
      }),
    );
  });
});
