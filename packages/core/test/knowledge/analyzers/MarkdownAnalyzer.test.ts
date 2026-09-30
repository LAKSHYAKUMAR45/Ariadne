import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarkdownAnalyzer, offsetToPosition, validateDeterministicExtraction } from '../../../src/index.js';

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'test/knowledge/fixtures/markdown', name), 'utf8');
}

function expectedSpan(content: string, snippet: string, occurrence = 1) {
  let startOffset = -1;
  let searchFrom = 0;
  for (let index = 0; index < occurrence; index += 1) {
    startOffset = content.indexOf(snippet, searchFrom);
    if (startOffset === -1) {
      throw new Error(`Could not find occurrence ${occurrence} of snippet: ${snippet}`);
    }
    searchFrom = startOffset + 1;
  }
  const endOffset = startOffset + snippet.length;
  const start = offsetToPosition(content, startOffset);
  const end = offsetToPosition(content, endOffset);
  return {
    startOffset,
    endOffset,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function expectedSpanFromOffsets(content: string, startOffset: number, endOffset: number) {
  const start = offsetToPosition(content, startOffset);
  const end = offsetToPosition(content, endOffset);
  return {
    startOffset,
    endOffset,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

describe('MarkdownAnalyzer', () => {
  it('extracts deterministic headings, paragraphs, code blocks, links, wikilinks, stable duplicate heading IDs, and exact spans', async () => {
    const analyzer = new MarkdownAnalyzer();
    const content = fixture('architecture.md');
    const result = await analyzer.analyze({
      sourceVersionId: 'source-version_markdown',
      sourceKind: 'file',
      sourcePath: 'docs/architecture.md',
      mimeType: 'text/markdown',
      content,
    });

    expect(result.title).toBe('architecture.md');
    expect(result.summary).toBe('# Architecture');

    const headings = result.sections.filter((section) => section.kind === 'heading');
    expect(headings.map((section) => ({ id: section.id, title: section.title }))).toEqual([
      { id: 'section:heading:architecture', title: 'Architecture' },
      { id: 'section:heading:components', title: 'Components' },
      { id: 'section:heading:worker', title: 'Worker' },
      { id: 'section:heading:components-2', title: 'Components' },
    ]);
    expect(headings[0]).toMatchObject({
      text: '# Architecture',
      span: expectedSpan(content, '# Architecture'),
    });

    expect(result.sections).toContainEqual(
      expect.objectContaining({
        id: 'section:paragraph:3',
        kind: 'paragraph',
        text: 'Platform overview with [RFC](https://example.com/rfc) and [[Runbook]].',
        span: expectedSpan(content, 'Platform overview with [RFC](https://example.com/rfc) and [[Runbook]].'),
      }),
    );
    expect(result.sections).toContainEqual(
      expect.objectContaining({
        id: 'section:code:13',
        kind: 'code',
        title: 'ts',
        text: '```ts\nconst worker = createWorker();\n```',
        span: expectedSpan(content, '```ts\nconst worker = createWorker();\n```'),
      }),
    );

    expect(result.links).toEqual([
      expect.objectContaining({
        id: 'link:3:24',
        target: 'https://example.com/rfc',
        title: 'RFC',
        span: expectedSpan(content, '[RFC](https://example.com/rfc)'),
      }),
      expect.objectContaining({
        id: 'link:3:59',
        target: 'Runbook',
        title: 'Runbook',
        span: expectedSpan(content, '[[Runbook]]'),
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
      content,
    });
    expect(rerun).toEqual(result);
    expect(validateDeterministicExtraction(result)).toEqual(result);
  });

  it('preserves exact CRLF spans for Markdown paragraphs and lists', async () => {
    const analyzer = new MarkdownAnalyzer();
    const content = ['# Heading', '', 'Paragraph line 1', 'Paragraph line 2', '', '- item 1', '- item 2', ''].join('\r\n');
    const result = await analyzer.analyze({
      sourceVersionId: 'markdown-crlf',
      sourceKind: 'file',
      sourcePath: 'docs/crlf.md',
      mimeType: 'text/markdown',
      content,
    });

    expect(result.summary).toBe('# Heading');
    expect(result.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'section:heading:heading', span: expectedSpan(content, '# Heading') }),
        expect.objectContaining({
          id: 'section:paragraph:3',
          text: 'Paragraph line 1\r\nParagraph line 2',
          span: expectedSpan(content, 'Paragraph line 1\r\nParagraph line 2'),
        }),
        expect.objectContaining({
          id: 'section:list:6',
          text: '- item 1\r\n- item 2',
          span: expectedSpan(content, '- item 1\r\n- item 2'),
        }),
      ]),
    );
  });

  it('splits oversized Markdown paragraphs and lists into bounded deterministic sections', async () => {
    const analyzer = new MarkdownAnalyzer();
    const longParagraph = 'P'.repeat(2050);
    const listLines = Array.from({ length: 81 }, (_, index) => `- item ${index + 1}`);
    const content = ['# Oversized', '', longParagraph, '', ...listLines].join('\n');
    const result = await analyzer.analyze({
      sourceVersionId: 'markdown-oversized',
      sourceKind: 'file',
      sourcePath: 'docs/oversized.md',
      mimeType: 'text/markdown',
      content,
    });

    const paragraphSections = result.sections.filter((section) => section.kind === 'paragraph');
    expect(paragraphSections.map((section) => section.id)).toEqual(['section:paragraph:3', 'section:paragraph:3:2']);
    expect(paragraphSections[0]).toMatchObject({
      text: 'P'.repeat(2000),
      span: expectedSpan(content, 'P'.repeat(2000)),
    });
    expect(paragraphSections[1]).toMatchObject({
      text: 'P'.repeat(50),
      span: expectedSpanFromOffsets(content, content.indexOf(longParagraph) + 2000, content.indexOf(longParagraph) + 2050),
    });

    const listSections = result.sections.filter((section) => section.kind === 'list');
    expect(listSections.map((section) => section.id)).toEqual(['section:list:5', 'section:list:5:2']);
    expect(listSections[0].text.split('\n')).toHaveLength(80);
    expect(listSections[0].text.length).toBeLessThanOrEqual(2000);
    expect(listSections[0].span).toMatchObject(expectedSpan(content, listLines.slice(0, 80).join('\n')));
    expect(listSections[1]).toMatchObject({
      text: '- item 81',
      span: expectedSpan(content, '- item 81'),
    });

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'relationship:contains:section:heading:oversized->section:paragraph:3',
          fromId: 'section:heading:oversized',
          toId: 'section:paragraph:3',
        }),
        expect.objectContaining({
          id: 'relationship:contains:section:heading:oversized->section:paragraph:3:2',
          fromId: 'section:heading:oversized',
          toId: 'section:paragraph:3:2',
        }),
        expect.objectContaining({
          id: 'relationship:contains:section:heading:oversized->section:list:5',
          fromId: 'section:heading:oversized',
          toId: 'section:list:5',
        }),
        expect.objectContaining({
          id: 'relationship:contains:section:heading:oversized->section:list:5:2',
          fromId: 'section:heading:oversized',
          toId: 'section:list:5:2',
        }),
      ]),
    );
  });

  it('returns validator-safe results for empty, whitespace-only, and heading-only inputs', async () => {
    const analyzer = new MarkdownAnalyzer();

    const empty = await analyzer.analyze({
      sourceVersionId: 'markdown-empty',
      sourceKind: 'file',
      sourcePath: 'docs/empty.md',
      mimeType: 'text/markdown',
      content: '',
    });
    expect(empty.summary).toBe('');
    expect(empty.sections).toEqual([]);
    expect(validateDeterministicExtraction(empty)).toEqual(empty);

    const whitespaceOnly = await analyzer.analyze({
      sourceVersionId: 'markdown-whitespace',
      sourceKind: 'file',
      sourcePath: 'docs/whitespace.md',
      mimeType: 'text/markdown',
      content: '  \r\n\t\r\n',
    });
    expect(whitespaceOnly.summary).toBe('');
    expect(whitespaceOnly.sections).toEqual([]);
    expect(validateDeterministicExtraction(whitespaceOnly)).toEqual(whitespaceOnly);

    const headingOnly = await analyzer.analyze({
      sourceVersionId: 'markdown-heading-only',
      sourceKind: 'file',
      sourcePath: 'docs/heading-only.md',
      mimeType: 'text/markdown',
      content: '# Heading Only',
    });
    expect(headingOnly.summary).toBe('# Heading Only');
    expect(headingOnly.sections).toEqual([
      expect.objectContaining({
        id: 'section:heading:heading-only',
        text: '# Heading Only',
      }),
    ]);
    expect(validateDeterministicExtraction(headingOnly)).toEqual(headingOnly);
  });

  it('ignores link-like text inside fenced code blocks', async () => {
    const analyzer = new MarkdownAnalyzer();
    const content = [
      '# Example',
      '',
      '```ts',
      'const ignored = "[RFC](https://example.com/rfc) and [[Runbook]]";',
      '```',
      '',
      'Outside [Real Link](https://example.com/live).',
    ].join('\n');
    const result = await analyzer.analyze({
      sourceVersionId: 'markdown-code-fence',
      sourceKind: 'file',
      sourcePath: 'docs/code-fence.md',
      mimeType: 'text/markdown',
      content,
    });

    expect(result.links).toEqual([
      expect.objectContaining({ target: 'https://example.com/live', title: 'Real Link' }),
    ]);
    expect(result.sections.filter((section) => section.kind === 'link' || section.kind === 'wikilink')).toHaveLength(1);
  });

  it('preserves markdown links when a long single-line paragraph is split at the size bound', async () => {
    const analyzer = new MarkdownAnalyzer();
    const linkMarkup = '[RFC](https://example.com/rfc)';
    const content = `# Oversized\n\n${'P'.repeat(1988)}${linkMarkup}`;
    const result = await analyzer.analyze({
      sourceVersionId: 'markdown-split-link',
      sourceKind: 'file',
      sourcePath: 'docs/split-link.md',
      mimeType: 'text/markdown',
      content,
    });

    expect(result.sections.filter((section) => section.kind === 'paragraph').map((section) => section.id)).toEqual([
      'section:paragraph:3',
      'section:paragraph:3:2',
    ]);
    expect(result.links).toEqual([
      expect.objectContaining({
        target: 'https://example.com/rfc',
        title: 'RFC',
      }),
    ]);
  });
});
