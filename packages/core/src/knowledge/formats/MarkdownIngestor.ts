import { normalizeKnowledgePath } from '../KnowledgeIds.js';
import type { ExtractedSource, IngestInput, KnowledgeIngestor } from './IngestTypes.js';
import { baseExtraction } from './IngestTypes.js';

export class MarkdownIngestor implements KnowledgeIngestor {
  supports(input: IngestInput): boolean {
    return input.path === undefined || /\.(md|markdown|mdown|mkdn)$/i.test(input.path);
  }

  async extract(input: IngestInput): Promise<ExtractedSource> {
    if (input.path) normalizeKnowledgePath(input.path);
    const text = input.content.replace(/\r\n?/g, '\n');
    const sourceText = input.content;
    const result = baseExtraction(input, text);
    result.normalizedText = text;

    for (const match of sourceText.matchAll(/^( {0,3})(#{1,6})[ \t]+(.+?)\s*#*\s*$/gm)) {
      const headingText = match[3].trim();
      const startOffset = match.index ?? 0;
      const endOffset = startOffset + match[0].replace(/\s+$/, '').length;
      result.headings.push({ level: match[2].length, text: headingText, startOffset, endOffset });
      result.spans.push({ label: 'heading', text: headingText, startOffset, endOffset });
    }

    for (const match of sourceText.matchAll(/!?\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g)) {
      if (match[0].startsWith('!')) continue;
      const startOffset = match.index ?? 0;
      const endOffset = startOffset + match[0].length;
      result.links.push({ text: match[1], target: match[2], startOffset, endOffset });
      result.spans.push({ label: 'link', text: match[1], startOffset, endOffset, metadata: { target: match[2] } });
    }
    return result;
  }
}
