import { describe, expect, it } from 'vitest';
import {
  createDefaultAnalyzerRegistry,
  offsetToPosition,
  TextAnalyzer,
  validateDeterministicExtraction,
} from '../../../src/index.js';

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

describe('TextAnalyzer', () => {
  it('extracts bounded paragraph sections with exact CRLF source spans, stable IDs, and deterministic summaries', async () => {
    const analyzer = new TextAnalyzer();
    const input = buildInput();
    const result = await analyzer.analyze(input);

    expect(result.title).toBe('notes.txt');
    expect(result.summary).toBe('First paragraph.');
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toMatchObject({
      id: 'section:paragraph:1',
      kind: 'paragraph',
      text: 'First paragraph.',
      span: expectedSpan(input.content, 'First paragraph.'),
    });
    expect(result.sections[1]).toMatchObject({
      id: 'section:paragraph:2',
      kind: 'paragraph',
      text: 'Second paragraph line 1.\r\nSecond paragraph line 2.',
      span: expectedSpan(input.content, 'Second paragraph line 1.\r\nSecond paragraph line 2.'),
    });

    const rerun = await analyzer.analyze(input);
    expect(rerun).toEqual(result);
    expect(validateDeterministicExtraction(result)).toEqual(result);
  });

  it('preserves exact source positions for CR-only input', async () => {
    const analyzer = new TextAnalyzer();
    const content = 'Alpha\rBeta\r\rGamma';
    const result = await analyzer.analyze(buildInput({ content }));

    expect(result.summary).toBe('Alpha\rBeta');
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toMatchObject({
      text: 'Alpha\rBeta',
      span: expectedSpan(content, 'Alpha\rBeta'),
    });
    expect(result.sections[1]).toMatchObject({
      text: 'Gamma',
      span: expectedSpan(content, 'Gamma'),
    });
  });

  it('splits oversized plain-text sections at 80 lines or 2000 characters and truncates summaries to bounded excerpts', async () => {
    const analyzer = new TextAnalyzer();
    const longLine = 'A'.repeat(2105);
    const lineBounded = Array.from({ length: 81 }, (_, index) => `Line ${index + 1}`).join('\n');
    const content = `${longLine}\n\n${lineBounded}`;
    const result = await analyzer.analyze(buildInput({ content }));

    expect(result.summary).toBe('A'.repeat(280));
    expect(result.sections[0]).toMatchObject({
      id: 'section:paragraph:1',
      text: 'A'.repeat(2000),
      span: expectedSpan(content, 'A'.repeat(2000)),
    });
    expect(result.sections[1]).toMatchObject({
      id: 'section:paragraph:2',
      text: 'A'.repeat(105),
      span: expectedSpanFromOffsets(content, 2000, 2105),
    });
    expect(result.sections[2].text.split('\n')).toHaveLength(80);
    expect(result.sections[2].text.length).toBeLessThanOrEqual(2000);
    expect(result.sections[2].span).toMatchObject(expectedSpan(content, Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join('\n')));
    expect(result.sections[3]).toMatchObject({
      text: 'Line 81',
      span: expectedSpan(content, 'Line 81'),
    });
  });

  it('returns validator-safe empty results for empty and whitespace-only inputs without inventing summaries', async () => {
    const analyzer = new TextAnalyzer();

    const empty = await analyzer.analyze(buildInput({ content: '' }));
    expect(empty.summary).toBe('');
    expect(empty.sections).toEqual([]);
    expect(validateDeterministicExtraction(empty)).toEqual(empty);

    const whitespaceOnly = await analyzer.analyze(buildInput({ content: '  \r\n\t\r\n' }));
    expect(whitespaceOnly.summary).toBe('');
    expect(whitespaceOnly.sections).toEqual([]);
    expect(validateDeterministicExtraction(whitespaceOnly)).toEqual(whitespaceOnly);

    expect(() =>
      validateDeterministicExtraction({
        ...whitespaceOnly,
        summary: ' \r\n\t ',
      }),
    ).toThrow(/summary must be a non-empty string/i);
  });

  it('selects analyzers through the default registry by extension and MIME type', async () => {
    const registry = createDefaultAnalyzerRegistry();

    expect(registry.require({ sourcePath: 'README.md', mimeType: 'text/plain' }).id).toBe('markdown');
    expect(registry.require({ sourcePath: 'notes.txt', mimeType: 'text/plain' }).id).toBe('text');
    expect(() => registry.require({ sourcePath: 'image.png', mimeType: 'image/png' })).toThrow(/no deterministic analyzer/i);
  });
});
