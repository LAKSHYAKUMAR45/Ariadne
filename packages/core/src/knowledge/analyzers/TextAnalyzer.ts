import path from 'node:path';
import type { DeterministicExtraction, ExtractedSection } from '../KnowledgeExtraction.js';
import type { AnalyzerInput, AnalyzerSelectionInput, DeterministicAnalyzer } from './AnalyzerRegistry.js';
import {
  buildSummaryFromSections,
  parseSourceLines,
  spanFromOffsets,
  splitLineRange,
} from './SourceText.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);
const TEXT_EXTENSIONS = new Set(['.txt', '.text', '.log', '.cfg', '.conf', '.ini', '.rst', '.adoc', '.csv', '.tsv']);

function isMarkdownPath(sourcePath: string | null | undefined): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(sourcePath ?? '').toLowerCase());
}

function buildSections(content: string): ExtractedSection[] {
  const lines = parseSourceLines(content);
  const sections: ExtractedSection[] = [];
  let paragraphIndex = 0;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    if (lines[lineIndex]!.text.trim().length === 0) {
      lineIndex += 1;
      continue;
    }

    const startIndex = lineIndex;
    while (lineIndex + 1 < lines.length && lines[lineIndex + 1]!.text.trim().length > 0) {
      lineIndex += 1;
    }
    const endIndex = lineIndex;
    for (const chunk of splitLineRange(content, lines, startIndex, endIndex)) {
      paragraphIndex += 1;
      sections.push({
        id: `section:paragraph:${paragraphIndex}`,
        kind: 'paragraph',
        text: content.slice(chunk.startOffset, chunk.endOffset),
        span: spanFromOffsets(content, chunk.startOffset, chunk.endOffset),
      });
    }
    lineIndex += 1;
  }

  return sections;
}

export class TextAnalyzer implements DeterministicAnalyzer {
  public readonly id = 'text';
  public readonly version = '1.0.0';

  public supports(input: AnalyzerSelectionInput): boolean {
    if (isMarkdownPath(input.sourcePath) || input.mimeType?.toLowerCase().includes('markdown')) {
      return false;
    }
    const mimeType = input.mimeType?.split(';', 1)[0].trim().toLowerCase();
    if (mimeType?.startsWith('text/')) {
      return true;
    }
    return TEXT_EXTENSIONS.has(path.extname(input.sourcePath ?? '').toLowerCase());
  }

  public async analyze(input: AnalyzerInput): Promise<DeterministicExtraction> {
    const content = input.content;
    const sections = buildSections(content);
    return {
      analyzerId: this.id,
      analyzerVersion: this.version,
      sourceVersionId: input.sourceVersionId,
      title: path.basename(input.sourcePath ?? input.sourceVersionId),
      summary: buildSummaryFromSections(sections),
      sections,
      symbols: [],
      relationships: [],
      links: [],
      diagnostics: [],
    };
  }
}
