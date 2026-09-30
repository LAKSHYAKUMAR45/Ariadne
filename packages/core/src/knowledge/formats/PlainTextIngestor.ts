import { normalizeKnowledgePath } from '../KnowledgeIds.js';
import type { ExtractedSource, IngestInput, KnowledgeIngestor } from './IngestTypes.js';
import { baseExtraction } from './IngestTypes.js';

function normalizePlainText(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class PlainTextIngestor implements KnowledgeIngestor {
  supports(input: IngestInput): boolean {
    const path = input.path?.toLowerCase();
    return !path || /\.(txt|text|log|rst|csv|json|ya?ml|toml|ini|cfg|conf)$/.test(path);
  }

  async extract(input: IngestInput): Promise<ExtractedSource> {
    if (input.path) normalizeKnowledgePath(input.path);
    const result = baseExtraction(input, normalizePlainText(input.content));
    result.normalizedText = result.text;

    const paragraphPattern = /(?:^|(?:\r?\n){2,})[ \t]*(\S(?:.*?\S)?)[ \t]*(?=(?:\r?\n){2,}|$)/gs;
    for (const match of input.content.matchAll(paragraphPattern)) {
      const text = match[1];
      const startOffset = (match.index ?? 0) + (match[0].indexOf(text));
      result.spans.push({ label: 'paragraph', text, startOffset, endOffset: startOffset + text.length });
    }
    return result;
  }
}
