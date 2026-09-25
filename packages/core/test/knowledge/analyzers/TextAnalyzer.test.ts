import { describe, expect, it } from 'vitest';
import { createDefaultAnalyzerRegistry, TextAnalyzer } from '../../../src/knowledge/analyzers/index.js';

function buildInput(overrides: Partial<Parameters<TextAnalyzer['analyze']>[0]> = {}): Parameters<TextAnalyzer['analyze']>[0] {
  return {
    sourceVersionId: 'source-version_text',
    sourceKind: 'file',
    sourcePath: 'docs/notes.txt',
    mimeType: 'text/plain',
    content: 'First paragraph.\r\n\r\nSecond paragraph line 1.\r\nSecond paragraph line 2.\r\n',
    ...overrides,
  };
}

describe('TextAnalyzer', () => {
  it('extracts bounded paragraph sections with normalized newlines, exact spans, stable IDs, and deterministic summaries', async () => {
    const analyzer = new TextAnalyzer();
    const result = await analyzer.analyze(buildInput());

    expect(result.title).toBe('notes.txt');
    expect(result.summary).toBe('First paragraph.');
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toMatchObject({
      id: 'section:paragraph:1',
      kind: 'paragraph',
      text: 'First paragraph.',
      span: {
        startOffset: 0,
        endOffset: 16,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 17,
      },
    });
    expect(result.sections[1]).toMatchObject({
      id: 'section:paragraph:2',
      kind: 'paragraph',
      text: 'Second paragraph line 1.\nSecond paragraph line 2.',
      span: {
        startOffset: 18,
        endOffset: 67,
        startLine: 3,
        startColumn: 1,
        endLine: 4,
        endColumn: 25,
      },
    });

    const rerun = await analyzer.analyze(buildInput());
    expect(rerun).toEqual(result);
  });

  it('splits oversized plain-text sections at 80 lines or 2000 characters and truncates summaries to bounded excerpts', async () => {
    const analyzer = new TextAnalyzer();
    const longLine = 'A'.repeat(2105);
    const lineBounded = Array.from({ length: 81 }, (_, index) => `Line ${index + 1}`).join('\n');
    const result = await analyzer.analyze(
      buildInput({
        content: `${longLine}\n\n${lineBounded}`,
      }),
    );

    expect(result.summary).toBe('A'.repeat(280));
    expect(result.sections[0]).toMatchObject({
      id: 'section:paragraph:1',
      text: 'A'.repeat(2000),
      span: {
        startLine: 1,
        endLine: 1,
        endColumn: 2001,
      },
    });
    expect(result.sections[1]).toMatchObject({
      id: 'section:paragraph:2',
      text: 'A'.repeat(105),
      span: {
        startLine: 1,
        startColumn: 2001,
        endLine: 1,
        endColumn: 2106,
      },
    });
    expect(result.sections[2].span).toMatchObject({
      startLine: 3,
      endLine: 82,
    });
    expect(result.sections[2].text.split('\n')).toHaveLength(80);
    expect(result.sections[3]).toMatchObject({
      text: 'Line 81',
      span: {
        startLine: 83,
        startColumn: 1,
        endLine: 83,
        endColumn: 8,
      },
    });
  });

  it('selects analyzers through the default registry by extension and MIME type', async () => {
    const registry = createDefaultAnalyzerRegistry();

    expect(registry.require({ sourcePath: 'README.md', mimeType: 'text/plain' }).id).toBe('markdown');
    expect(registry.require({ sourcePath: 'notes.txt', mimeType: 'text/plain' }).id).toBe('text');
    expect(() => registry.require({ sourcePath: 'image.png', mimeType: 'image/png' })).toThrow(/no deterministic analyzer/i);
  });
});
