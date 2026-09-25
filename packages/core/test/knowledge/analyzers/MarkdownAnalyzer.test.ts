import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarkdownAnalyzer } from '../../../src/knowledge/analyzers/index.js';

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'test/knowledge/fixtures/markdown', name), 'utf8');
}

describe('MarkdownAnalyzer', () => {
  it('extracts deterministic headings, paragraphs, code blocks, links, wikilinks, stable duplicate heading IDs, and exact spans', async () => {
    const analyzer = new MarkdownAnalyzer();
    const result = await analyzer.analyze({
      sourceVersionId: 'source-version_markdown',
      sourceKind: 'file',
      sourcePath: 'docs/architecture.md',
      mimeType: 'text/markdown',
      content: fixture('architecture.md'),
    });

    expect(result.title).toBe('architecture.md');
    expect(result.summary).toBe('Platform overview with [RFC](https://example.com/rfc) and [[Runbook]].');

    const headings = result.sections.filter((section) => section.kind === 'heading');
    expect(headings.map((section) => ({ id: section.id, title: section.title }))).toEqual([
      { id: 'section:heading:architecture', title: 'Architecture' },
      { id: 'section:heading:components', title: 'Components' },
      { id: 'section:heading:worker', title: 'Worker' },
      { id: 'section:heading:components-2', title: 'Components' },
    ]);
    expect(headings[0]).toMatchObject({
      text: '# Architecture',
      span: {
        startOffset: 0,
        endOffset: 14,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 15,
      },
    });

    expect(result.sections).toContainEqual(
      expect.objectContaining({
        id: 'section:paragraph:3',
        kind: 'paragraph',
        text: 'Platform overview with [RFC](https://example.com/rfc) and [[Runbook]].',
        span: expect.objectContaining({
          startLine: 3,
          startColumn: 1,
          endLine: 3,
          endColumn: 71,
        }),
      }),
    );
    expect(result.sections).toContainEqual(
      expect.objectContaining({
        id: 'section:code:13',
        kind: 'code',
        title: 'ts',
        text: '```ts\nconst worker = createWorker();\n```',
        span: expect.objectContaining({
          startLine: 13,
          startColumn: 1,
          endLine: 15,
          endColumn: 4,
        }),
      }),
    );

    expect(result.links).toEqual([
      expect.objectContaining({
        id: 'link:3:24',
        target: 'https://example.com/rfc',
        title: 'RFC',
        span: expect.objectContaining({
          startLine: 3,
          startColumn: 24,
          endLine: 3,
          endColumn: 54,
        }),
      }),
      expect.objectContaining({
        id: 'link:3:59',
        target: 'Runbook',
        title: 'Runbook',
        span: expect.objectContaining({
          startLine: 3,
          startColumn: 59,
          endLine: 3,
          endColumn: 70,
        }),
      }),
    ]);

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'relationship:contains:section:heading:architecture->section:heading:components',
          type: 'contains',
          fromId: 'section:heading:architecture',
          toId: 'section:heading:components',
        }),
        expect.objectContaining({
          id: 'relationship:contains:section:heading:components->section:heading:worker',
          type: 'contains',
          fromId: 'section:heading:components',
          toId: 'section:heading:worker',
        }),
        expect.objectContaining({
          id: 'relationship:links_to:section:paragraph:3->section:link:3:24',
          type: 'links_to',
          fromId: 'section:paragraph:3',
          toId: 'section:link:3:24',
        }),
        expect.objectContaining({
          id: 'relationship:links_to:section:paragraph:3->section:wikilink:3:59',
          type: 'links_to',
          fromId: 'section:paragraph:3',
          toId: 'section:wikilink:3:59',
        }),
      ]),
    );

    const rerun = await analyzer.analyze({
      sourceVersionId: 'source-version_markdown',
      sourceKind: 'file',
      sourcePath: 'docs/architecture.md',
      mimeType: 'text/markdown',
      content: fixture('architecture.md'),
    });
    expect(rerun).toEqual(result);
  });
});
