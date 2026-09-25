import path from 'node:path';
import { offsetToPosition } from '../KnowledgeExtraction.js';
import type { DeterministicExtraction, ExtractedSection, KnowledgeSourceSpan } from '../KnowledgeExtraction.js';
import type { AnalyzerInput, AnalyzerSelectionInput, DeterministicAnalyzer } from './AnalyzerRegistry.js';

const MAX_SECTION_CHARACTERS = 2000;
const MAX_SECTION_LINES = 80;
const SUMMARY_LIMIT = 280;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);
const TEXT_EXTENSIONS = new Set(['.txt', '.text', '.log', '.cfg', '.conf', '.ini', '.rst', '.adoc', '.csv', '.tsv']);

interface ParsedLine {
  text: string;
  startOffset: number;
}

interface ParagraphChunk {
  text: string;
  startOffset: number;
  endOffset: number;
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function parseLines(content: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let lineStart = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index === content.length || content[index] === '\n') {
      lines.push({
        text: content.slice(lineStart, index),
        startOffset: lineStart,
      });
      lineStart = index + 1;
    }
  }
  if (content.length === 0) {
    return [{ text: '', startOffset: 0 }];
  }
  return lines;
}

function spanFromOffsets(content: string, startOffset: number, endOffset: number): KnowledgeSourceSpan {
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

function sectionSummary(text: string): string {
  return text.slice(0, SUMMARY_LIMIT);
}

function isMarkdownPath(sourcePath: string | null | undefined): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(sourcePath ?? '').toLowerCase());
}

function parseParagraphChunks(lines: ParsedLine[], startIndex: number, endIndex: number): ParagraphChunk[] {
  const chunks: ParagraphChunk[] = [];
  let currentParts: string[] = [];
  let currentStartOffset: number | null = null;
  let currentEndOffset: number | null = null;
  let currentLineCount = 0;

  const flushCurrent = (): void => {
    if (currentStartOffset === null || currentEndOffset === null || currentParts.length === 0) {
      return;
    }
    chunks.push({
      text: currentParts.join('\n'),
      startOffset: currentStartOffset,
      endOffset: currentEndOffset,
    });
    currentParts = [];
    currentStartOffset = null;
    currentEndOffset = null;
    currentLineCount = 0;
  };

  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = lines[index]!;
    if (line.text.length > MAX_SECTION_CHARACTERS) {
      flushCurrent();
      for (let offset = 0; offset < line.text.length; offset += MAX_SECTION_CHARACTERS) {
        const slice = line.text.slice(offset, offset + MAX_SECTION_CHARACTERS);
        chunks.push({
          text: slice,
          startOffset: line.startOffset + offset,
          endOffset: line.startOffset + offset + slice.length,
        });
      }
      continue;
    }

    const candidateText = currentParts.length === 0 ? line.text : `${currentParts.join('\n')}\n${line.text}`;
    if (currentParts.length > 0 && (currentLineCount >= MAX_SECTION_LINES || candidateText.length > MAX_SECTION_CHARACTERS)) {
      flushCurrent();
    }

    if (currentStartOffset === null) {
      currentStartOffset = line.startOffset;
    }
    currentParts.push(line.text);
    currentEndOffset = line.startOffset + line.text.length;
    currentLineCount += 1;

    if (currentLineCount >= MAX_SECTION_LINES || currentParts.join('\n').length >= MAX_SECTION_CHARACTERS) {
      flushCurrent();
    }
  }

  flushCurrent();
  return chunks;
}

function buildSections(content: string): ExtractedSection[] {
  const lines = parseLines(content);
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
    for (const chunk of parseParagraphChunks(lines, startIndex, endIndex)) {
      paragraphIndex += 1;
      sections.push({
        id: `section:paragraph:${paragraphIndex}`,
        kind: 'paragraph',
        text: chunk.text,
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
    const content = normalizeContent(input.content);
    const sections = buildSections(content);
    const firstSection = sections.find((section) => section.text.trim().length > 0);
    return {
      analyzerId: this.id,
      analyzerVersion: this.version,
      sourceVersionId: input.sourceVersionId,
      title: path.basename(input.sourcePath ?? input.sourceVersionId),
      summary: sectionSummary(firstSection?.text.trim() ?? ''),
      sections,
      symbols: [],
      relationships: [],
      links: [],
      diagnostics: [],
    };
  }
}
