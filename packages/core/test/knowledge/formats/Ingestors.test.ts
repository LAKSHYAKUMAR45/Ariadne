import { describe, expect, it } from 'vitest';
import {
  CodeIngestor,
  MarkdownIngestor,
  PlainTextIngestor,
  TaskHistoryIngestor,
} from '../../../src/knowledge/formats/index.js';

describe('deterministic knowledge ingestors', () => {
  it('extracts markdown headings, links, and source offsets', async () => {
    const input = { path: 'docs/guide.md', content: '# Guide\n\nSee [architecture](architecture.md).\n' };
    const result = await new MarkdownIngestor().extract(input);

    expect(result.text).toBe(input.content);
    expect(result.headings).toEqual([{ level: 1, text: 'Guide', startOffset: 0, endOffset: 7 }]);
    expect(result.links).toEqual([
      { text: 'architecture', target: 'architecture.md', startOffset: 13, endOffset: 44 },
    ]);
    expect(result.spans).toContainEqual(expect.objectContaining({ label: 'heading', startOffset: 0 }));
  });

  it('extracts deterministic symbols and paths from code', async () => {
    const content = 'export function greet(name: string) {\n  return name;\n}\n';
    const result = await new CodeIngestor().extract({ path: 'src/greet.ts', content });

    expect(result.metadata.language).toBe('typescript');
    expect(result.metadata.symbols).toEqual(['greet']);
    expect(result.metadata.paths).toEqual([]);
    expect(result.spans).toContainEqual(expect.objectContaining({ label: 'symbol', text: 'greet' }));
  });

  it('normalizes plain text without losing evidence offsets', async () => {
    const result = await new PlainTextIngestor().extract({ path: 'notes.txt', content: ' first line \r\n\r\nsecond line ' });

    expect(result.text).toBe('first line\n\nsecond line');
    expect(result.spans).toEqual([
      expect.objectContaining({ label: 'paragraph', text: 'first line', startOffset: 1 }),
      expect.objectContaining({ label: 'paragraph', text: 'second line', startOffset: 16 }),
    ]);
  });

  it('extracts Ariadne task entities from task history', async () => {
    const result = await new TaskHistoryIngestor().extract({
      path: '.ariadne/task-history.json',
      content: JSON.stringify({
        task: { id: 'task-1', title: 'Build wiki', goal: 'Capture knowledge' },
        checkpoints: [{ id: 'checkpoint-1', summary: 'Defined ingestion contracts' }],
        decisions: [{ id: 'decision-1', text: 'Use deterministic parsers' }],
      }),
    });

    expect(result.metadata.entities).toEqual([
      { kind: 'task', id: 'task-1', label: 'Build wiki' },
      { kind: 'checkpoint', id: 'checkpoint-1', label: 'Defined ingestion contracts' },
      { kind: 'decision', id: 'decision-1', label: 'Use deterministic parsers' },
    ]);
    expect(result.provenance).toContainEqual(expect.objectContaining({ kind: 'task', id: 'task-1' }));
  });

  it('handles unicode, empty input, malformed markdown, and traversal attempts deterministically', async () => {
    const markdown = await new MarkdownIngestor().extract({ path: 'docs/日本語.md', content: '## Café\n[bad' });
    const empty = await new PlainTextIngestor().extract({ path: 'empty.txt', content: '' });

    expect(markdown.headings[0]?.text).toBe('Café');
    expect(markdown.links).toEqual([]);
    expect(empty.text).toBe('');
    await expect(new PlainTextIngestor().extract({ path: '../secret.txt', content: 'nope' })).rejects.toThrow(
      'Knowledge path must stay within the workspace',
    );
  });
});
